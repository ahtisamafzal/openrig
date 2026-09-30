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
 * A short, synchronous cross-process lock: `<p>.lock` created exclusively, recording an owner
 * token + pid + host. It is never stolen from a LIVE holder (however long it pauses): only a
 * holder verified dead (same host, pid gone) — or a lock left torn/empty by a crash — is removed,
 * and only through recoverDeadLock (compare-and-remove under a recovery lock), so a contender acting
 * on a stale observation can never remove a replacement lock another contender just acquired.
 * Release unlinks only the caller's own token.
 * A contender that cannot get it in `waitMs` gets LockTimeout (callers fall back, never lose data).
 */
/**
 * Remove `lockPath` only if it still holds exactly `observed` (the bytes the caller judged dead).
 * Serialized by `<lock>.recover` (exclusive create): while one contender validates and removes,
 * no other can remove anything, so the check and the removal cannot be split by a replacement.
 * ponytail: a recoverer that crashes inside this few-microsecond section leaves `.recover`, which is
 * cleared after 5 s; a second crash in that window is the remaining ceiling.
 */
export function recoverDeadLock(lockPath: string, observed: string): boolean {
  const recover = `${lockPath}.recover`;
  try {
    fs.closeSync(fs.openSync(recover, "wx"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      if (Date.now() - fs.statSync(recover).mtimeMs > 5_000) fs.unlinkSync(recover);
    } catch {
      /* released meanwhile */
    }
    return false; // someone else is recovering: re-evaluate
  }
  try {
    let current: string;
    try {
      current = fs.readFileSync(lockPath, "utf8");
    } catch {
      return true; // already gone
    }
    if (current !== observed) return false; // replaced by a live acquirer: never touch it
    fs.unlinkSync(lockPath);
    return true;
  } finally {
    try {
      fs.unlinkSync(recover);
    } catch {
      /* gone */
    }
  }
}

function fileLock(p: string, waitMs = 10_000): () => void {
  const lockPath = `${p}.lock`;
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, host: os.hostname() }));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          if ((JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: string }).token === token) fs.unlinkSync(lockPath);
        } catch {
          /* gone, or no longer ours: nothing to release */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holder: { pid?: number; host?: string } | null = null;
    let observed: string | null = null;
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lockPath).mtimeMs;
      observed = fs.readFileSync(lockPath, "utf8");
      holder = JSON.parse(observed) as { pid?: number; host?: string };
    } catch {
      holder = null; // torn (a crash between create and write) or released meanwhile
    }
    if (observed === null) continue; // released meanwhile: try again
    const dead = holder ? holder.host === os.hostname() && typeof holder.pid === "number" && !pidAlive(holder.pid) : age > 2_000;
    if (dead) {
      recoverDeadLock(lockPath, observed); // removes it only if it is still exactly what we judged
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeout(`journal lock ${lockPath} is held by a live process`);
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
