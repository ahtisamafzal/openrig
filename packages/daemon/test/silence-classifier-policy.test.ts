import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { idleGateFiredConditionSchema } from "../src/db/migrations/078_idle_gate_fired_condition.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { classifySilence, decideSilence } from "../src/domain/silence-classifier.js";
import { makeSilenceClassifierPolicy, providerHealthFrom, type SilenceEscalation } from "../src/domain/policies/silence-classifier.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

// Roadmap 3.1 — the Arete silence classifier as an injected OpenRig watchdog policy.

const IDLE_SINCE = "2026-09-29T10:00:00.000Z";
const T0 = new Date("2026-09-29T10:20:00.000Z"); // 20 min idle
const SEAT = "dev@arete-rig";
const HEALTHY = { recentFailureCount: 0, permanentlyUnhealthy: false };

describe("silence classifier (ported from Arete, order is load-bearing)", () => {
  const cfg = { nudgeLimit: 3, maxNudges: 3 };
  it("blocked/compacting and provider health win over any nudge", () => {
    expect(classifySilence({ status: "blocked" }, { ...HEALTHY, permanentlyUnhealthy: true }, { isDormant: false }, 0, cfg).classification).toBe("compaction");
    expect(classifySilence({ customStatus: "compacting" }, HEALTHY, { isDormant: false }, 0, cfg).classification).toBe("compaction");
    expect(classifySilence({}, { ...HEALTHY, permanentlyUnhealthy: true }, { isDormant: false }, 0, cfg)).toEqual({
      classification: "provider_failure",
      action: { kind: "escalate", target: "lead" },
    });
    expect(classifySilence({}, { ...HEALTHY, lastFailureClass: "rate_limit" }, { isDormant: false }, 0, cfg).classification).toBe("transient");
    expect(classifySilence({}, HEALTHY, { isDormant: true }, 0, cfg).classification).toBe("dormant");
  });
  it("genuine stall climbs the nudge ladder, then escalates", () => {
    expect(decideSilence({}, HEALTHY, { isDormant: false }, 0, cfg)).toEqual({ kind: "nudge", classification: "genuine_stall", nudgeNumber: 1 });
    expect(decideSilence({}, HEALTHY, { isDormant: false }, 2, cfg)).toEqual({ kind: "nudge", classification: "genuine_stall", nudgeNumber: 3 });
    expect(decideSilence({}, HEALTHY, { isDormant: false }, 3, cfg)).toMatchObject({ kind: "escalate", target: "lead", classification: "unknown" });
    // a hard cap below the classifier's limit hands off to a human
    expect(decideSilence({}, HEALTHY, { isDormant: false }, 1, { nudgeLimit: 3, maxNudges: 1 })).toMatchObject({ kind: "escalate", target: "human" });
  });
});

describe("silence-classifier policy (roadmap 3.1)", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let oracle: ArbitratedSeatState | null;
  let clock: Date;
  let escalations: SilenceEscalation[];
  const seatActivity = { getSeatStateBySession: () => oracle };

  function setOracle(activity: ArbitratedSeatState["activity"], needsInput: ArbitratedSeatState["needsInput"] = { count: 0, reason: null }, changedAt = IDLE_SINCE): void {
    oracle = { seatNodeId: "n1", activity, needsInput, decidedBy: "lifecycle-hooks", seq: 1, changedAt, rungs: [], lastSwap: null };
  }
  function seedItem(id: string, state = "in-progress", tags: string[] = [`arete-step:k-${id}`]): void {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
       VALUES (?, '2026-09-29T09:00:00Z', '2026-09-29T09:00:00Z', 'arete@arete', ?, ?, 'routine', NULL, ?, 'implement the fix')`,
    ).run(id, SEAT, state, JSON.stringify(tags));
  }
  const job = (over: Partial<PolicyJob> = {}): PolicyJob => ({
    jobId: "job-s",
    policy: "silence-classifier",
    target: { session: SEAT },
    intervalSeconds: 60,
    activeWakeIntervalSeconds: 600,
    scanIntervalSeconds: null,
    context: {},
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "arete@arete-rig",
    registeredAt: "2026-09-29T08:00:00.000Z",
    watchedFilePath: null,
    thresholdBytes: null,
    requiresJobId: null,
    lastFiredGeneration: null,
    occupantGeneration: null,
    currentGenerationTranscriptPending: false,
    requiredReceiptSatisfied: true,
    requiredReceiptDeferred: false,
    ...over,
  });
  /** A registered job (watchdog history rows reference it). */
  const realJob = (): string =>
    new WatchdogJobsRepository(db).register({
      policy: "silence-classifier",
      specYaml: `policy: silence-classifier
target:
  session: ${SEAT}
interval_seconds: 60
`,
      targetSession: SEAT,
      intervalSeconds: 60,
      registeredBySession: "arete@arete-rig",
    }).jobId;
  const policy = (over: Partial<Parameters<typeof makeSilenceClassifierPolicy>[0]> = {}) =>
    makeSilenceClassifierPolicy({
      db,
      seatActivity,
      history: new WatchdogHistoryLog(db),
      escalate: async (e) => {
        escalations.push(e);
        return { qitemId: e.qitemId };
      },
      now: () => clock,
      ...over,
    });

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [watchdogJobsSchema, watchdogHistorySchema, idleGateFiredConditionSchema]);
    eventBus = new EventBus(db);
    oracle = null;
    clock = T0;
    escalations = [];
  });
  afterEach(() => db.close());

  it("watches only claimed Arete step work: none -> skip, other work ignored", async () => {
    setOracle("idle-at-prompt");
    expect(await policy().evaluate(job())).toEqual({ action: "skip", reason: "no_open_work" });
    seedItem("q-other", "in-progress", ["gate:guard"]);
    seedItem("q-pending", "pending");
    expect(await policy().evaluate(job())).toEqual({ action: "skip", reason: "no_open_work" });
  });

  it("never acts on an active or unknown seat, nor inside the grace period", async () => {
    seedItem("q1");
    setOracle("working");
    expect((await policy().evaluate(job())).action === "skip" && (await policy().evaluate(job()))).toMatchObject({ reason: "seat_active" });
    setOracle("unknown");
    expect(await policy().evaluate(job())).toMatchObject({ reason: "activity_stale_unknown" });
    oracle = null;
    expect(await policy().evaluate(job())).toMatchObject({ reason: "activity_stale_unknown" });
    setOracle("idle-at-prompt", { count: 0, reason: null }, "2026-09-29T10:15:00.000Z"); // 5 min idle < 15 min default
    expect(await policy().evaluate(job())).toMatchObject({ reason: "within_grace" });
  });

  it("a seat waiting on a prompt, or whose work is all parked, is paused (compaction), never nudged", async () => {
    seedItem("q1");
    setOracle("idle-at-prompt", { count: 1, reason: "permission prompt" });
    expect(await policy().evaluate(job())).toMatchObject({ action: "skip", reason: "paused_compaction" });
    db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = 'q1'").run();
    setOracle("idle-at-prompt");
    expect(await policy().evaluate(job())).toMatchObject({ action: "skip", reason: "paused_compaction" });
  });

  it("a used-up provider window pauses (transient); a hard provider failure escalates, never nudges", async () => {
    seedItem("q1");
    setOracle("idle-at-prompt");
    const limited = policy({ healthOf: async () => ({ recentFailureCount: 1, permanentlyUnhealthy: false, lastFailureClass: "rate_limit" }) });
    expect(await limited.evaluate(job())).toMatchObject({ action: "skip", reason: "paused_transient", notes: { providerFailure: "rate_limit" } });
    const down = policy({ healthOf: async () => ({ recentFailureCount: 5, permanentlyUnhealthy: true }) });
    expect(await down.evaluate(job())).toMatchObject({ action: "skip", reason: "escalated_lead" });
    expect(escalations).toHaveLength(1);
    // a failing health read never blocks the watchdog: treated as healthy -> nudge
    const broken = policy({ healthOf: async () => { throw new Error("collector down"); } });
    expect((await broken.evaluate(job())).action).toBe("send");
  });

  it("genuine stall -> nudge naming the open work; the ladder counts only this idle episode's sends", async () => {
    seedItem("q1");
    setOracle("idle-at-prompt");
    const out = await policy().evaluate(job());
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target.session).toBe(SEAT);
    expect(out.message).toContain("q1");
    expect(out.message).toContain("nudge 1/3");
    // sends from an EARLIER idle episode do not count
    const jobId = realJob();
    const history = new WatchdogHistoryLog(db);
    history.record({ jobId, evaluatedAt: "2026-09-29T09:00:00.000Z", outcome: "sent" });
    history.record({ jobId, evaluatedAt: "2026-09-29T10:05:00.000Z", outcome: "sent" });
    const next = await policy().evaluate(job({ jobId }));
    expect(next.action === "send" && next.message).toContain("nudge 2/3");
  });

  it("escalation: one idempotent item per idle episode, to escalateTo when set", async () => {
    seedItem("q1");
    setOracle("idle-at-prompt");
    const jobId = realJob();
    const history = new WatchdogHistoryLog(db);
    for (const m of [1, 2, 3]) history.record({ jobId, evaluatedAt: `2026-09-29T10:0${m}:00.000Z`, outcome: "sent" });
    const p = policy();
    const a = await p.evaluate(job({ jobId, context: { escalateTo: "human-ops@host" } }));
    const b = await p.evaluate(job({ jobId, context: { escalateTo: "human-ops@host" } }));
    expect(a).toMatchObject({ action: "skip", reason: "escalated_lead" });
    expect(escalations.map((e) => e.qitemId)).toEqual([escalations[0]!.qitemId, escalations[0]!.qitemId]); // same id both times
    expect(escalations[0]).toMatchObject({ destination: "human-ops@host", seat: SEAT, sourceSession: "arete@arete-rig" });
    expect(escalations[0]!.body).toContain("q1");
    expect(b).toMatchObject({ reason: "escalated_lead" });
    // a new idle episode is a new escalation id
    setOracle("idle-at-prompt", { count: 0, reason: null }, "2026-09-29T09:30:00.000Z");
    await p.evaluate(job({ jobId }));
    expect(escalations[2]!.qitemId).not.toBe(escalations[0]!.qitemId);
    // an escalation that cannot be created is visible, not swallowed
    const failing = policy({ escalate: async () => { throw new Error("no human seat configured"); } });
    expect(await failing.evaluate(job({ jobId }))).toMatchObject({ reason: "escalation_failed", notes: { error: "no human seat configured" } });
  });

  it("through the ENGINE: three real nudges, spaced by the active-wake throttle, then one escalation and no more nudges", async () => {
    seedItem("q1");
    setOracle("idle-at-prompt");
    const jobsRepo = new WatchdogJobsRepository(db);
    const historyLog = new WatchdogHistoryLog(db);
    const sends: string[] = [];
    const deliver: DeliveryFn = async (req) => {
      sends.push(req.message);
      return { status: "ok" };
    };
    const engine = new WatchdogPolicyEngine({
      jobsRepo, historyLog, eventBus, deliver, now: () => clock,
      additionalPolicies: [policy({ history: historyLog })],
    });
    const registered = jobsRepo.register({
      policy: "silence-classifier",
      specYaml: `policy: silence-classifier\ntarget:\n  session: ${SEAT}\ninterval_seconds: 60\n`,
      targetSession: SEAT,
      intervalSeconds: 60,
      activeWakeIntervalSeconds: 600,
      registeredBySession: "arete@arete-rig",
    });
    for (let i = 0; i < 12; i++) {
      await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
      clock = new Date(clock.getTime() + 5 * 60_000); // every 5 min
    }
    expect(sends).toHaveLength(3);
    expect(sends.map((m) => /nudge (\d)\/3/.exec(m)?.[1])).toEqual(["1", "2", "3"]);
    expect(new Set(escalations.map((e) => e.qitemId)).size).toBe(1);
  });
});

describe("provider evidence -> health", () => {
  const model = (usedPercent: number, resetsAt?: string) => async () => ({
    bindings: [{ accountId: "acct-1", seatSession: SEAT }],
    signals: [{ accountRef: "acct-1", usedPercent, ...(resetsAt ? { resetsAt } : {}) }],
  });
  const now = () => Date.parse("2026-09-29T10:00:00.000Z");
  it("an exhausted window (not yet reset) on the seat's account is rate_limit; otherwise healthy", async () => {
    expect(await providerHealthFrom(model(100, "2026-09-29T12:00:00.000Z"), { now })(SEAT)).toMatchObject({ lastFailureClass: "rate_limit" });
    expect(await providerHealthFrom(model(100, "2026-09-29T09:00:00.000Z"), { now })(SEAT)).toEqual(HEALTHY); // already reset
    expect(await providerHealthFrom(model(80), { now })(SEAT)).toEqual(HEALTHY);
    expect(await providerHealthFrom(model(100), { now })("other@rig")).toEqual(HEALTHY);
  });
  it("reads the provider model once per ttl, and never caches a failure", async () => {
    let reads = 0;
    let fail = true;
    const get = async () => {
      reads++;
      if (fail) throw new Error("boom");
      return { bindings: [], signals: [] };
    };
    const health = providerHealthFrom(get, { now, ttlMs: 60_000 });
    await expect(health(SEAT)).rejects.toThrow("boom");
    fail = false;
    await health(SEAT);
    await health(SEAT);
    expect(reads).toBe(2);
  });
});
