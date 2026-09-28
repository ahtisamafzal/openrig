import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFn } from "./tmux.js";

const execAsync = promisify(exec);

// Adapter commands are POSIX shell strings (quoting, redirects, `&`). On
// Windows, run them through Git Bash instead of cmd.exe.
const POSIX_SHELL = process.platform === "win32"
  ? process.env.OPENRIG_POSIX_SHELL ?? "C:\\Program Files\\Git\\bin\\bash.exe"
  : undefined;

function extractExecOutput(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const stdout = typeof (err as { stdout?: unknown }).stdout === "string"
    ? (err as { stdout: string }).stdout.trim()
    : "";
  const stderr = typeof (err as { stderr?: unknown }).stderr === "string"
    ? (err as { stderr: string }).stderr.trim()
    : "";
  return [stdout, stderr].filter(Boolean).join("\n");
}

/**
 * Production ExecFn for TmuxAdapter.
 * Wraps child_process.exec (shell command string) and returns stdout.
 */
export const execCommand: ExecFn = async (cmd: string): Promise<string> => {
  try {
    const { stdout } = await execAsync(cmd, { shell: POSIX_SHELL });
    return stdout;
  } catch (err) {
    const output = extractExecOutput(err);
    if (err instanceof Error && output && !err.message.includes(output)) {
      throw new Error(`${err.message}\n${output}`);
    }
    throw err;
  }
};
