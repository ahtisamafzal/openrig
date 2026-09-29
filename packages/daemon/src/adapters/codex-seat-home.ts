// Roadmap 1.12 — per-seat CODEX_HOME. Without it every Codex seat reads the operator's
// ~/.codex/config.toml and starts each global MCP server and plugin (codegraph, claude-mem,
// computer-use, ...) — a handful of processes per seat, and the operator's tools leak into
// seats. Opt-in: OPENRIG_CODEX_SEAT_HOME=1. The seat home holds only what OpenRig manages
// (activity hooks, workspace trust, projected config fragments), the operator's model and
// platform settings, and a SYMLINK to the operator's auth.json: credentials are referenced,
// never copied or read.
//
// Provenance is the directory itself: a seat whose home exists ran isolated and ALWAYS
// resumes from it (its rollouts live there), whatever the flag says now.
import fs from "node:fs";
import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

const seatDirName = (sessionName: string) => sessionName.replace(/[^A-Za-z0-9._@-]/g, "_");

/** Where a seat's isolated root lives (flag-independent). null without OPENRIG_HOME. */
export function codexSeatRootPath(sessionName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const openrigHome = env.OPENRIG_HOME?.trim();
  return openrigHome ? nodePath.join(openrigHome, "state", "codex-seat", seatDirName(sessionName)) : null;
}

const isolationOn = (env: NodeJS.ProcessEnv) => env.OPENRIG_CODEX_SEAT_HOME === "1" || env.OPENRIG_CODEX_SEAT_HOME === "true";

/** The seat's HOME-like root for a (fresh) launch; its Codex home is `<root>/.codex` (the
 *  layout Codex log and thread-id readers assume for HOME). null = isolation off. */
export function codexSeatRoot(sessionName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = codexSeatRootPath(sessionName, env);
  if (!root) return null;
  return isolationOn(env) || fs.existsSync(codexHomeOf(root)) ? root : null;
}

/**
 * The root a RESUME must use. An existing seat home wins (the seat ran isolated); with the
 * flag on and no home, the seat's state is missing — never fall back to the global home,
 * where the rollout is absent or, worse, an unrelated session could match.
 */
export function resumeCodexSeatRoot(sessionName: string, env: NodeJS.ProcessEnv = process.env): { root: string } | { missing: string } | null {
  const root = codexSeatRootPath(sessionName, env);
  if (!root) return null;
  if (fs.existsSync(codexHomeOf(root))) return { root };
  return isolationOn(env) ? { missing: codexHomeOf(root) } : null;
}

/** Every seat root on disk: thread-id lookups must find isolated seats after a restart. */
export function listCodexSeatRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const openrigHome = env.OPENRIG_HOME?.trim();
  if (!openrigHome) return [];
  const dir = nodePath.join(openrigHome, "state", "codex-seat");
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => nodePath.join(dir, d.name));
  } catch {
    return [];
  }
}

export const codexHomeOf = (root: string): string => nodePath.join(root, ".codex");

/**
 * Operator settings a seat must inherit to run at all — not tools, so they carry no MCP
 * servers or plugins: `[windows]` holds the Windows sandbox mode; without it Codex refuses
 * the workspace-write writable roots OpenRig passes and exits.
 */
export const INHERITED_CODEX_TABLES = ["windows"] as const;

/** Operator model defaults (not tools): a seat keeps the model the operator chose. */
export const INHERITED_CODEX_KEYS = ["model", "model_reasoning_effort", "plan_mode_reasoning_effort", "service_tier"] as const;

/** Top-level `key = value` lines (before the first table) for the given keys, in order. */
export function extractTopLevelKeys(content: string, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    if (key && keys.includes(key)) out.push(line.trim());
  }
  return out;
}

/** Set top-level key lines in `content` (replacing same-named top-level keys), above any table. */
export function upsertTopLevelKeys(content: string, lines: string[]): string {
  if (lines.length === 0) return content;
  const names = new Set(lines.map((l) => /^([A-Za-z0-9_-]+)/.exec(l)?.[1]));
  const all = content.split(/\r?\n/);
  const firstTable = all.findIndex((l) => /^\s*\[/.test(l));
  const head = (firstTable < 0 ? all : all.slice(0, firstTable)).filter((l) => !names.has(/^\s*([A-Za-z0-9_-]+)\s*=/.exec(l)?.[1]));
  const tail = firstTable < 0 ? [] : all.slice(firstTable);
  const top = [...lines, ...head.filter((l) => l.trim().length > 0)];
  return [...top, ...(tail.length ? ["", ...tail] : [])].join("\n").replace(/\n*$/, "\n");
}

/** Table header path with quotes removed: `[profiles."a b".x]` -> `profiles.a b.x`. */
const headerPath = (line: string): string | null => {
  const m = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
  return m ? m[1]!.split(".").map((p) => p.trim().replace(/^["']|["']$/g, "")).join(".") : null;
};

/**
 * The `[name]` table AND its sub-tables (`[name.*]`), each header to the next header, in
 * source order; null when absent. `name` is a dotted path without quotes.
 */
export function extractTomlTable(content: string, name: string): string | null {
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const path = headerPath(lines[i]!);
    if (path !== name && !path?.startsWith(`${name}.`)) continue;
    let end = i + 1;
    while (end < lines.length && headerPath(lines[end]!) === null) end++;
    blocks.push(lines.slice(i, end).join("\n").trimEnd());
    i = end - 1;
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** Put `table` (the output of extractTomlTable) into `content`, replacing any existing one. */
export function upsertTomlTable(content: string, name: string, table: string): string {
  const existing = extractTomlTable(content, name);
  if (existing !== null && content.includes(existing)) return content.replace(existing, table);
  const body = content.replace(/\n*$/, "");
  return body.length > 0 ? `${body}\n\n${table}\n` : `${table}\n`;
}

/** Shell assignment that points one Codex launch at the seat's home. */
export const codexSeatEnvPrefix = (root: string): string => `CODEX_HOME=${shellQuote(codexHomeOf(root))} `;

/**
 * Make `<seatHome>/auth.json` a symlink to the operator's auth. Never reads or copies it.
 * Refuses (throws) instead of letting credentials become seat-local: no global login yet
 * (Codex would write a real auth.json into the seat on login), or a regular credential file
 * already sitting in the seat home. Also throws when the OS refuses the symlink: the caller
 * must fail the launch, never fall back to a copy.
 */
export function linkCodexAuth(globalCodexHome: string, seatCodexHome: string): void {
  fs.mkdirSync(seatCodexHome, { recursive: true });
  const target = nodePath.join(globalCodexHome, "auth.json");
  const link = nodePath.join(seatCodexHome, "auth.json");
  if (!fs.existsSync(target)) {
    throw new Error(`no global Codex login at ${target}: run \`codex login\` once, then relaunch the seat`);
  }
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(link);
  } catch {
    stat = null;
  }
  if (stat && !stat.isSymbolicLink()) {
    throw new Error(`refusing to replace a real credential file at ${link}; move it away (the seat must reference the global login)`);
  }
  if (stat && fs.readlinkSync(link) === target) return;
  if (stat) fs.unlinkSync(link); // a stale symlink only
  fs.symlinkSync(target, link, "file");
}
