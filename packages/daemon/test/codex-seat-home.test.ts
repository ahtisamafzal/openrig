import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexHomeOf, codexSeatEnvPrefix, codexSeatRoot, linkCodexAuth, listCodexSeatRoots, resumeCodexSeatRoot } from "../src/adapters/codex-seat-home.js";

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const mkTmp = () => { const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codex-seat-home-")); tmp.push(d); return d; };

describe("per-seat Codex home (roadmap 1.12)", () => {
  it("is off unless OPENRIG_CODEX_SEAT_HOME=1 and OPENRIG_HOME are set", () => {
    expect(codexSeatRoot("dev-qa@r", {})).toBeNull();
    expect(codexSeatRoot("dev-qa@r", { OPENRIG_CODEX_SEAT_HOME: "1" })).toBeNull();
    const root = codexSeatRoot("dev-qa@r", { OPENRIG_CODEX_SEAT_HOME: "1", OPENRIG_HOME: "/h" })!;
    expect(root).toBe(nodePath.join("/h", "state", "codex-seat", "dev-qa@r"));
    expect(codexHomeOf(root)).toBe(nodePath.join(root, ".codex"));
    expect(codexSeatRoot("a b/../c", { OPENRIG_CODEX_SEAT_HOME: "1", OPENRIG_HOME: "/h" })).toBe(nodePath.join("/h", "state", "codex-seat", "a_b_.._c"));
  });

  it("points one launch at the seat home via a shell assignment", () => {
    expect(codexSeatEnvPrefix("/h/s")).toBe(`CODEX_HOME='${nodePath.join("/h/s", ".codex")}' `);
  });

  it("links the operator's auth (never a copy), idempotently; refuses when that would leave credentials seat-local", () => {
    const global = mkTmp(), seat = nodePath.join(mkTmp(), ".codex");
    expect(() => linkCodexAuth(global, seat)).toThrow(/codex login/); // no global login yet
    fs.writeFileSync(nodePath.join(global, "auth.json"), "{}");
    try {
      linkCodexAuth(global, seat);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return; // symlinks not permitted on this host
      throw err;
    }
    const link = nodePath.join(seat, "auth.json");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(nodePath.join(global, "auth.json"));
    linkCodexAuth(global, seat); // idempotent
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    fs.unlinkSync(link);
    fs.writeFileSync(link, "{\"real\":1}"); // a real credential file in the seat is never replaced
    expect(() => linkCodexAuth(global, seat)).toThrow(/refusing to replace a real credential file/);
    expect(fs.readFileSync(link, "utf8")).toBe("{\"real\":1}");
  });

  it("a seat that ran isolated always resumes from its home; missing home + flag on = refuse", () => {
    const home = mkTmp();
    const on = { OPENRIG_CODEX_SEAT_HOME: "1", OPENRIG_HOME: home };
    const off = { OPENRIG_HOME: home };
    expect(resumeCodexSeatRoot("s@r", off)).toBeNull();
    expect(resumeCodexSeatRoot("s@r", on)).toEqual({ missing: codexHomeOf(nodePath.join(home, "state", "codex-seat", "s@r")) });
    fs.mkdirSync(codexHomeOf(nodePath.join(home, "state", "codex-seat", "s@r")), { recursive: true });
    expect(resumeCodexSeatRoot("s@r", off)).toEqual({ root: nodePath.join(home, "state", "codex-seat", "s@r") }); // flag later turned off
    expect(codexSeatRoot("s@r", off)).toBe(nodePath.join(home, "state", "codex-seat", "s@r"));
    expect(listCodexSeatRoots(off)).toEqual([nodePath.join(home, "state", "codex-seat", "s@r")]);
  });
});

describe("fsSafeName (projection ids as directory names)", () => {
  it("is injective on Windows even under case-insensitivity, trailing dots and device names", async () => {
    const { fsSafeName } = await import("../src/adapters/fs-safe-name.js");
    const w = (id: string) => fsSafeName(id, "win32");
    expect(w("openrig-skills")).toBe("openrig-skills"); // plain lowercase ids unchanged
    expect(w("shared:openrig-core")).toBe("shared%3Aopenrig-core");
    const ids = ["a:b", "a_b", "a%3Ab", "Foo", "foo", "FOO", "name", "name.", "con", "CON", "con.txt", "nul", "x y", "é"];
    const folded = ids.map((id) => w(id).toLowerCase());
    expect(new Set(folded).size).toBe(ids.length); // no two ids share a directory, case-folded
    for (const name of ids.map(w)) {
      expect(name).not.toMatch(/[<>:"|?*\\/ ]/);
      expect(name.endsWith(".")).toBe(false);
      expect(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)).toBe(false);
    }
    expect(fsSafeName("shared:openrig-core", "linux")).toBe("shared:openrig-core"); // POSIX unchanged
  });
});

describe("seat config inherits only the tables a seat needs to run", () => {
  it("extracts and upserts one top-level TOML table", async () => {
    const { extractTomlTable, upsertTomlTable } = await import("../src/adapters/codex-seat-home.js");
    const global = ['model = "x"', "", "[windows]", 'sandbox = "elevated"', "", "[mcp_servers.a]", 'command = "a"'].join("\n");
    const table = extractTomlTable(global, "windows");
    expect(table).toBe('[windows]\nsandbox = "elevated"');
    expect(upsertTomlTable("[features]\nhooks = true\n", "windows", table!)).toBe('[features]\nhooks = true\n\n[windows]\nsandbox = "elevated"\n');
    expect(upsertTomlTable('[windows]\nsandbox = "old"\n[x]', "windows", table!)).toBe('[windows]\nsandbox = "elevated"\n[x]');
    expect(extractTomlTable(global, "nope")).toBeNull();
  });
});

describe("seat config inherits the operator's model defaults", () => {
  it("copies only the listed top-level keys and keeps them above every table", async () => {
    const { INHERITED_CODEX_KEYS, extractTopLevelKeys, upsertTopLevelKeys } = await import("../src/adapters/codex-seat-home.js");
    const global = ['sandbox_permissions = ["x"]', 'model = "gpt-5.6-sol"', 'service_tier = "fast"', "", "[features]", 'model = "not-top-level"'].join("\n");
    const lines = extractTopLevelKeys(global, INHERITED_CODEX_KEYS);
    expect(lines).toEqual(['model = "gpt-5.6-sol"', 'service_tier = "fast"']);
    const seat = upsertTopLevelKeys('model = "old"\n\n[features]\nhooks = true\n', lines);
    expect(seat).toBe('model = "gpt-5.6-sol"\nservice_tier = "fast"\n\n[features]\nhooks = true\n');
  });
});

describe("profile tables travel with a profile-bound seat", () => {
  it("extracts a profile with its sub-tables and quoted headers", async () => {
    const { extractTomlTable } = await import("../src/adapters/codex-seat-home.js");
    const global = ['[profiles."fast one"]', 'model = "m"', "[profiles.\"fast one\".tools]", "web = true", "[profiles.other]", 'model = "x"'].join("\n");
    expect(extractTomlTable(global, "profiles.fast one")).toBe('[profiles."fast one"]\nmodel = "m"\n\n[profiles."fast one".tools]\nweb = true');
    expect(extractTomlTable(global, "profiles.missing")).toBeNull();
  });
});
