// Projection ids become directory names (.claude/plugins/<id>, .agents/skills/<id>, ...).
// Namespaced ids such as "shared:openrig-core" are valid names on POSIX but not on Windows,
// where ':' (and <>"|?*) is forbidden — mkdir fails with ENOENT and the seat launch rolls
// back. On win32 those characters become "_"; POSIX layouts are unchanged.
export function fsSafeName(id: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? id.replace(/[<>:"|?*]/g, "_") : id;
}
