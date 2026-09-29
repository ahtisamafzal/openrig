// Slice-11 slack-connector — secret resolution (item 7 + 10).
//
// Secrets (Slack bot token / app-level token / incoming-webhook URL) resolve
// from EITHER an OPENRIG_SLACK_* environment variable OR a 0600 env file, at
// call time — NEVER stored in the connector config file, NEVER in the repo,
// NEVER logged. Mirrors the daemon's bearer_file/activity-hook-token posture.
// The env file lives on the TRUSTED host (item 10 secret-host axis); it may be
// a different host from the queue/alert host.
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

export interface SecretFsOps {
  readFileSync(p: string): string;
  statMode(p: string): number | null; // octal perm bits, or null if absent
  /** 5.2 Windows: principals other than the current user / SYSTEM / Administrators that can read
   *  the file (from its ACL), or null when not applicable (POSIX) or the ACL cannot be read. */
  aclReaders?(p: string): string[] | null;
}

const ALWAYS_TRUSTED = new Set(["nt authority\\system", "builtin\\administrators"]);

/** 5.2: parse `icacls <file>` output into the principals holding an allow-read grant, minus the
 *  current user, SYSTEM and Administrators. Deny entries never grant. */
export function parseIcaclsReaders(output: string, file: string, currentUser: string): string[] {
  const readers = new Set<string>();
  const me = currentUser.toLowerCase();
  for (let line of output.split(/\r?\n/)) {
    if (line.startsWith(file)) line = line.slice(file.length);
    const m = /^\s*(.+?):((?:\([^)]*\))+)\s*$/.exec(line);
    if (!m) continue;
    const principal = m[1]!.trim();
    const perms = m[2]!.toUpperCase();
    if (/\(DENY\)/.test(perms) || !/\((?:F|M|RX|R|GR|GA|GE)\)|\([^)]*\bRD\b[^)]*\)/.test(perms)) continue;
    const lower = principal.toLowerCase();
    if (ALWAYS_TRUSTED.has(lower) || lower === me || lower.endsWith(`\\${me}`)) continue;
    readers.add(principal);
  }
  return [...readers];
}

export const nodeSecretFs: SecretFsOps = {
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  statMode: (p) => {
    try {
      return fs.statSync(p).mode & 0o777;
    } catch {
      return null;
    }
  },
  aclReaders: (p) => {
    if (process.platform !== "win32") return null;
    try {
      const out = execFileSync("icacls", [p], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      return parseIcaclsReaders(out, p, os.userInfo().username);
    } catch {
      return null;
    }
  },
};

/** Parse KEY=VALUE lines (quotes trimmed). Blank lines / #comments ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  return out;
}

export interface SecretLookupOpts {
  envFile?: string; // path to the 0600 env file (optional)
  env?: NodeJS.ProcessEnv; // process env (default process.env)
  fsops?: SecretFsOps;
  /** Told why the env file was refused (never the secret). */
  onRefused?: (why: string) => void;
  platform?: NodeJS.Platform;
}

/** Warn if the env file is group/world readable (item 10 hygiene). Returns a warning string or null. */
export function checkEnvFilePermissions(envFile: string, fsops: SecretFsOps = nodeSecretFs, platform: NodeJS.Platform = process.platform): string | null {
  const mode = fsops.statMode(envFile);
  if (mode === null) return null; // absent — a separate "unconfigured" concern
  // 5.2: Windows mode bits are synthetic (always 0666/0444); the ACL is what decides who reads it
  if (platform === "win32") {
    const readers = fsops.aclReaders?.(envFile);
    if (readers === null || readers === undefined) return `secret env file ${envFile}: its access list could not be read — restrict it to the current user: icacls "${envFile}" /inheritance:r /grant:r "%USERNAME%:F"`;
    if (readers.length) return `secret env file ${envFile} is readable by ${readers.join(", ")} — restrict it to the current user: icacls "${envFile}" /inheritance:r /grant:r "%USERNAME%:F"`;
    return null;
  }
  if (mode & 0o077) return `secret env file ${envFile} is mode ${mode.toString(8)} — should be 0600 (group/other must not read secrets)`;
  return null;
}

/**
 * Resolve a secret by logical name. Precedence: explicit env var (OPENRIG_SLACK_<NAME>
 * or the raw name) → env-file key. Returns null when unresolved (honest: callers
 * report "unconfigured", they do NOT fabricate). Never logs the value.
 */
export function resolveSecret(name: string, opts: SecretLookupOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const fsops = opts.fsops ?? nodeSecretFs;
  // Aliases: the raw name (e.g. SLACK_WEBHOOK_URL) and the OPENRIG_-prefixed
  // form (OPENRIG_SLACK_WEBHOOK_URL). NOT OPENRIG_SLACK_<name> — that would
  // double the SLACK_ segment (the B4 defect).
  const envKeys = [name, `OPENRIG_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`];
  for (const k of envKeys) {
    if (env[k]) return env[k]!;
  }
  if (opts.envFile) {
    // 5.2: on Windows an env file others can read (or whose ACL cannot be read) is refused, not used
    const platform = opts.platform ?? process.platform;
    if (platform === "win32") {
      const problem = checkEnvFilePermissions(opts.envFile, fsops, platform);
      if (problem) {
        opts.onRefused?.(problem);
        return null;
      }
    }
    try {
      const map = parseEnvFile(fsops.readFileSync(opts.envFile));
      if (map[name]) return map[name];
    } catch {
      /* absent/unreadable → null */
    }
  }
  return null;
}
