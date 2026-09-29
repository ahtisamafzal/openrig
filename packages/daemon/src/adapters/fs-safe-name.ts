// Projection ids become directory names (.claude/plugins/<id>, .agents/skills/<id>, ...).
// Namespaced ids such as "shared:openrig-core" are valid names on POSIX but not on Windows,
// where ':' (and <>"|?*) is forbidden — mkdir fails and the seat launch rolls back.
// On win32 those characters (and '%' itself, so the mapping stays injective: "a:b" and
// "a_b" never share a directory) are percent-encoded. POSIX layouts are unchanged.
export function fsSafeName(id: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return id;
  return id.replace(/[%<>:"|?*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
