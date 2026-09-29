// Projection ids become directory names (.claude/plugins/<id>, .agents/skills/<id>, ...).
// Windows forbids some characters (':' in "shared:openrig-core" failed mkdir and rolled the
// seat launch back), compares names case-INSENSITIVELY, drops trailing dots, and reserves
// device names (CON, NUL, COM1, ...). On win32 the mapping must stay injective under all
// of that, so: a name made only of [a-z0-9._-] (lowercase), not ending in '.', and not a
// device name passes unchanged; anything else is percent-encoded — every character outside
// [a-z0-9._-] (uppercase letters included) as %XX with uppercase hex. Raw text never
// contains '%', so escapes parse unambiguously whatever the case folding: distinct ids
// always map to distinct directories. POSIX layouts are unchanged.
const SAFE = /^[a-z0-9._-]$/;
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/;

const escape = (c: string) =>
  [...Buffer.from(c, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");

export function fsSafeName(id: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return id;
  let out = [...id].map((c) => (SAFE.test(c) ? c : escape(c))).join("");
  if (out.endsWith(".")) out = `${out.slice(0, -1)}%2E`;
  if (DEVICE.test(out)) out = `${escape(out[0]!)}${out.slice(1)}`;
  return out;
}
