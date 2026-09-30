import { describe, it, expect } from "vitest";
import { SeenStore, DeadLetterStore, nodeStateFs, recoverDeadLock, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// In-memory FS fake — models append/write/read + a fixed clock, no real disk.
function memFs(): StateFsOps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync(p: string) {
      if (!files.has(p)) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p)!;
    },
    appendFileSync(p: string, d: string) {
      files.set(p, (files.get(p) ?? "") + d);
    },
    writeFileSync(p: string, d: string) {
      files.set(p, d);
    },
    rename(from: string, to: string) {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdirp() {
      /* no-op in memory */
    },
  };
}
const clock = () => new Date("2026-07-30T00:00:00.000Z");

describe("Slice-11 SeenStore — durable delivery-dedup (item 2)", () => {
  it("load() is empty when the file does not exist", () => {
    const fsx = memFs();
    expect(new SeenStore("/s/seen.jsonl", fsx, clock).load().size).toBe(0);
  });

  it("mark() then load() sees the id; SURVIVES a restart (fresh instance, same fs)", () => {
    const fsx = memFs();
    new SeenStore("/s/seen.jsonl", fsx, clock).mark("qitem-1", "posted");
    // fresh instance == process/daemon restart; reads the same durable file
    const reloaded = new SeenStore("/s/seen.jsonl", fsx, clock).load();
    expect(reloaded.has("qitem-1")).toBe(true);
    expect(reloaded.size).toBe(1);
  });

  it("dedups a repeated id in load() (byte-identical re-append collapses to one)", () => {
    const fsx = memFs();
    const s = new SeenStore("/s/seen.jsonl", fsx, clock);
    s.mark("qitem-1", "posted");
    s.mark("qitem-1", "posted"); // crash-window duplicate re-delivery, byte-identical
    expect(s.load().size).toBe(1);
    // both lines are byte-identical (same id, same fixed clock, same status)
    const lines = fsx.files.get("/s/seen.jsonl")!.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(lines[1]);
  });

  it("tolerates a torn final line (crash mid-append) without dropping good records", () => {
    const fsx = memFs();
    fsx.files.set("/s/seen.jsonl", JSON.stringify({ id: "ok", ts: "t", status: "posted" }) + "\n" + '{"id":"tor');
    expect(new SeenStore("/s/seen.jsonl", fsx, clock).load().has("ok")).toBe(true);
  });

  it("seed() marks ids as history without a side effect (item 9 backlog, zero replay-storm)", () => {
    const fsx = memFs();
    const s = new SeenStore("/s/seen.jsonl", fsx, clock);
    expect(s.seed(["a", "b", "c"])).toBe(3);
    const set = s.load();
    expect(set.has("a") && set.has("b") && set.has("c")).toBe(true);
    expect(fsx.files.get("/s/seen.jsonl")!.includes('"status":"seeded"')).toBe(true);
  });
});

describe("Slice-11 DeadLetterStore — inbound never-drop, interruption-safe (item 8, B2)", () => {
  it("append() persists an attempt-counted entry that survives restart", () => {
    const fsx = memFs();
    new DeadLetterStore("/s/dead.jsonl", fsx, clock).append({ ts: "1.1" }, 1);
    const all = new DeadLetterStore("/s/dead.jsonl", fsx, clock).readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.attempts).toBe(1);
    expect((all[0]!.ev as { ts: string }).ts).toBe("1.1");
  });

  it("B2: readAll() is NON-destructive — a crash after read but before replaceAll loses nothing", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "1.1" }, 1);
    const before = fsx.files.get("/s/dead.jsonl");
    const read = d.readAll(); // begin a retry pass…
    expect(read).toHaveLength(1);
    // …simulate a process interruption HERE (no replaceAll). The durable file is untouched:
    expect(fsx.files.get("/s/dead.jsonl")).toBe(before);
    // a fresh instance (restart) still recovers the entry — recoverableAfterInterruption = 1, not 0
    expect(new DeadLetterStore("/s/dead.jsonl", fsx, clock).readAll()).toHaveLength(1);
  });

  it("replaceAll() atomically leaves ONLY the still-failing set (temp-write + rename)", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "a" }, 1);
    d.append({ ts: "b" }, 1);
    const all = d.readAll();
    // pretend "a" landed, "b" still failing → keep only b with attempts+1
    d.replaceAll([{ ev: all[1]!.ev, at: all[1]!.at, attempts: all[1]!.attempts + 1 }]);
    const remaining = d.readAll();
    expect(remaining).toHaveLength(1);
    expect((remaining[0]!.ev as { ts: string }).ts).toBe("b");
    expect(remaining[0]!.attempts).toBe(2);
    expect(fsx.files.has("/s/dead.jsonl.tmp")).toBe(false); // temp renamed away, no litter
  });

  it("zero-drop across MANY failing retries (read → replaceAll with attempts+1)", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "1.1" }, 1);
    for (let round = 0; round < 5; round++) {
      const entries = d.readAll();
      expect(entries).toHaveLength(1); // never lost
      d.replaceAll(entries.map((e) => ({ ev: e.ev, at: e.at, attempts: e.attempts + 1 })));
    }
    const final = d.readAll();
    expect(final).toHaveLength(1);
    expect(final[0]!.attempts).toBe(6); // 1 initial + 5 retries, attempt-counted
  });

  it("readAll()/replaceAll() on a missing file are safe (no crash)", () => {
    const d = new DeadLetterStore("/s/none.jsonl", memFs(), clock);
    expect(d.readAll()).toEqual([]);
    d.replaceAll([]); // no-op, no throw
    expect(d.readAll()).toEqual([]);
  });
});

describe("DeadLetterStore — the cross-process journal lock", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "dl-lock-")), "dead.jsonl");
  const clk = () => new Date("2026-09-30T00:00:00Z");

  it("a LIVE holder paused past any age is never stolen from; the append goes to a side file, nothing lost", () => {
    const file = fresh();
    writeFileSync(`${file}.lock`, JSON.stringify({ token: "paused", pid: process.pid, host: hostname() })); // alive
    const d = new DeadLetterStore<{ ts: string }>(file, nodeStateFs, clk, 50);
    d.append({ ts: "a" }, 1);
    d.append({ ts: "b" }, 1);
    expect(JSON.parse(readFileSync(`${file}.lock`, "utf8")).token).toBe("paused"); // not stolen
    expect(d.readAll().map((e) => e.ev.ts).sort()).toEqual(["a", "b"]); // readable from the side files
    // once the holder releases, a settle folds the side files into the journal and removes them
    unlinkSync(`${file}.lock`); // the paused holder resumes and releases
    d.settle([{ entry: d.readAll().find((e) => e.ev.ts === "a")!, outcome: "done" }]);
    expect(d.readAll().map((e) => e.ev.ts)).toEqual(["b"]);
    expect(readdirSync(join(file, "..")).filter((f) => f.includes(".side-"))).toEqual([]);
  });

  it("a fresh orphan lock of a DEAD process (a crash just now) is recovered at once", () => {
    const file = fresh();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!; // a pid that has exited
    writeFileSync(`${file}.lock`, JSON.stringify({ token: "crashed", pid: dead, host: hostname() }));
    const d = new DeadLetterStore<{ ts: string }>(file, nodeStateFs, clk, 50);
    d.append({ ts: "x" }, 1);
    expect(readFileSync(file, "utf8")).toContain('"x"'); // in the journal itself, not a side file
    expect(existsSync(`${file}.lock`)).toBe(false); // released
  });

  it("two contenders judged the same dead lock: the second cannot remove the first's replacement", () => {
    const file = fresh();
    const lock = `${file}.lock`;
    const deadRaw = JSON.stringify({ token: "crashed", pid: spawnSync(process.execPath, ["-e", "0"]).pid, host: hostname() });
    writeFileSync(lock, deadRaw);
    // A and B both observed deadRaw. A recovers it and acquires a fresh lock...
    expect(recoverDeadLock(lock, deadRaw)).toBe(true);
    const releaseA = nodeStateFs.lock!(file);
    const aHolds = readFileSync(lock, "utf8");
    // ...then B acts on its stale observation: A's live lock must survive
    expect(recoverDeadLock(lock, deadRaw)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(aHolds);
    // and while A holds it, B cannot get in (A is alive)
    expect(() => nodeStateFs.lock!(file, 50)).toThrow(/held by a live process/);
    releaseA();
    expect(existsSync(lock)).toBe(false);
  });

  it("release removes only the caller's own lock", () => {
    const file = fresh();
    const release = nodeStateFs.lock!(file);
    writeFileSync(`${file}.lock`, JSON.stringify({ token: "someone-else", pid: process.pid, host: hostname() }));
    release();
    expect(JSON.parse(readFileSync(`${file}.lock`, "utf8")).token).toBe("someone-else");
  });
});
