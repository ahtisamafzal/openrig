// Native-Windows seat host: runs OpenRig seats in herdr panes instead of tmux
// sessions. Subclasses TmuxAdapter so every consumer keeps its type; the base
// exec throws, so any method not mapped here fails loudly instead of silently
// shelling out to tmux.
//
// Model: one herdr pane per seat, labelled with the seat's session name
// (`pod-member@rig`), inside a workspace labelled `openrig:<rig>`. Targets are
// either that session name or a herdr pane id (`w2:p1`) from listPanes().
// Every CLI call names the herdr session explicitly (--session) and strips the
// inherited HERDR_* env, so a daemon started inside a herdr pane still hits
// the right server.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  TmuxAdapter,
  type SessionProbe,
  type TmuxClient,
  type TmuxCursorPosition,
  type TmuxPane,
  type TmuxResult,
  type TmuxSession,
  type TmuxWindow,
} from "./tmux.js";

const execFileAsync = promisify(execFile);

const WORKSPACE_PREFIX = "openrig:";
// herdr ids continue past 9 with letters: w9:p1, wA:p1, ...
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
const PASTE_SETTLE_MS = 600;
const SUBMIT_CHECK_MS = 2500;

export type HerdrExecFn = (args: string[]) => Promise<string>;

export interface HerdrSeatAdapterOptions {
  /** herdr session that hosts the seats (default: OPENRIG_HERDR_SESSION or "openrig"). */
  session?: string;
  /** POSIX shell started in each seat pane (default: OPENRIG_PANE_SHELL or Git Bash). */
  paneShell?: string;
  /** Injected for tests; receives herdr args after `--session <name>`. */
  exec?: HerdrExecFn;
  /** Injected for tests; opens a visible window attached to the session. */
  openWindow?: (session: string) => void;
}

interface HerdrPaneInfo {
  pane_id: string;
  workspace_id: string;
  label?: string;
  cwd?: string;
  focused?: boolean;
  revision?: number;
  scroll?: { viewport_rows?: number };
}

interface HerdrWorkspaceInfo {
  workspace_id: string;
  label?: string;
}

/** Oldest herdr whose CLI/API envelopes this adapter was verified against. */
const MIN_HERDR = [0, 9, 1];

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) - b[i]!;
  return 0;
}

class HerdrError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// Inherited session markers: HERDR_* (nested herdr is refused) and the
// calling agent's own session identity, which seats must not inherit.
const INHERITED_MARKERS = /^(HERDR_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PLUGIN_|CODEX_COMPANION_)/;

function strippedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (INHERITED_MARKERS.test(key)) delete env[key];
  }
  return env;
}

function defaultExec(session: string): HerdrExecFn {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("herdr", ["--session", session, ...args], {
        env: strippedEnv(),
        timeout: 20_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (err) {
      // herdr exits non-zero with a JSON error body (on stderr or stdout).
      const { stdout = "", stderr = "" } = err as { stdout?: string; stderr?: string };
      const body = [stdout, stderr].find((s) => s.trimStart().startsWith("{"));
      if (body) return body;
      throw err;
    }
  };
}

function defaultOpenWindow(session: string): void {
  // A detached console process gets its own visible window. Without the
  // stripped env, herdr refuses to start ("nested herdr is disabled").
  const child = spawn("herdr", ["session", "attach", session], {
    detached: true,
    stdio: "ignore",
    env: strippedEnv(),
  });
  child.unref();
}

/** tmux key names → herdr key names. Unmapped single characters are sent as text. */
export function toHerdrKey(key: string): { key: string } | { text: string } | null {
  if (key === "") return null;
  const named: Record<string, string> = {
    "C-m": "enter", Enter: "enter", KPEnter: "enter",
    Escape: "esc", "C-[": "esc",
    Tab: "tab", BTab: "shift+tab", BSpace: "backspace", Space: "space",
    Up: "up", Down: "down", Left: "left", Right: "right",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", PPage: "pageup", NPage: "pagedown",
    DC: "delete", Delete: "delete",
  };
  if (named[key]) return { key: named[key] };
  const ctrl = /^C-(.)$/.exec(key);
  if (ctrl?.[1]) return { key: `ctrl+${ctrl[1].toLowerCase()}` };
  const meta = /^M-(.)$/.exec(key);
  if (meta?.[1]) return { key: `alt+${meta[1].toLowerCase()}` };
  return { text: key };
}

/**
 * Harness launches arrive as `env PATH='<daemon PATH>' <cmd>`. On Windows that
 * PATH is `C:\a;D:\b`, which Git Bash cannot search; rewrite it to `/c/a:/d/b`.
 */
export function toPosixPathPrefix(command: string): string {
  return command.replace(/^env PATH='([^']*;[^']*)' /, (_m, winPath: string) => {
    const posix = winPath
      .split(";")
      .filter(Boolean)
      .map((p) => p.replace(/^([A-Za-z]):[\\/]?/, (_d, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/"))
      .join(":");
    return `env PATH='${posix}' `;
  });
}

export class HerdrSeatAdapter extends TmuxAdapter {
  private readonly session: string;
  private readonly paneShell: string;
  private readonly herdr: HerdrExecFn;
  private readonly openWindow: (session: string) => void;
  // ponytail: in-memory only — session/server options and creation env are lost
  // on daemon restart. Persist them (or use herdr report-metadata) if adoption
  // after restart needs them.
  private readonly sessionOptions = new Map<string, Map<string, string>>();
  private readonly serverOptions = new Map<string, string>();
  private readonly sessionEnvKeys = new Map<string, Set<string>>();
  private readonly activity = new Map<string, { revision: number; at: number }>();
  private readonly lastPasteAt = new Map<string, number>();
  private preflightResult: Promise<TmuxResult> | null = null;

  constructor(opts: HerdrSeatAdapterOptions = {}) {
    super(async (cmd) => {
      throw new Error(`HerdrSeatAdapter: unmapped tmux call: ${cmd}`);
    });
    this.session = opts.session ?? process.env.OPENRIG_HERDR_SESSION ?? "openrig";
    this.paneShell = opts.paneShell ?? process.env.OPENRIG_PANE_SHELL ?? "C:\\Program Files\\Git\\bin\\bash.exe";
    this.herdr = opts.exec ?? defaultExec(this.session);
    this.openWindow = opts.openWindow ?? defaultOpenWindow;
  }

  // ---- herdr plumbing -------------------------------------------------------

  /** Once per adapter, before the first seat: herdr must speak the CLI/API envelopes
   *  this adapter was built against (>= MIN_HERDR). A missing claude/codex/pi
   *  integration only warns — seats still run, but herdr cannot report that
   *  runtime's state or resume it natively. */
  private async preflight(): Promise<TmuxResult> {
    let version: string;
    try {
      version = (await this.herdr(["--version"])).trim();
    } catch (err) {
      return { ok: false, code: "tmux_unavailable", message: `herdr not runnable (${(err as Error).message}); install herdr >= ${MIN_HERDR.join(".")}` };
    }
    const found = /(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
    if (!found || compareVersions(found, MIN_HERDR) < 0) {
      return { ok: false, code: "tmux_unavailable", message: `herdr ${found?.join(".") ?? `"${version}"`} is older than ${MIN_HERDR.join(".")}; run: herdr update` };
    }
    try {
      const status = await this.herdr(["integration", "status"]);
      for (const agent of ["claude", "codex", "pi"]) {
        const line = status.split(/\r?\n/).find((l) => l.startsWith(`${agent}:`)) ?? "";
        if (!line.includes("current")) {
          console.warn(`[herdr] ${agent} integration not current (${line.trim() || "missing"}); state/resume degrade. Run: herdr integration install ${agent}`);
        }
      }
    } catch { /* status is advisory */ }
    return { ok: true };
  }

  private async call<T = unknown>(args: string[]): Promise<T> {
    const out = await this.herdr(args);
    const parsed = JSON.parse(out) as { result?: T; error?: { code: string; message: string } };
    if (parsed.error) throw new HerdrError(parsed.error.code, parsed.error.message);
    return parsed.result as T;
  }

  private async text(args: string[]): Promise<string> {
    const out = await this.herdr(args);
    if (out.trimStart().startsWith("{")) {
      try {
        const parsed = JSON.parse(out) as { error?: { code: string; message: string } };
        if (parsed.error) throw new HerdrError(parsed.error.code, parsed.error.message);
      } catch (err) {
        if (err instanceof HerdrError) throw err; // pane text that merely starts with "{" is fine
      }
    }
    return out;
  }

  private async workspaces(): Promise<HerdrWorkspaceInfo[]> {
    const r = await this.call<{ workspaces: HerdrWorkspaceInfo[] }>(["workspace", "list"]);
    return r.workspaces ?? [];
  }

  private async panes(workspaceId?: string): Promise<HerdrPaneInfo[]> {
    const args = workspaceId ? ["pane", "list", "--workspace", workspaceId] : ["pane", "list"];
    const r = await this.call<{ panes: HerdrPaneInfo[] }>(args);
    return r.panes ?? [];
  }

  /** OpenRig-owned seat panes (inside `openrig:*` workspaces). */
  private async seatPanes(): Promise<HerdrPaneInfo[]> {
    const owned = new Set(
      (await this.workspaces()).filter((w) => w.label?.startsWith(WORKSPACE_PREFIX)).map((w) => w.workspace_id),
    );
    return (await this.panes()).filter((p) => owned.has(p.workspace_id));
  }

  /** Resolve a session name or pane id to a pane, or null when absent. */
  private async resolve(target: string): Promise<HerdrPaneInfo | null> {
    if (PANE_ID.test(target)) {
      try {
        return (await this.call<{ pane: HerdrPaneInfo }>(["pane", "get", target])).pane;
      } catch (err) {
        if (err instanceof HerdrError && err.code === "pane_not_found") return null;
        throw err;
      }
    }
    const name = target.replace(/:\d+(\.\d+)?$/, ""); // tolerate tmux `session:window.pane`
    return (await this.seatPanes()).find((p) => p.label === name) ?? null;
  }

  private async paneId(target: string): Promise<string> {
    const pane = await this.resolve(target);
    if (!pane) throw new HerdrError("pane_not_found", `no herdr seat for ${target}`);
    return pane.pane_id;
  }

  private fail(err: unknown): TmuxResult {
    if (err instanceof HerdrError) {
      const code = err.code === "pane_not_found" ? "session_not_found" : err.code;
      return { ok: false, code, message: err.message };
    }
    return { ok: false, code: "unknown", message: (err as Error).message };
  }

  // ---- server / sessions ----------------------------------------------------

  override async startServer(): Promise<TmuxResult> {
    const pre = await (this.preflightResult ??= this.preflight());
    if (!pre.ok) return pre;
    try {
      await this.workspaces();
      return { ok: true };
    } catch (err) {
      if (!(err instanceof HerdrError && err.code === "server_not_running")) return this.fail(err);
    }
    this.openWindow(this.session);
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await this.workspaces();
        return { ok: true };
      } catch { /* still starting */ }
    }
    return { ok: false, code: "tmux_unavailable", message: `herdr session ${this.session} did not start` };
  }

  override async probeSession(name: string): Promise<SessionProbe> {
    try {
      return (await this.resolve(name)) ? { state: "present" } : { state: "absent" };
    } catch (err) {
      return { state: "transport_unavailable", cause: (err as Error).message };
    }
  }

  override async listSessions(): Promise<TmuxSession[]> {
    try {
      return (await this.seatPanes())
        .filter((p) => p.label)
        .map((p) => ({ name: p.label!, windows: 1, created: "", attached: Boolean(p.focused) }));
    } catch {
      return [];
    }
  }

  override async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    const pane = await this.resolve(sessionName).catch(() => null);
    return pane ? [{ index: 0, name: sessionName, panes: 1, active: true }] : [];
  }

  override async listPanes(target: string): Promise<TmuxPane[]> {
    const pane = await this.resolve(target).catch(() => null);
    if (!pane) return [];
    return [{
      id: pane.pane_id,
      index: 0,
      cwd: pane.cwd ?? "",
      width: 0, // herdr does not report columns
      height: pane.scroll?.viewport_rows ?? 0,
      active: Boolean(pane.focused),
    }];
  }

  override async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    // tmux auto-starts its server on new-session; herdr needs its window opened.
    const up = await this.startServer();
    if (!up.ok) return up;
    try {
      if (await this.resolve(name)) return { ok: false, code: "duplicate_session", message: `duplicate session: ${name}` };
      const rig = name.includes("@") ? name.slice(name.lastIndexOf("@") + 1) : "openrig";
      const wsLabel = `${WORKSPACE_PREFIX}${rig}`;
      const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
      const cwdArgs = cwd ? ["--cwd", cwd] : [];
      const ws = (await this.workspaces()).find((w) => w.label === wsLabel);
      let paneId: string;
      const anchor = ws ? (await this.panes(ws.workspace_id)).at(-1) : undefined;
      if (!ws || !anchor) {
        const r = await this.call<{ root_pane: { pane_id: string } }>(
          ["workspace", "create", "--label", wsLabel, "--no-focus", ...cwdArgs, ...envArgs],
        );
        paneId = r.root_pane.pane_id;
      } else {
        const count = (await this.panes(ws.workspace_id)).length;
        const direction = count % 2 === 1 ? "right" : "down";
        const r = await this.call<{ pane: { pane_id: string } }>(
          ["pane", "split", anchor.pane_id, "--direction", direction, ...cwdArgs, ...envArgs],
        );
        paneId = r.pane.pane_id;
      }
      await this.call(["pane", "rename", paneId, name]);
      // herdr panes start in PowerShell; seats expect a POSIX shell.
      await this.text(["pane", "run", paneId, `& "${this.paneShell}"`]);
      await this.text(["pane", "wait-output", paneId, "--regex", "\\$\\s*$", "--timeout", "15000"]);
      this.sessionEnvKeys.set(name, new Set(Object.keys(env ?? {})));
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }

  override async killSession(name: string): Promise<TmuxResult> {
    try {
      await this.call(["pane", "close", await this.paneId(name)]);
      this.sessionOptions.delete(name);
      this.sessionEnvKeys.delete(name);
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }

  // ---- input ----------------------------------------------------------------

  override async sendText(target: string, text: string): Promise<TmuxResult> {
    try {
      const id = await this.paneId(target);
      // herdr types a newline as Enter. Bracketed paste (what tmux `-p` does)
      // keeps multi-line text in the input until the caller's explicit submit.
      const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
      this.lastPasteAt.set(id, Date.now());
      // Windows caps a command line near 32K chars; send long text in slices.
      for (let i = 0; i < payload.length; i += 8000) {
        await this.text(["pane", "send-text", id, payload.slice(i, i + 8000)]);
      }
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }

  /**
   * Type the command straight into the seat shell. The base class routes it
   * through `/bin/sh <script>` to dodge a macOS canonical-input limit; under
   * Git Bash that extra MSYS hop hides the harness from the Windows process
   * tree, which getPaneCommand/getPanePid lineage depend on.
   */
  override async sendShellCommand(target: string, command: string): Promise<TmuxResult> {
    const text = await this.sendText(target, toPosixPathPrefix(command));
    if (!text.ok) return text;
    const enter = await this.sendKeys(target, ["Enter"]);
    if (!enter.ok) await this.sendKeys(target, ["C-c"]);
    return enter;
  }

  override async sendKeys(target: string, keys: string[]): Promise<TmuxResult> {
    try {
      const id = await this.paneId(target);
      for (const k of keys) {
        const mapped = toHerdrKey(k);
        if (!mapped) continue;
        // Agent TUIs (Codex) treat an Enter that lands mid-paste as part of the
        // paste; let the paste settle first, as the tmux send path does.
        if ("key" in mapped && mapped.key === "enter") {
          const wait = PASTE_SETTLE_MS - (Date.now() - (this.lastPasteAt.get(id) ?? 0));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
        if ("key" in mapped) await this.text(["pane", "send-keys", id, mapped.key]);
        else await this.text(["pane", "send-text", id, mapped.text]);
        if ("key" in mapped && mapped.key === "enter" && this.lastPasteAt.delete(id)) await this.confirmSubmitted(id);
      }
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }

  /**
   * Codex drops an Enter that arrives while it is still busy (startup hooks),
   * leaving its paste placeholder in the input. Re-send Enter once if so.
   */
  private async confirmSubmitted(id: string): Promise<void> {
    await new Promise((r) => setTimeout(r, SUBMIT_CHECK_MS));
    const screen = await this.text(["pane", "read", id, "--source", "visible"]).catch(() => "");
    if (/^\s*›\s*\[Pasted Content \d+ chars\]\s*$/m.test(screen)) {
      await this.text(["pane", "send-keys", id, "enter"]);
    }
  }

  // ---- output / state -------------------------------------------------------

  override async capturePaneContent(paneId: string, lines: number = 20): Promise<string | null> {
    try {
      return (await this.text(["pane", "read", await this.paneId(paneId), "--source", "recent", "--lines", String(lines)])) || null;
    } catch {
      return null;
    }
  }

  override async capturePaneScreen(paneId: string): Promise<string | null> {
    try {
      return (await this.text(["pane", "read", await this.paneId(paneId), "--source", "visible"])) || null;
    } catch {
      return null;
    }
  }

  /** herdr has no activity clock; a changed pane revision means output since the last look. */
  override async readPaneLastActivity(paneId: string): Promise<number | null> {
    try {
      const pane = await this.resolve(paneId);
      if (!pane || pane.revision == null) return null;
      const now = Math.floor(Date.now() / 1000);
      const seen = this.activity.get(pane.pane_id);
      if (!seen || seen.revision !== pane.revision) {
        this.activity.set(pane.pane_id, { revision: pane.revision, at: now });
        return now;
      }
      return seen.at;
    } catch {
      return null;
    }
  }

  private async processInfo(target: string): Promise<{ shell_pid?: number; foreground_processes?: { name?: string; pid?: number }[] } | null> {
    try {
      const r = await this.call<{ process_info: { shell_pid?: number; foreground_processes?: { name?: string; pid?: number }[] } }>(
        ["pane", "process-info", "--pane", await this.paneId(target)],
      );
      return r.process_info;
    } catch {
      return null;
    }
  }

  override async getPanePid(paneId: string): Promise<number | null> {
    return (await this.processInfo(paneId))?.shell_pid ?? null;
  }

  /**
   * herdr on Windows only sees the pane's root process (PowerShell). Walk the
   * Windows process tree from it and report the deepest descendant, which is
   * `bash` at the seat prompt and the harness (`claude`, `node`, ...) when one runs.
   */
  override async getPaneCommand(paneId: string): Promise<string | null> {
    const root = await this.getPanePid(paneId);
    if (root == null) return null;
    try {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.Name)\" }",
      ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const children = new Map<number, { pid: number; name: string }[]>();
      for (const line of stdout.split(/\r?\n/)) {
        const [pid, ppid, name] = line.split(",");
        if (!pid || !ppid || !name) continue;
        const list = children.get(Number(ppid)) ?? [];
        list.push({ pid: Number(pid), name });
        children.set(Number(ppid), list);
      }
      const ignore = /^(conhost|OpenConsole)\.exe$/i;
      let current = { pid: root, name: "" };
      for (let depth = 0; depth < 10; depth++) {
        const next = (children.get(current.pid) ?? []).filter((c) => !ignore.test(c.name)).at(-1);
        if (!next) break;
        current = next;
      }
      const name = current.name || (await this.processInfo(paneId))?.foreground_processes?.[0]?.name;
      return name ? name.replace(/\.exe$/i, "") : null;
    } catch {
      return null;
    }
  }

  override async isPaneDead(paneId: string): Promise<boolean> {
    return (await this.resolve(paneId).catch(() => "unknown")) === null;
  }

  override async signalPaneProcess(paneId: string, signal: "TERM" | "KILL"): Promise<TmuxResult> {
    const pid = await this.getPanePid(paneId);
    if (pid == null) return { ok: false, code: "session_not_found", message: `no pid for ${paneId}` };
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", ...(signal === "KILL" ? ["/F"] : [])], { windowsHide: true });
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }

  override async getDefaultShell(): Promise<string | null> {
    return this.paneShell;
  }

  override async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    return this.sessionEnvKeys.get(sessionName)?.has(varName) ?? null;
  }

  override async getPaneCursorPosition(): Promise<TmuxCursorPosition | null> {
    return null; // herdr does not expose the cursor
  }

  // ---- options (kept in memory; see ponytail note above) ----------------------

  override async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    if (!(await this.resolve(sessionName).catch(() => null))) {
      return { ok: false, code: "session_not_found", message: `no herdr seat for ${sessionName}` };
    }
    const opts = this.sessionOptions.get(sessionName) ?? new Map<string, string>();
    opts.set(key, value);
    this.sessionOptions.set(sessionName, opts);
    return { ok: true };
  }

  override async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    return this.sessionOptions.get(sessionName)?.get(key) ?? null;
  }

  override async setServerOption(option: string, value: string): Promise<TmuxResult> {
    this.serverOptions.set(option, value);
    return { ok: true };
  }

  override async showServerOption(option: string): Promise<string | null> {
    return this.serverOptions.get(option) ?? null;
  }

  override async setWindowOption(): Promise<TmuxResult> {
    return { ok: true }; // tmux window cosmetics; herdr owns its own layout
  }

  override async resizeWindow(): Promise<TmuxResult> {
    return { ok: true }; // herdr sizes panes to its window
  }

  // ---- not available on herdr -----------------------------------------------

  // ponytail: no transcript capture yet; poll `pane read` into the transcript file if `rig transcript` is needed.
  override async startPipePane(): Promise<TmuxResult> {
    return { ok: true };
  }

  override async stopPipePane(): Promise<TmuxResult> {
    return { ok: true };
  }

  override async respawnPane(): Promise<TmuxResult> {
    return { ok: false, code: "unsupported", message: "respawn-pane is not available on herdr seats" };
  }

  override async setRemainOnExit(): Promise<TmuxResult> {
    return { ok: false, code: "unsupported", message: "remain-on-exit is not available on herdr seats" };
  }

  override async listClients(): Promise<TmuxClient[]> {
    return [];
  }

  override async switchClient(): Promise<TmuxResult> {
    return { ok: false, code: "unsupported", message: "switch-client is not available on herdr seats" };
  }
}
