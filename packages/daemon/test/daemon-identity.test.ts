import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDaemonId, infoRoutes } from "../src/routes/info.js";

describe("daemon identity (Arete per-company isolation)", () => {
  it("is minted once per OPENRIG_HOME and stable across calls and restarts", () => {
    const a = mkdtempSync(join(tmpdir(), "rig-a-"));
    const b = mkdtempSync(join(tmpdir(), "rig-b-"));
    const id = getDaemonId(a);
    expect(id).toMatch(/^openrig-[0-9a-f-]{36}$/);
    expect(getDaemonId(a)).toBe(id);
    expect(getDaemonId(b)).not.toBe(id);
  });

  it("a corrupt identity is refused, never silently re-minted", () => {
    const home = mkdtempSync(join(tmpdir(), "rig-bad-"));
    writeFileSync(join(home, "daemon-id"), "");
    expect(() => getDaemonId(home)).toThrow(/corrupt/);
    writeFileSync(join(home, "daemon-id"), "garbage");
    expect(() => getDaemonId(home)).toThrow(/corrupt/);
  });

  it("a failed directory fsync is fatal where directories can be fsynced (never an unsettled identity)", () => {
    const eio = () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    expect(() => getDaemonId(mkdtempSync(join(tmpdir(), "rig-eio-")), { platform: "linux", fsyncDir: eio })).toThrow(/EIO/);
    expect(getDaemonId(mkdtempSync(join(tmpdir(), "rig-win-")), { platform: "win32", fsyncDir: eio })).toMatch(/^openrig-/);
  });

  it("is reported by GET /api/info", async () => {
    const home = mkdtempSync(join(tmpdir(), "rig-info-"));
    const prior = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = home;
    try {
      const res = await infoRoutes().request("/");
      expect((await res.json()).daemonId).toBe(getDaemonId(home));
    } finally {
      if (prior === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = prior;
    }
  });
});
