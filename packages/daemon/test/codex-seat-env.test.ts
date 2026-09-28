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

describe("withMsysParents brackets the MSYS snapshot (pid reuse)", () => {
  it("re-parents only when child and parent kept pid + start time across both Windows snapshots", async () => {
    const { withMsysParents } = await import("../src/domain/msys-parents.js");
    const ps = [
      "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND",
      "      10       1      10        200  cons0     1 22:00:00 /usr/bin/bash",
      "      11      10      11        300  cons0     1 22:00:01 /c/npm/claude",
      "      12      10      12        400  cons0     1 22:00:02 /c/npm/other",
    ].join("\n");
    const snaps = [
      [{ pid: 200, ppid: 100, s: "a" }, { pid: 300, ppid: 999, s: "b" }, { pid: 400, ppid: 999, s: "c" }],
      [{ pid: 200, ppid: 100, s: "a" }, { pid: 300, ppid: 999, s: "b" }, { pid: 400, ppid: 5, s: "REUSED" }],
    ];
    let n = 0;
    const out = await withMsysParents(async () => snaps[n++]!, (r) => r.s, async () => ps);
    expect(out.find((r) => r.pid === 300)?.ppid).toBe(200); // stable -> re-parented
    expect(out.find((r) => r.pid === 400)?.ppid).toBe(5); // pid reused between snapshots -> untouched
  });
});
