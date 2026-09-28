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

export interface MsysProc { winpid: number; parentWinpid: number | null; stime: string }

/**
 * MSYS processes by Windows pid, with the MSYS parent's Windows pid and the STIME column
 * ("HH:MM:SS" when started today, else "Mon D"). Columns: PID PPID PGID WINPID TTY UID
 * STIME COMMAND, with an optional leading status letter.
 */
export function parseMsysPs(psOutput: string): Map<number, MsysProc> {
  const rows = psOutput.split(/\r?\n/).flatMap((line) => {
    const cols = line.trim().split(/\s+/);
    if (cols[0] && !/^\d+$/.test(cols[0])) cols.shift();
    const [pid, ppid, , winpid] = cols.slice(0, 4).map(Number);
    if (!pid || !winpid || !Number.isFinite(ppid)) return [];
    const stime = /^\d\d:\d\d:\d\d$/.test(cols[6] ?? "") ? cols[6]! : `${cols[6] ?? ""} ${cols[7] ?? ""}`.trim();
    return [{ pid, ppid: ppid!, winpid, stime }];
  });
  const winOf = new Map(rows.map((r) => [r.pid, r.winpid]));
  return new Map(rows.map((r) => {
    const parentWin = winOf.get(r.ppid);
    return [r.winpid, { winpid: r.winpid, parentWinpid: parentWin && parentWin !== r.winpid ? parentWin : null, stime: r.stime }];
  }));
}

/** Windows pid -> Windows pid of its MSYS parent (no identity check). */
export function parseMsysParents(psOutput: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of parseMsysPs(psOutput).values()) if (p.parentWinpid) out.set(p.winpid, p.parentWinpid);
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Is `started` (Windows creation time) the process MSYS ps saw? An MSYS process keeps its
 * STIME across exec, and the exec'd native program (claude.exe under the sh shim) is created
 * a moment later, so: STIME <= started <= psAt (the process existed when ps ran). A pid
 * reused after ps ran starts after psAt and fails. STIME is "HH:MM:SS" for today, else "Mon D".
 */
export function stimeMatches(stime: string, started: Date, psAt = new Date()): boolean {
  if (Number.isNaN(started.getTime()) || started.getTime() > psAt.getTime() + 999) return false;
  const time = /^(\d\d):(\d\d):(\d\d)$/.exec(stime);
  if (time) {
    const floor = new Date(psAt.getFullYear(), psAt.getMonth(), psAt.getDate(), +time[1]!, +time[2]!, +time[3]!);
    return started.getTime() >= floor.getTime();
  }
  const today = started.toDateString() === psAt.toDateString();
  return !today && stime.replace(/\s+/g, " ") === `${MONTHS[started.getMonth()]} ${started.getDate()}`;
}

/**
 * Re-parent Windows rows from MSYS ps. ps runs FIRST, then the Windows snapshot; a link is
 * applied only when the child and the parent are both still the processes ps saw
 * (stimeMatches). Windows reuses pids, and a pid reused after ps ran starts later, so it
 * fails the match.
 * No Git Bash (or ps fails) = the Windows snapshot unchanged.
 */
export async function withMsysParents<T extends { pid: number; ppid: number }>(
  snapshot: () => Promise<T[]>,
  startedOf: (row: T) => Date | undefined,
  readPs: () => Promise<string> = async () =>
    (await execFileAsync(msysPsPath(), ["-e"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout,
): Promise<T[]> {
  let msys: Map<number, MsysProc> | null = null;
  let psAt = new Date();
  try {
    msys = parseMsysPs(await readPs());
    psAt = new Date();
  } catch {
    msys = null;
  }
  const rows = await snapshot();
  if (!msys) return rows;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const same = (pid: number) => {
    const row = byPid.get(pid);
    const seen = msys!.get(pid);
    const started = row ? startedOf(row) : undefined;
    return Boolean(row && seen && started && stimeMatches(seen.stime, started, psAt));
  };
  return rows.map((r) => {
    const parent = msys!.get(r.pid)?.parentWinpid;
    return parent && same(r.pid) && same(parent) ? { ...r, ppid: parent } : r;
  });
}
