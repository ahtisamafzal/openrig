import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CODEX_SEAT_ENV_VARS, codexSeatEnvArg } from "../src/adapters/yolo-mode.js";

describe("codexSeatEnvArg (seat identity survives shell_environment_policy)", () => {
  const on = { OPENRIG_CODEX_SEAT_ENV: "1" } as NodeJS.ProcessEnv;

  it("is off (byte-identical launch) unless OPENRIG_CODEX_SEAT_ENV=1", () => {
    expect(codexSeatEnvArg({})).toBe("");
  });

  it("re-injects every seat var through the policy's set table", () => {
    const arg = codexSeatEnvArg(on);
    for (const v of CODEX_SEAT_ENV_VARS) expect(arg).toContain(`-c "shell_environment_policy.set.${v}=\\"$${v}\\""`);
  });

  it.skipIf(process.platform === "win32" && !process.env.SHELL && !process.env.MSYSTEM)(
    "expands to TOML string overrides in the seat shell",
    () => {
      const out = execFileSync("bash", ["-c", `printf '%s\\n' ${codexSeatEnvArg(on)}`], {
        env: { ...process.env, OPENRIG_SESSION_NAME: "dev-qa@r", OPENRIG_NODE_ID: "n1" },
        encoding: "utf8",
      });
      expect(out).toContain('shell_environment_policy.set.OPENRIG_SESSION_NAME="dev-qa@r"');
      expect(out).toContain('shell_environment_policy.set.OPENRIG_NODE_ID="n1"');
    },
  );
});

describe("Codex resumed-TUI probe", () => {
  it("recognises the current Codex footer (upper-case model id) as an interactive conversation", async () => {
    const { assessNativeResumeProbe } = await import("../src/domain/native-resume-probe.js");
    const screen = [
      "• node_id",
      "  team-review@arete-trio",
      "› Ask Codex to do anything",
      "",
      "  GPT-5.6-Sol default fast · F:\Projects\arete-rig-sandbox · Restore seat handover context",
      "  ? for shortcuts                                    ⚠ 4 warnings · f2 to view",
    ].join("\n");
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node", paneContent: screen })).toMatchObject({ status: "resumed" });
  });
});

describe("Codex probe: stale footer in scrollback", () => {
  it("a footer-only screen with a bare shell in the pane is NOT resumed", async () => {
    const { assessNativeResumeProbe } = await import("../src/domain/native-resume-probe.js");
    const screen = [
      "› Ask Codex to do anything",
      "  GPT-5.6-Sol default fast · F:/Projects/arete-rig-sandbox",
      "ahti_@host MINGW64 /f/Projects/arete-rig-sandbox",
      "$",
    ].join("\n");
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "bash", paneContent: screen }).status).not.toBe("resumed");
  });
});

describe("withMsysParents trusts a link only when ps STIME still matches (pid reuse)", () => {
  it("re-parents a matching child/parent; leaves a pid whose start time changed", async () => {
    const { withMsysParents } = await import("../src/domain/msys-parents.js");
    const today = new Date();
    const at = (h: number, m: number, s: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m, s);
    const ps = [
      "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
      "      10       1      10        200  cons0     1 00:00:01 /usr/bin/bash",
      "      11      10      11        300  cons0     1 00:00:02 /c/npm/claude",
      "      12      10      12        400  cons0     1 00:00:03 /c/npm/other",
    ].join("\n");
    const rows = [
      { pid: 200, ppid: 100, t: at(0, 0, 1) },
      { pid: 300, ppid: 999, t: at(0, 0, 2) },
      { pid: 400, ppid: 999, t: new Date(Date.now() + 3_600_000) }, // pid 400 reused after ps ran
    ];
    const out = await withMsysParents(async () => rows, (r) => r.t, async () => ps);
    expect(out.find((r) => r.pid === 300)?.ppid).toBe(200);
    expect(out.find((r) => r.pid === 400)?.ppid).toBe(999);
  });

  it("stimeMatches: STIME <= started <= ps time; 'Mon D' for older processes", async () => {
    const { stimeMatches } = await import("../src/domain/msys-parents.js");
    const now = new Date(2026, 8, 29, 12, 0, 0);
    expect(stimeMatches("11:59:58", new Date(2026, 8, 29, 11, 59, 58), now)).toBe(true);
    // exec'd native program (claude.exe under the sh shim) starts a moment after the MSYS STIME
    expect(stimeMatches("11:59:58", new Date(2026, 8, 29, 11, 59, 59), now)).toBe(true);
    expect(stimeMatches("11:59:58", new Date(2026, 8, 29, 11, 59, 57), now)).toBe(false); // before STIME
    expect(stimeMatches("11:59:58", new Date(2026, 8, 29, 12, 0, 5), now)).toBe(false); // after ps ran: reused
    expect(stimeMatches("Sep 27", new Date(2026, 8, 27, 8, 0, 0), now)).toBe(true);
    expect(stimeMatches("Sep 27", new Date(2026, 8, 29, 8, 0, 0), now)).toBe(false); // reused today
  });
});
