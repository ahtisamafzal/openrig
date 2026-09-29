// Roadmap 1.12 — per-seat CODEX_HOME. Without it every Codex seat reads the operator's
// ~/.codex/config.toml and starts each global MCP server and plugin (codegraph, claude-mem,
// computer-use, ...) — a handful of processes per seat, and the operator's tools leak into
// seats. Opt-in: OPENRIG_CODEX_SEAT_HOME=1. The seat home holds only what OpenRig manages
// (activity hooks, workspace trust, projected config fragments) plus a SYMLINK to the
// operator's auth.json: credentials are referenced, never copied or read.
import fs from "node:fs";
import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

/** The seat's HOME-like root; its Codex home is `<root>/.codex` (the layout Codex log and
 *  thread-id readers already assume for HOME). null = isolation off. */
export function codexSeatRoot(sessionName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const on = env.OPENRIG_CODEX_SEAT_HOME;
  if (on !== "1" && on !== "true") return null;
  const openrigHome = env.OPENRIG_HOME?.trim();
  if (!openrigHome) return null;
  return nodePath.join(openrigHome, "state", "codex-seat", sessionName.replace(/[^A-Za-z0-9._@-]/g, "_"));
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

/** One top-level `[name]` table (header to the next header), or null. */
export function extractTomlTable(content: string, name: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n").trimEnd();
}

/** Put `table` (a whole `[name]` block) into `content`, replacing any existing one. */
export function upsertTomlTable(content: string, name: string, table: string): string {
  const existing = extractTomlTable(content, name);
  if (existing !== null) return content.replace(existing, table);
  const body = content.replace(/\n*$/, "");
  return body.length > 0 ? `${body}\n\n${table}\n` : `${table}\n`;
}

/** Shell assignment that points one Codex launch at the seat's home. */
export const codexSeatEnvPrefix = (root: string): string => `CODEX_HOME=${shellQuote(codexHomeOf(root))} `;

/**
 * Make `<seatHome>/auth.json` a symlink to the operator's auth. Never reads or copies it.
 * No operator auth yet = nothing to link (Codex will ask to log in, as it would globally).
 * Throws when the OS refuses the symlink: the caller must not silently fall back to a copy.
 */
export function linkCodexAuth(globalCodexHome: string, seatCodexHome: string): void {
  fs.mkdirSync(seatCodexHome, { recursive: true });
  const target = nodePath.join(globalCodexHome, "auth.json");
  const link = nodePath.join(seatCodexHome, "auth.json");
  if (!fs.existsSync(target)) return;
  try {
    if (fs.readlinkSync(link) === target) return;
  } catch {
    // absent or not a link
  }
  fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link, "file");
}
