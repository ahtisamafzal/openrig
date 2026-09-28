// Post-tsc build steps, portable across POSIX shells and Windows cmd
// (was: chmod/mkdir -p/cp in the npm script, which cmd.exe cannot run).
import { chmodSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const copyAll = (from, to, ext) => {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) if (f.endsWith(ext)) copyFileSync(join(from, f), join(to, f));
};

chmodSync("dist/bin-wrapper.js", 0o755);
copyAll("src/schemas", "dist/schemas", ".json");
copyAll("src/lib/scope-templates", "dist/lib/scope-templates", ".md");
copyFileSync("../../LICENSE", "LICENSE");
