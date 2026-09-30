// Slice-11 slack-connector — durable, restart-surviving state.
//
// Three append-only JSONL stores, written to disk so they survive BOTH a
// connector restart AND a queue-daemon restart (locked item 2 + item 8):
//   - SeenStore     : delivery-dedup by id; a line is appended ONLY AFTER the
//                     side effect succeeds (outbound: after a 200 from Slack;
//                     inbound: after the durable qitem exists). At-least-once —
//                     a crash between success and append re-delivers a
//                     BYTE-IDENTICAL duplicate next run, never a drop.
//   - DeadLetterStore : the inbound never-drop net. An event that fails to land
//                     in the queue is appended (attempt-counted) BEFORE the
//                     failure path returns; drain() truncates and hands the
//                     lines back so the caller re-appends any that fail again
//                     ("zero-drop means zero, not zero-until-the-second-failure").
//   - InboundReceiptStore : credential-free ingress/lifecycle observations,
//                     with received recorded before filtering and a final disposition.
//
// FS + clock are injected so the whole thing is unit-testable with no real disk.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StateFsOps {
  readFileSync(p: string): string; // throws (ENOENT) when absent — callers treat as empty
  appendFileSync(p: string, data: string): void;
  writeFileSync(p: string, data: string): void;
  rename(from: string, to: string): void; // atomic same-dir replace
  mkdirp(dir: string): void;
  /** Cross-process exclusive section over `p` (returns the release; throws LockTimeout when it
   *  cannot be had in `waitMs`). Absent = single process. */
  lock?(p: string, waitMs?: number): () => void;
  /** Files in `dir` (for side files). Absent = none. */
  list?(dir: string): string[];
  unlink?(p: string): void;
  /** Exclusive create (fails if `p` exists). */
  createExclusive?(p: string, data: string): void;
}

export class LockTimeout extends Error {}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};

/**
 * A short, synchronous cross-process lock built from GENERATIONS, so no lock file is ever removed
 * while it could matter: acquiring means exclusively creating `<p>.lock.<N+1>` (owner token + pid +
 * host) when generation N is free — released (a `.free` marker its owner wrote), its owner verified
 * dead (same host, pid gone), or left torn by a crash. Exactly one contender can create N+1, so two
 * contenders that judged the same holder dead cannot both win, and a LIVE holder (however long it
 * pauses) is never taken over. Older generations are tidied by the next holder. A contender that
 * cannot get it in `waitMs` gets LockTimeout (callers fall back, never lose data).
 * ponytail: a generation left TORN (a crash between its create and its write) counts as free after 2 s.
 */
export function fileLock(p: string, waitMs = 10_000, hooks: { afterJudge?: () => void } = {}): () => void {
  const dir = path.dirname(p);
  const prefix = `${path.basename(p)}.lock.`;
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const gens = () => {
    try {
      return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && /^\d+$/.test(f.slice(prefix.length))).map((f) => Number(f.slice(prefix.length)));
    } catch {
      return [];
    }
  };
  const genFile = (g: number) => path.join(dir, `${prefix}${g}`);
  for (;;) {
    const all = gens();
    const top = all.reduce((a, g) => Math.max(a, g), 0);
    let free = top === 0 || fs.existsSync(`${genFile(top)}.free`);
    if (!free) {
      try {
        const h = JSON.parse(fs.readFileSync(genFile(top), "utf8")) as { pid?: number; host?: string };
        free = h.host === os.hostname() && typeof h.pid === "number" && !pidAlive(h.pid);
      } catch {
        try {
          free = Date.now() - fs.statSync(genFile(top)).mtimeMs > 2_000; // torn by a crash
        } catch {
          continue; // changed meanwhile: re-evaluate
        }
      }
    }
    if (free) {
      hooks.afterJudge?.();
      const mine = top + 1;
      try {
        fs.writeFileSync(genFile(mine), JSON.stringify({ token, pid: process.pid, host: os.hostname() }), { flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue; // another contender won N+1
        throw err;
      }
      for (const g of all) {
        if (g >= top) continue; // tidy only generations no contender can still be judging
        for (const f of [genFile(g), `${genFile(g)}.free`]) {
          try {
            fs.unlinkSync(f);
          } catch {
            /* gone */
          }
        }
      }
      return () => {
        try {
          if ((JSON.parse(fs.readFileSync(genFile(mine), "utf8")) as { token?: string }).token === token) fs.writeFileSync(`${genFile(mine)}.free`, "", { flag: "wx" });
        } catch {
          /* already released */
        }
      };
    }
    if (Date.now() > deadline) throw new LockTimeout(`journal lock ${genFile(top)} is held by a live process`);
    Atomics.wait(nap, 0, 0, 5);
  }
}

export const nodeStateFs: StateFsOps = {
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  appendFileSync: (p, d) => fs.appendFileSync(p, d),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
  rename: (from, to) => fs.renameSync(from, to),
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  lock: fileLock,
  list: (dir) => fs.readdirSync(dir),
  unlink: (p) => fs.unlinkSync(p),
  createExclusive: (p, d) => fs.writeFileSync(p, d, { flag: "wx" }),
};

function parseLines(raw: string): unknown[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // tolerate a torn final line from a crash mid-append
      }
    })
    .filter((x): x is unknown => x !== null);
}

export interface SeenRecord {
  id: string;
  ts: string;
  status: string;
}

/**
 * Delivery-dedup log. `load()` reads the durable set from disk; `mark()` appends
 * AFTER the guarded side effect. Idempotent on id: a repeated id collapses in
 * `load()`'s Set, and callers gate the side effect on `!seen.has(id)` so a
 * duplicate is never re-delivered within a run.
 */
export class SeenStore {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  load(): Set<string> {
    let raw: string;
    try {
      raw = this.fsops.readFileSync(this.file);
    } catch {
      return new Set();
    }
    return new Set(parseLines(raw).map((r) => (r as SeenRecord).id).filter((id) => typeof id === "string"));
  }

  /** Append a seen record. MUST be called only after the guarded side effect succeeds. */
  mark(id: string, status: string): void {
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.appendFileSync(this.file, JSON.stringify({ id, ts: this.now().toISOString(), status }) + "\n");
  }

  /**
   * Seed existing ids as already-seen WITHOUT triggering the side effect
   * (locked item 9: enable-time backlog seeds as history, zero replay storm).
   */
  seed(ids: string[], status = "seeded"): number {
    if (ids.length === 0) return 0;
    this.fsops.mkdirp(path.dirname(this.file));
    const at = this.now().toISOString();
    const chunk = ids.map((id) => JSON.stringify({ id, ts: at, status })).join("\n") + "\n";
    this.fsops.appendFileSync(this.file, chunk);
    return ids.length;
  }
}

export interface DeadLetterEntry<T = unknown> {
  ev: T;
  at: string;
  attempts: number;
}

/**
 * Inbound never-drop net. Every event that fails to land is appended
 * (attempt-counted) BEFORE the error path returns.
 *
 * INTERRUPTION-SAFE retry (the B2 fix): retry does NOT truncate first. The
 * caller `readAll()`s (non-destructive), attempts each, then `replaceAll()`s the
 * file with ONLY the still-failing entries via an atomic temp-write + rename. So
 * the durable file always reflects the unrecovered set: a crash at ANY point
 * before the rename leaves the ORIGINAL file fully intact (at-least-once — a
 * since-landed event is skipped on re-read via the seen-set, so not even a dup).
 * There is no truncate-before-success window.
 */
let tmpSeq = 0;
export class DeadLetterStore<T = unknown> {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
    private readonly lockWaitMs = 10_000,
  ) {}

  /** Side files: entries appended while the journal lock could not be had (see append). */
  private sideFiles(): string[] {
    const dir = path.dirname(this.file);
    const prefix = `${path.basename(this.file)}.side-`;
    try {
      return (this.fsops.list?.(dir) ?? []).filter((f) => f.startsWith(prefix)).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  append(ev: T, attempts: number): void {
    this.fsops.mkdirp(path.dirname(this.file));
    const line = JSON.stringify({ ev, at: this.now().toISOString(), attempts } satisfies DeadLetterEntry<T>) + "\n";
    // under the journal lock: an append can never land between another process's read and replace
    let release: (() => void) | undefined;
    try {
      release = this.fsops.lock?.(this.file, this.lockWaitMs);
    } catch (err) {
      if (!(err instanceof LockTimeout) || !this.fsops.createExclusive) throw err;
      // the lock is held by a live (paused) process: never lose the entry — write it to its own
      // uniquely named side file (no lock needed); reads include it and the next settle folds it in
      this.fsops.createExclusive(`${this.file}.side-${process.pid}-${randomUUID()}.jsonl`, line);
      return;
    }
    try {
      this.fsops.appendFileSync(this.file, line);
    } finally {
      release?.();
    }
  }

  /**
   * Record a retry pass's outcomes by MERGING into the journal as it is now (under the journal
   * lock, so across processes too): an entry the pass resolved is removed, one it retried in vain
   * gets attempts+1, and every other entry — appended meanwhile, or held by another router's pass
   * — is kept untouched. Entries are matched by identity (`at` + event), never by position.
   */
  settle(results: ReadonlyArray<{ entry: DeadLetterEntry<T>; outcome: "done" | "retry" }>): void {
    const key = (e: DeadLetterEntry<T>) => `${e.at}\u0000${JSON.stringify(e.ev)}`;
    const outcome = new Map(results.map((r) => [key(r.entry), r.outcome]));
    this.fsops.mkdirp(path.dirname(this.file));
    const release = this.fsops.lock?.(this.file, this.lockWaitMs); // a timeout skips this settle (retried next pass)
    try {
      const sides = this.sideFiles();
      const next: DeadLetterEntry<T>[] = [];
      for (const e of this.readAll()) {
        const o = outcome.get(key(e));
        if (o === "done") continue;
        next.push(o === "retry" ? { ...e, attempts: e.attempts + 1 } : e);
      }
      this.replaceAll(next); // side-file entries are folded into the journal...
      for (const f of sides) this.fsops.unlink?.(f); // ...then removed (a crash between: a harmless duplicate)
    } finally {
      release?.();
    }
  }

  /** Non-destructive read of all durable entries (the journal and any side files). */
  readAll(): DeadLetterEntry<T>[] {
    const out: DeadLetterEntry<T>[] = [];
    for (const f of [this.file, ...this.sideFiles()]) {
      try {
        out.push(...(parseLines(this.fsops.readFileSync(f)) as DeadLetterEntry<T>[]));
      } catch {
        /* absent */
      }
    }
    return out;
  }

  /** Atomically replace the durable set (temp-write + rename). Callers outside settle() must
   *  hold the journal exclusively (tests, single-process tools). */
  replaceAll(entries: DeadLetterEntry<T>[]): void {
    this.fsops.mkdirp(path.dirname(this.file));
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
    const tmp = `${this.file}.${process.pid}.${++tmpSeq}.tmp`; // never shared with another writer
    this.fsops.writeFileSync(tmp, body);
    this.fsops.rename(tmp, this.file); // atomic: original intact until this instant
  }
}

export type InboundReceiptStatus =
  | "connect-attempt"
  | "connected"
  | "disconnected"
  | "connect-failed"
  | "received"
  | "accepted"
  | "ignored"
  | "refused"
  | "dead-lettered"
  | "handler-failed";

export interface InboundReceipt {
  at: string;
  generation: number;
  status: InboundReceiptStatus;
  envelopeId?: string;
  eventTs?: string;
  channel?: string;
  reason?: string;
}

/** Credential-free ingress/lifecycle ledger. A received receipt is appended before
 * handler filtering, then a final typed disposition follows. It deliberately has no
 * message body, sender, token, or secret fields. */
export class InboundReceiptStore {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(receipt: Omit<InboundReceipt, "at">): void {
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.appendFileSync(this.file, JSON.stringify({ at: this.now().toISOString(), ...receipt } satisfies InboundReceipt) + "\n");
  }

  readAll(): InboundReceipt[] {
    try {
      return parseLines(this.fsops.readFileSync(this.file)) as InboundReceipt[];
    } catch {
      return [];
    }
  }
}
