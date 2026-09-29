import { describe, expect, it } from "vitest";
import { mergeManagedBlock } from "../src/domain/managed-blocks.js";

// Re-projecting the same guidance must leave a user's CLAUDE.md / AGENTS.md byte-identical;
// it used to gain one blank line per re-merge.
describe("mergeManagedBlock is idempotent", () => {
  const memFs = (initial?: string) => {
    const files = new Map<string, string>(initial === undefined ? [] : [["/w/CLAUDE.md", initial]]);
    return {
      files,
      exists: (p: string) => files.has(p),
      readFile: (p: string) => files.get(p)!,
      writeFile: (p: string, c: string) => void files.set(p, c),
      mkdirp: () => {},
    };
  };

  it.each([
    ["no file yet", undefined],
    ["user file without trailing newline", "# Mine"],
    ["user file with trailing newlines", "# Mine\n\n\n"],
  ])("same block merged 3x leaves the file unchanged after the first merge (%s)", (_name, initial) => {
    const fs = memFs(initial);
    mergeManagedBlock(fs, "/w/CLAUDE.md", "arete-shared:constitution", "rules");
    const once = fs.files.get("/w/CLAUDE.md")!;
    mergeManagedBlock(fs, "/w/CLAUDE.md", "arete-shared:constitution", "rules");
    mergeManagedBlock(fs, "/w/CLAUDE.md", "arete-shared:constitution", "rules");
    expect(fs.files.get("/w/CLAUDE.md")).toBe(once);
    expect(once.endsWith("-->\n")).toBe(true);
    if (initial) expect(once.startsWith("# Mine")).toBe(true);
  });
});
