// Windows: `rig daemon start` spawns the daemon detached, which libuv does with
// DETACHED_PROCESS — the daemon has no console, so every console program it runs
// (bash, git, herdr, powershell, ps…) opens a visible window unless the call sets
// windowsHide. There are 100+ call sites, so default it once here, before any
// module captures child_process functions. Import this first from the entry.
import { createRequire, syncBuiltinESMExports } from "node:module";

type AnyFn = (...args: unknown[]) => unknown;

const isOptions = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns `args` with `windowsHide: true` defaulted into the options argument. */
export function withWindowsHide(name: string, args: unknown[]): unknown[] {
  const out = [...args];
  for (let i = 1; i < out.length; i++) {
    const v = out[i];
    if (isOptions(v)) {
      if (v.windowsHide === undefined) out[i] = { ...v, windowsHide: true };
      return out;
    }
  }
  // No options object: insert one where each API expects it.
  const at = name.startsWith("exec") && !name.startsWith("execFile") ? 1 : Array.isArray(out[1]) ? 2 : 1;
  out.splice(Math.min(at, out.length), 0, { windowsHide: true });
  return out;
}

if (process.platform === "win32") {
  const cp = createRequire(import.meta.url)("node:child_process") as Record<string, AnyFn>;
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    const original = cp[name]!;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, withWindowsHide(name, args));
    };
    // Keep util.promisify's custom-args contract ({stdout, stderr}) for exec/execFile.
    for (const sym of Object.getOwnPropertySymbols(original)) {
      (wrapped as unknown as Record<symbol, unknown>)[sym] = (original as unknown as Record<symbol, unknown>)[sym];
    }
    cp[name] = wrapped;
  }
  syncBuiltinESMExports();
}
