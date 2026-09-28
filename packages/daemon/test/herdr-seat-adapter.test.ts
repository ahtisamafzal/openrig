import { describe, it, expect, vi } from "vitest";
import { HerdrSeatAdapter, toHerdrKey, toPosixPathPrefix } from "../src/adapters/herdr-seat-adapter.js";

const ok = (result: unknown) => JSON.stringify({ id: "cli", result });
const err = (code: string) => JSON.stringify({ id: "cli", error: { code, message: code } });

/** Fake herdr: one seat `dev-impl@r` (w2:p1) in workspace `openrig:r`, plus a foreign pane. */
function fakeHerdr(opts: { serverDown?: boolean; version?: string; integrations?: string } = {}) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    // Like real herdr, these answer without a running server.
    if (args[0] === "--version") return `herdr ${opts.version ?? "0.9.1"}\n`;
    if (args[0] === "integration") return opts.integrations ?? "pi: current (v9) (x)\nclaude: current (v10) (x)\ncodex: current (v8) (x)\n";
    if (opts.serverDown) return err("server_not_running");
    const [a, b] = args;
    if (a === "workspace" && b === "list") {
      return ok({ workspaces: [{ workspace_id: "w1", label: "Projects" }, { workspace_id: "w2", label: "openrig:r" }] });
    }
    if (a === "pane" && b === "list") {
      return ok({ panes: [
        { pane_id: "w1:p1", workspace_id: "w1", label: "dev-impl@r" }, // same label outside openrig:* — must be ignored
        { pane_id: "w2:p1", workspace_id: "w2", label: "dev-impl@r", revision: 1 },
      ] });
    }
    if (a === "pane" && b === "get") {
      if (args[2] === "w2:p1" || args[2] === "wA:p1") return ok({ pane: { pane_id: args[2], workspace_id: "w2" } });
      return err("pane_not_found");
    }
    return ok({ type: "ok" });
  };
  return { calls, exec };
}

describe("toHerdrKey", () => {
  it("maps tmux key names to herdr names and passes other text through", () => {
    expect(toHerdrKey("C-m")).toEqual({ key: "enter" });
    expect(toHerdrKey("Enter")).toEqual({ key: "enter" });
    expect(toHerdrKey("Escape")).toEqual({ key: "esc" });
    expect(toHerdrKey("C-c")).toEqual({ key: "ctrl+c" });
    expect(toHerdrKey("M-x")).toEqual({ key: "alt+x" });
    expect(toHerdrKey("3")).toEqual({ text: "3" });
    expect(toHerdrKey("")).toBeNull();
  });
});

describe("toPosixPathPrefix", () => {
  it("rewrites a Windows PATH prefix for Git Bash and leaves other commands alone", () => {
    expect(toPosixPathPrefix("env PATH='C:\\Program Files\\nodejs;C:\\Users\\a\\AppData\\Roaming\\npm' codex --no-daemon"))
      .toBe("env PATH='/c/Program Files/nodejs:/c/Users/a/AppData/Roaming/npm' codex --no-daemon");
    expect(toPosixPathPrefix("env PATH='/usr/bin:/bin' codex")).toBe("env PATH='/usr/bin:/bin' codex");
    expect(toPosixPathPrefix("claude --session-id x")).toBe("claude --session-id x");
  });
});

describe("HerdrSeatAdapter", () => {
  it("resolves seats only inside openrig:* workspaces", async () => {
    const h = fakeHerdr();
    const t = new HerdrSeatAdapter({ exec: h.exec });
    expect(await t.probeSession("dev-impl@r")).toEqual({ state: "present" });
    expect(await t.probeSession("dev-check@r")).toEqual({ state: "absent" });
    expect((await t.listPanes("dev-impl@r"))[0]?.id).toBe("w2:p1");
    expect((await t.listSessions()).map((s) => s.name)).toEqual(["dev-impl@r"]);
  });

  it("accepts herdr pane ids past w9 (letters)", async () => {
    const t = new HerdrSeatAdapter({ exec: fakeHerdr().exec });
    expect(await t.probeSession("wA:p1")).toEqual({ state: "present" });
  });

  it("reports an unreachable server as transport_unavailable, never absent", async () => {
    const t = new HerdrSeatAdapter({ exec: fakeHerdr({ serverDown: true }).exec });
    expect((await t.probeSession("dev-impl@r")).state).toBe("transport_unavailable");
  });

  it("opens a window and waits when the server is down at start", async () => {
    let opened = "";
    const h = fakeHerdr({ serverDown: true });
    const t = new HerdrSeatAdapter({ session: "s1", exec: h.exec, openWindow: (s) => { opened = s; } });
    const started = t.startServer();
    expect((await Promise.race([started, new Promise((r) => setTimeout(() => r("pending"), 50))]))).toBe("pending");
    expect(opened).toBe("s1");
  });

  it("wraps multi-line text in bracketed paste so a newline does not submit", async () => {
    const h = fakeHerdr();
    const t = new HerdrSeatAdapter({ exec: h.exec });
    expect(await t.sendText("dev-impl@r", "one\ntwo")).toEqual({ ok: true });
    expect(await t.sendText("dev-impl@r", "single")).toEqual({ ok: true });
    const sends = h.calls.filter((c) => c[1] === "send-text").map((c) => c[3]);
    expect(sends).toEqual(["\x1b[200~one\ntwo\x1b[201~", "single"]);
  });

  it("maps a missing seat to session_not_found", async () => {
    const t = new HerdrSeatAdapter({ exec: fakeHerdr().exec });
    expect(await t.sendKeys("nope@r", ["C-m"])).toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("fails loudly instead of running tmux for unmapped calls", async () => {
    const t = new HerdrSeatAdapter({ exec: fakeHerdr().exec });
    expect(await t.respawnPane("w2:p1")).toMatchObject({ ok: false, code: "unsupported" });
  });

  it("refuses to start seats on a herdr older than the verified envelopes", async () => {
    const t = new HerdrSeatAdapter({ exec: fakeHerdr({ version: "0.8.4" }).exec });
    expect(await t.startServer()).toMatchObject({ ok: false, message: expect.stringContaining("herdr update") });
    expect(await t.createSession("dev-new@r")).toMatchObject({ ok: false });
  });

  it("retries a failed preflight, so upgrading herdr needs no daemon restart", async () => {
    let version = "0.8.4";
    const fake = fakeHerdr();
    const exec = async (args: string[]) => (args[0] === "--version" ? `herdr ${version}` : fake.exec(args));
    const t = new HerdrSeatAdapter({ exec });
    expect((await t.startServer()).ok).toBe(false);
    version = "0.9.1";
    expect(await t.startServer()).toEqual({ ok: true });
  });

  it("warns (but starts) when an agent integration is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new HerdrSeatAdapter({ exec: fakeHerdr({ integrations: "claude: current (v10) (x)\ncodex: not installed (x)\n" }).exec });
    expect(await t.startServer()).toEqual({ ok: true });
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/codex integration[\s\S]*herdr integration install codex[\s\S]*pi integration/);
    warn.mockRestore();
  });
});

describe("pendingPaste (Codex composer still holds a paste)", () => {
  it("finds the placeholder in the composer, even after typed text", async () => {
    const { pendingPaste } = await import("../src/adapters/herdr-seat-adapter.js");
    expect(pendingPaste("history\n\n› [Pasted Content 1101 chars]\n\n  GPT-5.6 default · F:/x")).toBe(true);
    expect(pendingPaste("# Role: QA\n  Run `rig whoami --json`, then resolve [Pasted Content 1101 chars]From: x\n  GPT-5.6")).toBe(true);
    expect(pendingPaste("› Ask Codex to do anything\n\n  GPT-5.6 default")).toBe(false);
    expect(pendingPaste(`[Pasted Content 5 chars]\n${"line\n".repeat(20)}`)).toBe(false);
  });
});
