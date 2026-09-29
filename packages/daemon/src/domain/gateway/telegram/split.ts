// Roadmap 5.1 — split an outbound message for Telegram's 4096-character limit. Telegram counts UTF-16
// code units (a JS string's .length), so that is what is measured (the Rust splitter measured bytes and
// could cut inside a character). Prefer paragraph, then line, then word boundaries; a hard cut never
// splits a surrogate pair. Later chunks are prefixed "[continue] " (as R).

export const TELEGRAM_LIMIT = 4096;
const CONT = "[continue] ";

function hardCut(s: string, max: number): number {
  let cut = max;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // do not leave a lone high surrogate
  return Math.max(1, cut);
}

function cutPoint(s: string, max: number): number {
  if (s.length <= max) return s.length;
  const window = s.slice(0, max);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = window.lastIndexOf(sep);
    if (i > max / 4) return i + sep.length; // a boundary that keeps a useful chunk
  }
  return hardCut(s, max);
}

export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length) {
    const prefix = out.length ? CONT : "";
    const room = limit - prefix.length;
    const n = cutPoint(rest, room);
    out.push(prefix + rest.slice(0, n).trimEnd());
    rest = rest.slice(n).replace(/^\s+/, "");
  }
  return out;
}
