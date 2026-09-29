// Roadmap 3.1 — the Arete silence watchdog as ONE injected policy on the OpenRig
// scheduler (the owner's call ⚑2: O engine + Arete classifier, no second timer).
//
// One job per seat. It watches the seat's CLAIMED Arete step work (queue items
// tagged `arete-step:*` by default — the Phase 2 run<->queue binding) and joins:
//   - the shared arbitrated SeatActivityService verdict (never acts on unknown,
//     never drives a seat that needs input),
//   - how long the seat has been idle (a grace period before any action),
//   - provider evidence (a used-up usage window pauses instead of nudging),
//   - how many times this job already nudged the seat in this idle episode,
// and asks the ported classifier (domain/silence-classifier.ts) what to do:
//   pause    -> skip (recorded with the classification)
//   nudge    -> one wake into the seat (the engine's active-wake throttle spaces them)
//   escalate -> one durable queue item to a human seat per idle episode
//               (idempotent id), never a nudge.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SeatActivityService } from "../seat-activity-service.js";
import { decideSilence, type SilenceHealth } from "../silence-classifier.js";
import { seatProviderHealth } from "../provider/provider-policy.js";
import type { ProviderSignal } from "../provider/provider-types.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

export interface SilenceEscalation {
  qitemId: string;
  sourceSession: string;
  destination: string | undefined;
  seat: string;
  body: string;
  summary: string;
  evidenceRef: string;
}

export interface SilenceClassifierDeps {
  db: Database.Database;
  seatActivity: Pick<SeatActivityService, "getSeatStateBySession">;
  /** Provider evidence for the seat; absent or failing = healthy (never blocks the watchdog). */
  healthOf?: (seat: string) => Promise<SilenceHealth>;
  /** Create (or find) the escalation item; `destination` undefined = the operator's human seat. */
  escalate: (e: SilenceEscalation) => Promise<{ qitemId: string }>;
  now?: () => Date;
}

const HEALTHY: SilenceHealth = { recentFailureCount: 0, permanentlyUnhealthy: false };

const num = (v: unknown, dflt: number, min: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min ? n : dflt;
};

interface OpenRow {
  qitem_id: string;
  state: string;
}

export function makeSilenceClassifierPolicy(deps: SilenceClassifierDeps): Policy {
  const now = deps.now ?? (() => new Date());
  return {
    name: "silence-classifier",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const seat = job.target.session;
      const ctx = job.context ?? {};
      const stallSeconds = num(ctx.stallSeconds, 900, 60);
      const nudgeLimit = num(ctx.nudgeLimit, 3, 0);
      const maxNudges = num(ctx.maxNudges, 3, 0);
      const tagPrefix = typeof ctx.tagPrefix === "string" && ctx.tagPrefix ? ctx.tagPrefix : "arete-step:";
      const escalateTo = typeof ctx.escalateTo === "string" && ctx.escalateTo.trim() ? ctx.escalateTo.trim() : undefined;

      // The seat's claimed work that this watchdog owns (default: Arete workflow steps).
      const open = deps.db
        .prepare(
          `SELECT qitem_id, state FROM queue_items
             WHERE destination_session = ? AND state IN ('in-progress','blocked')
               AND json_valid(tags)
               AND EXISTS (SELECT 1 FROM json_each(tags) WHERE substr(value, 1, ?) = ?)
             ORDER BY ts_created ASC`,
        )
        .all(seat, tagPrefix.length, tagPrefix) as OpenRow[];
      if (open.length === 0) return { action: "skip", reason: "no_open_work" };

      const activity = deps.seatActivity.getSeatStateBySession(seat);
      if (!activity || activity.activity === "unknown") {
        return { action: "skip", reason: "activity_stale_unknown", notes: { seat } };
      }
      if (activity.activity !== "idle-at-prompt") return { action: "skip", reason: "seat_active", notes: { seat } };

      const idleSince = activity.changedAt;
      const idleSeconds = Math.floor((now().getTime() - Date.parse(idleSince)) / 1000);
      if (!(idleSeconds >= stallSeconds)) {
        return { action: "skip", reason: "within_grace", notes: { seat, idleSeconds, stallSeconds } };
      }

      // A seat waiting on a prompt, or whose only work is parked, is legitimately blocked.
      const blocked = activity.needsInput.count > 0 || open.every((r) => r.state === "blocked");
      const health = deps.healthOf ? await deps.healthOf(seat).catch(() => HEALTHY) : HEALTHY;
      // This idle episode's nudges: DELIVERED sends by THIS job since the seat went idle — a failed
      // delivery is not a nudge the seat ignored, and the count is unbounded (no history window),
      // so later skips can never push old nudges out and restart the ladder.
      const nudgeCount = (
        deps.db
          .prepare(
            `SELECT COUNT(*) AS n FROM watchdog_history
               WHERE job_id = ? AND outcome = 'sent' AND delivery_status = 'ok' AND evaluated_at >= ?`,
          )
          .get(job.jobId, idleSince) as { n: number }
      ).n;

      const decision = decideSilence(
        { status: blocked ? "blocked" : "idle" },
        health,
        { isDormant: false },
        nudgeCount,
        { nudgeLimit, maxNudges },
      );
      const qitemIds = open.map((r) => r.qitem_id);
      const notes = {
        seat,
        classification: decision.classification,
        idleSeconds,
        nudgeCount,
        openWork: qitemIds,
        activityDecidedBy: activity.decidedBy,
        ...(activity.needsInput.count > 0 ? { needsInput: activity.needsInput.reason } : {}),
        ...(health.lastFailureClass ? { providerFailure: health.lastFailureClass } : {}),
      };

      if (decision.kind === "pause") return { action: "skip", reason: `paused_${decision.classification}`, notes };

      if (decision.kind === "nudge") {
        return {
          action: "send",
          target: { session: seat },
          message:
            job.message ??
            [
              `Watchdog (nudge ${decision.nudgeNumber}/${maxNudges}): you (${seat}) hold open work ${qitemIds.join(", ")} and have been idle for ${Math.round(idleSeconds / 60)} min.`,
              "Carry on with it, or close it (done with evidence) or hand it off if you cannot finish. If you are blocked, say so in the item.",
            ].join("\n"),
          notes: { ...notes, nudgeNumber: decision.nudgeNumber },
        };
      }

      // escalate: one durable item per idle episode (idempotent id), never a nudge
      const qitemId = `watchdog-stall-${createHash("sha256").update(JSON.stringify([seat, idleSince])).digest("hex").slice(0, 24)}`;
      const summary = `${seat} stalled: ${decision.reason} (idle ${Math.round(idleSeconds / 60)} min, ${nudgeCount} nudge(s))`;
      try {
        const created = await deps.escalate({
          qitemId,
          sourceSession: job.registeredBySession,
          destination: escalateTo,
          seat,
          summary,
          evidenceRef: `rig watchdog history ${job.jobId}`,
          body: [
            `WATCHDOG ESCALATION (${decision.classification}; target: ${decision.target})`,
            `seat: ${seat} — idle since ${idleSince} (${idleSeconds}s), nudged ${nudgeCount} time(s)`,
            `open work: ${qitemIds.join(", ")}`,
            ...(health.lastFailureClass ? [`provider: ${health.lastFailureClass}`] : []),
            `reason: ${decision.reason}`,
            "resolve: look at the seat and its open work; restart, reassign or cancel it. Seat idleness alone does not prove the work is lost.",
          ].join("\n"),
        });
        return { action: "skip", reason: `escalated_${decision.target}`, notes: { ...notes, escalation: created.qitemId } };
      } catch (err) {
        // visible in watchdog history; retried on the next due evaluation
        return { action: "skip", reason: "escalation_failed", notes: { ...notes, error: (err as Error).message } };
      }
    },
  };
}

/**
 * Provider evidence -> classifier health, via the shared 3.5 calculation (`seatProviderHealth`):
 * a seat with FRESH, eligible limit evidence is `rate_limit` (the classifier pauses instead of
 * nudging); stale, advisory or missing evidence is not a limit. The read model is cached for
 * `ttlMs` so a tick over many seats costs one read.
 */
export function providerHealthFrom(
  getReadModel: () => Promise<{
    bindings: Array<{ accountId: string | null; seatSession?: string }>;
    signals: ProviderSignal[];
  }>,
  opts: { ttlMs?: number; now?: () => number } = {},
): (seat: string) => Promise<SilenceHealth> {
  const now = opts.now ?? Date.now;
  let cached: { at: number; model: ReturnType<typeof getReadModel> } | null = null;
  return async (seat) => {
    if (!cached || now() - cached.at > (opts.ttlMs ?? 60_000)) cached = { at: now(), model: getReadModel() };
    const model = await cached.model.catch((err) => {
      cached = null; // do not cache a failure
      throw err;
    });
    const h = seatProviderHealth(model, seat, new Date(now()).toISOString());
    // an exhausted window whose reset cannot be proven is not a reason to nudge an idle seat either:
    // it pauses like a limit (the seat may well be rate-limited), it just never justifies a switch
    const exhausted = h.verdict === "limited" || h.reasons.includes("exhausted_window_without_future_reset");
    return exhausted
      ? { recentFailureCount: Math.max(1, h.recentFailures), permanentlyUnhealthy: false, lastFailureClass: "rate_limit" }
      : HEALTHY;
  };
}
