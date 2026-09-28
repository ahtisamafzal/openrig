import { describe, it, expect } from "vitest";
import { findExactNativeResumeProcess, verifyCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

// Windows rows come from the CIM census: executableName is the OS image name, and
// there are no process groups (pgid/tpgid undefined).
const token = "019a0000-0000-7000-8000-000000000001";
const at = "Mon Sep 28 19:00:00 2026";
const NODE = String.raw`"C:\Program Files\nodejs\node.exe"`;
const CODEX_JS = String.raw`C:\Users\a\AppData\Roaming\npm/node_modules/@openai/codex/bin/codex.js`;
const CODEX_EXE = String.raw`"C:\Users\a\AppData\Roaming\npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe"`;

function windowsRows(args = `--no-daemon -s workspace-write resume ${token}`): NativeProcessRow[] {
  return [
    { pid: 10, ppid: 1, executableName: "bash", command: String.raw`"C:\Program Files\Git\bin\bash.exe"`, startedAt: at },
    { pid: 11, ppid: 10, executableName: "node", command: `${NODE} ${CODEX_JS} ${args}`, startedAt: at },
    { pid: 12, ppid: 11, executableName: "codex", command: `${CODEX_EXE} ${args}`, startedAt: at },
    { pid: 99, ppid: 1, executableName: "codex", command: `${CODEX_EXE} ${args}`, startedAt: at }, // another pane's Codex
  ];
}
const check = (rows: () => NativeProcessRow[], expectedToken: string | null = token) =>
  verifyCodexPaneProcess({ target: "p", tmux: { getPanePid: async () => 10 }, listProcesses: rows, expectedToken, requireResume: true });

describe.runIf(process.platform === "win32")("Codex lineage proof on Windows (no process groups)", () => {
  it("proves the native codex.exe under the pane, not its node launcher", async () => {
    expect((await check(windowsRows))?.process.pid).toBe(12);
    expect(findExactNativeResumeProcess(windowsRows(), 10, "codex", token)?.pid).toBe(12);
  });

  it("refuses wrong identity, argv-only executables, and missing ancestry", async () => {
    expect(await check(windowsRows, "other-token")).toBeNull();
    expect(await check(() => windowsRows("--no-daemon"))).toBeNull();
    expect(await check(() => windowsRows().map((r) => (r.pid === 12 ? { ...r, executableName: "cmd" } : r)))).toBeNull();
    expect(await check(() => windowsRows().filter((r) => r.pid !== 11))).toBeNull();
    expect(await check(() => [...windowsRows(), { ...windowsRows()[2]!, pid: 13 }])).toBeNull();
  });
});
