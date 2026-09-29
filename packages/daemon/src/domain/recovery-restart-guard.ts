// Roadmap 3.2 — restart safety rules for RECOVERY restarts requested by agents.
//
// Arete's five restart refusals (harness/watchdog/restart.ts) re-based on durable OpenRig facts,
// plus the Rust brain's protected-seat and caller-scope rules (arete-rust watchdog.rs), keyed on
// OpenRig node role and `delegates_to` edges instead of seat-name prefixes.
//
// Who is gated (owner decision 2026-09-29): AGENT callers only — a request carrying a transport
// identity (X-OpenRig-Session) that is not a human seat. The operator (no identity: TUI, CLI from
// their own shell; or a human seat) can always relaunch a seat. Planned handovers never pass here.
// Protected roles: configurable (OPENRIG_PROTECTED_ROLES), none by default.
//
// Every refusal is reported (not first-match), like the Arete original.

import type Database from "better-sqlite3";
import { isHumanSeatSessionRef } from "./session-name.js";
import { resolveSessionNodeId } from "./queue-owner.js";

export interface RecoveryEvidence {
  /** What failed — the seat's error, the watchdog classification, … (Arete guard b). */
  failureEvidence?: string;
  /** Where the evidence lives (a queue item, watchdog history, a log) — replaces the local
   *  recovery-brief file of Arete guard a. */
  evidenceRef?: string;
  /** The caller consulted provider/seat health before asking (Arete guard d). */
  healthConsulted?: boolean;
}

export interface RecoveryTarget {
  nodeId: string;
  role: string | null;
  /** The seat's current session name (its queue destination). */
  sessionName: string;
}

export interface RecoveryGuardConfig {
  /** Recovery restarts of one seat allowed per window (Arete/Rust cap: 2). */
  retryCap: number;
  windowHours: number;
  protectedRoles: readonly string[];
  /** Non-seat identities allowed to recover any unprotected seat (e.g. Arete's recovery policy). */
  recoveryCallers: readonly string[];
}

export type RecoveryDecision =
  | { allowed: true; caller: "operator" }
  | { allowed: true; caller: "agent"; identity: string }
  | { allowed: false; identity: string; reasons: string[] };

export const RECOVERY_EVENT = "seat.recovery_restart_authorized";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function recoveryGuardConfig(env: NodeJS.ProcessEnv = process.env): RecoveryGuardConfig {
  const cap = Number(env.OPENRIG_RECOVERY_RETRY_CAP);
  const hours = Number(env.OPENRIG_RECOVERY_WINDOW_HOURS);
  return {
    retryCap: Number.isInteger(cap) && cap >= 0 ? cap : 2,
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : 24,
    protectedRoles: list(env.OPENRIG_PROTECTED_ROLES),
    recoveryCallers: list(env.OPENRIG_RECOVERY_CALLERS),
  };
}

/** Is `ancestor` a delegates_to ancestor of `node` (the node orchestrates it, directly or not)? */
function orchestrates(db: Database.Database, ancestor: string, node: string): boolean {
  const parents = db.prepare(`SELECT source_id AS id FROM edges WHERE target_id = ? AND kind = 'delegates_to'`);
  const seen = new Set<string>();
  const queue = [node];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const { id } of parents.all(cur) as Array<{ id: string }>) {
      if (id === ancestor) return true;
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return false;
}

/** The requester's identity when it is an AGENT (a transport identity that is not a human seat); null = the operator. */
export function agentIdentity(transportSession: string | null | undefined): string | null {
  const id = transportSession?.trim();
  return id && !isHumanSeatSessionRef(id) ? id : null;
}

/**
 * Bulk/fleet restores (subset launch, `up`, crash-cart fleet restore, snapshot restore) relaunch
 * many seats at once and cannot carry per-seat recovery evidence: agents are refused there and
 * recover one seat at a time through the guarded single-seat routes; these stay the operator's.
 */
export function bulkRestoreRefusal(transportSession: string | null | undefined): { ok: false; code: "recovery_restart_refused"; message: string } | null {
  const agent = agentIdentity(transportSession);
  return agent
    ? {
        ok: false,
        code: "recovery_restart_refused",
        message: `Bulk restore refused for agent '${agent}': agents recover one seat at a time through the guarded seat launch (restart safety rules); bulk and fleet restores are the operator's.`,
      }
    : null;
}

export function checkRecoveryRestart(
  db: Database.Database,
  input: { caller: string | null | undefined; target: RecoveryTarget; evidence?: RecoveryEvidence | null },
  config: RecoveryGuardConfig = recoveryGuardConfig(),
  now: () => Date = () => new Date(),
): RecoveryDecision {
  const identity = agentIdentity(input.caller);
  if (!identity) return { allowed: true, caller: "operator" };

  const ev = input.evidence ?? {};
  const reasons: string[] = [];
  // Arete guards a + b: failure evidence and where it lives (durable, not a local brief file)
  if (!ev.failureEvidence?.trim()) reasons.push("failure evidence required: say what failed (evidence.failureEvidence)");
  if (!ev.evidenceRef?.trim()) reasons.push("evidence reference required: a queue item, watchdog history or log (evidence.evidenceRef)");
  // guard c: hard retry cap, counted from durable authorizations of this seat in the window
  const since = new Date(now().getTime() - config.windowHours * 3600_000).toISOString().replace("T", " ").slice(0, 19);
  const restarts = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE type = ? AND node_id = ? AND created_at >= ?`)
      .get(RECOVERY_EVENT, input.target.nodeId, since) as { n: number }
  ).n;
  if (restarts >= config.retryCap) {
    reasons.push(`hard retry cap reached: ${restarts} recovery restart(s) of this seat in ${config.windowHours}h >= ${config.retryCap}; a human decides now`);
  }
  // guard d: health consulted first
  if (ev.healthConsulted !== true) reasons.push("provider/seat health must be consulted before a recovery restart (evidence.healthConsulted)");
  // guard e (resume-from-state): the seat holds work to resume — the durable queue binding
  const open = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = ? AND state IN ('pending','in-progress','blocked')`)
      .get(input.target.sessionName) as { n: number }
  ).n;
  if (open === 0) reasons.push("nothing to resume: the seat holds no open queue work (a recovery restart resumes bound work)");
  // Rust: protected seats
  if (input.target.role && config.protectedRoles.includes(input.target.role)) {
    reasons.push(`protected seat: role '${input.target.role}' is never restarted by an agent (OPENRIG_PROTECTED_ROLES)`);
  }
  // Rust: caller scope, by node identity and delegates_to edges
  if (!config.recoveryCallers.includes(identity)) {
    const callerNode = resolveSessionNodeId(db, identity);
    if (!callerNode) reasons.push(`unknown caller '${identity}': not a seat and not in OPENRIG_RECOVERY_CALLERS`);
    else if (callerNode === input.target.nodeId) reasons.push("a seat may not recovery-restart itself");
    else if (!orchestrates(db, callerNode, input.target.nodeId)) {
      reasons.push(`out of scope: '${identity}' does not orchestrate this seat (no delegates_to path)`);
    }
  }
  return reasons.length ? { allowed: false, identity, reasons } : { allowed: true, caller: "agent", identity };
}
