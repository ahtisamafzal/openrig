import { execFile } from "node:child_process";
import nodePath from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git Bash (MSYS) emulates fork+exec: the forked stub exits, so Windows records a DEAD
 * parent for everything a seat shell launches (bash -> [stub] -> sh claude-shim ->
 * claude.exe). Every lineage walk from a pane down to its harness breaks at that stub.
 * MSYS ps keeps the real link; these helpers read it and re-parent the Windows rows.
 */

/** MSYS ps next to the seat shell: <git>\bin\bash.exe -> <git>\usr\bin\ps.exe. */
export function msysPsPath(paneShell = process.env.OPENRIG_PANE_SHELL ?? "C:\\Program Files\\Git\\bin\\bash.exe"): string {
  return nodePath.win32.join(nodePath.win32.dirname(nodePath.win32.dirname(paneShell)), "usr", "bin", "ps.exe");
}

/**
 * Windows pid -> Windows pid of its MSYS parent. Columns: PID PPID PGID WINPID TTY UID
 * STIME COMMAND, with an optional leading status letter.
 */
export function parseMsysParents(psOutput: string): Map<number, number> {
  const rows = psOutput.split(/\r?\n/).flatMap((line) => {
    const cols = line.trim().split(/\s+/);
    if (cols[0] && !/^\d+$/.test(cols[0])) cols.shift();
    const [pid, ppid, , winpid] = cols.map(Number);
    return pid && winpid && Number.isFinite(ppid) ? [{ pid, ppid: ppid!, winpid }] : [];
  });
  const winOf = new Map(rows.map((r) => [r.pid, r.winpid]));
  const parents = new Map<number, number>();
  for (const r of rows) {
    const parentWin = winOf.get(r.ppid);
    if (parentWin && parentWin !== r.winpid) parents.set(r.winpid, parentWin);
  }
  return parents;
}

/** Re-parent rows whose MSYS parent is known. No Git Bash (or ps fails) = rows unchanged. */
export async function withMsysParents<T extends { pid: number; ppid: number }>(rows: T[], psPath = msysPsPath()): Promise<T[]> {
  let parents: Map<number, number>;
  try {
    parents = parseMsysParents((await execFileAsync(psPath, ["-e"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout);
  } catch {
    return rows;
  }
  return rows.map((r) => (parents.has(r.pid) ? { ...r, ppid: parents.get(r.pid)! } : r));
}
