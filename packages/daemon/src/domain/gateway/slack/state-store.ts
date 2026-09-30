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
import fs from "node:fs";
import path from "node:path";

export interface StateFsOps {
  readFileSync(p: string): string; // throws (ENOENT) when absent — callers treat as empty
  appendFileSync(p: string, data: string): void;
  writeFileSync(p: string, data: string): void;
  rename(from: string, to: string): void; // atomic same-dir replace
  mkdirp(dir: string): void;
  /** Cross-process exclusive section over `p` (returns the release). Absent = single process. */
  lock?(p: string): () => void;
}

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
/**
 * A short, synchronous cross-process lock: `<p>.lock` created exclusively. Holders only do a few
 * synchronous file operations, so a lock older than LOCK_STALE_MS was left by a crashed process and
 * is removed. ponytail: two waiters can both judge the same crashed lock stale in the same instant;
 * the window needs a crash first, and the journal operations it guards are merge-safe.
 */
function fileLock(p: string): () => void {
  const lockPath = `${p}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // released between our open and stat
      }
      if (Date.now() > deadline) throw new Error(`journal lock ${lockPath} is held`);
      Atomics.wait(nap, 0, 0, 5);
    }
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
  ) {}

  append(ev: T, attempts: number): void {
    this.fsops.mkdirp(path.dirname(this.file));
    // under the journal lock: an append can never land between another process's read and replace
    const release = this.fsops.lock?.(this.file);
    try {
      this.fsops.appendFileSync(
        this.file,
        JSON.stringify({ ev, at: this.now().toISOString(), attempts } satisfies DeadLetterEntry<T>) + "\n",
      );
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
    const release = this.fsops.lock?.(this.file);
    try {
      const next: DeadLetterEntry<T>[] = [];
      for (const e of this.readAll()) {
        const o = outcome.get(key(e));
        if (o === "done") continue;
        next.push(o === "retry" ? { ...e, attempts: e.attempts + 1 } : e);
      }
      this.replaceAll(next);
    } finally {
      release?.();
    }
  }

  /** Non-destructive read of all durable entries. */
  readAll(): DeadLetterEntry<T>[] {
    let raw: string;
    try {
      raw = this.fsops.readFileSync(this.file);
    } catch {
      return [];
    }
    return parseLines(raw) as DeadLetterEntry<T>[];
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
