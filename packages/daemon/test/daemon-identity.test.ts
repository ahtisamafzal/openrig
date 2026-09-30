import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // a failed barrier is retried by the next call, and the identity never changes
    const home = mkdtempSync(join(tmpdir(), "rig-retry-"));
    expect(() => getDaemonId(home, { platform: "linux", fsyncDir: eio })).toThrow(/EIO/);
    const linked = readFileSync(join(home, "daemon-id"), "utf8");
    let synced = 0;
    expect(() => getDaemonId(home, { platform: "linux", fsyncDir: (d) => { synced++; eio(d); } })).toThrow(/EIO/);
    expect(synced).toBe(1);
    expect(getDaemonId(home, { platform: "linux", fsyncDir: () => { synced++; } })).toBe(linked);
    expect(synced).toBe(2);
    expect(getDaemonId(home, { platform: "linux", fsyncDir: eio })).toBe(linked); // committed: no barrier
  });

  it("a crash that kept the committed marker but lost daemon-id restores the SAME identity from it", () => {
    const home = mkdtempSync(join(tmpdir(), "rig-lost-"));
    const id = getDaemonId(home);
    rmSync(join(home, "daemon-id")); // the Windows case: the earlier directory entry did not survive
    expect(getDaemonId(home)).toBe(id);
    expect(readFileSync(join(home, "daemon-id"), "utf8")).toBe(id);
    // a corrupt marker with no daemon-id is refused, never re-minted
    rmSync(join(home, "daemon-id"));
    writeFileSync(join(home, "daemon-id.committed"), "garbage");
    expect(() => getDaemonId(home)).toThrow(/corrupt/);
  });

  it("a caller that observes the name mid-commit never reports it before the barrier passes", () => {
    const home = mkdtempSync(join(tmpdir(), "rig-mid-"));
    const eio = () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    };
    let observed: unknown;
    // the creator's barrier: a second caller arrives between link and fsync (its own barrier fails too)
    expect(() =>
      getDaemonId(home, {
        platform: "linux",
        fsyncDir: (d) => {
          try {
            observed = getDaemonId(home, { platform: "linux", fsyncDir: eio });
          } catch (err) {
            observed = err;
          }
          eio(d);
        },
      }),
    ).toThrow(/EIO/);
    expect(observed).toBeInstanceOf(Error); // it never returned the unsettled identity
    // a contender that found the name already linked (EEXIST path) and failed its barrier leaves it
    // uncommitted too: the next call runs the barrier
    let synced = 0;
    const id = getDaemonId(home, { platform: "linux", fsyncDir: () => { synced++; } });
    expect(synced).toBe(1);
    expect(id).toBe(readFileSync(join(home, "daemon-id"), "utf8"));
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
