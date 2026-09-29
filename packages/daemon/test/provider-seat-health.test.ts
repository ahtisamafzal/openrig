import { describe, it, expect } from "vitest";
import { seatProviderHealth } from "../src/domain/provider/provider-policy.js";
import type { ProviderSignal } from "../src/domain/provider/provider-types.js";

// Roadmap 3.5 — the shared, time-bounded seat health. Only fresh, eligible evidence can say
// limited/healthy; stale/advisory/missing evidence is `unknown` (never a reason to switch).

const NOW = "2026-09-29T10:00:00.000Z";
const SEAT = "dev@rig";
const sig = (over: Partial<ProviderSignal> = {}): ProviderSignal => ({
  provider: "codex",
  accountRef: "acct-1",
  sourceClass: "provider_structured_read",
  authority: "account_cross_device",
  asOf: "2026-09-29T09:59:00.000Z",
  staleAfter: "2026-09-29T10:05:00.000Z",
  automationUse: "allow_switch_decision",
  ...over,
});
const model = (...signals: ProviderSignal[]) => ({ bindings: [{ accountId: "acct-1", seatSession: SEAT }], signals });

describe("seatProviderHealth", () => {
  it("fresh exhausted window -> limited until its reset", () => {
    const h = seatProviderHealth(model(sig({ usedPercent: 100, resetsAt: "2026-09-29T12:00:00.000Z" })), SEAT, NOW);
    expect(h).toMatchObject({ verdict: "limited", limitedUntil: "2026-09-29T12:00:00.000Z", reasons: [] });
  });
  it("fresh window below the limit, or already reset -> healthy", () => {
    expect(seatProviderHealth(model(sig({ usedPercent: 40 })), SEAT, NOW).verdict).toBe("healthy");
    expect(seatProviderHealth(model(sig({ usedPercent: 100, resetsAt: "2026-09-29T09:00:00.000Z" })), SEAT, NOW).verdict).toBe("healthy");
  });
  it("stale, advisory or unknown evidence -> unknown, even when it says exhausted", () => {
    const stale = seatProviderHealth(model(sig({ usedPercent: 100, staleAfter: "2026-09-29T10:00:00.000Z" })), SEAT, NOW); // inclusive expiry
    expect(stale).toMatchObject({ verdict: "unknown", reasons: ["no_fresh_eligible_evidence"] });
    expect(stale.evidence[0]!.refusals).toContain("stale");
    expect(seatProviderHealth(model(sig({ usedPercent: 100, automationUse: "advisory_only" })), SEAT, NOW).verdict).toBe("unknown");
    expect(seatProviderHealth(model(sig({ usedPercent: 100, sourceClass: "unknown" })), SEAT, NOW).verdict).toBe("unknown");
  });
  it("no evidence for the seat -> unknown (no_signals); another seat's evidence does not count", () => {
    expect(seatProviderHealth(model(sig({ usedPercent: 100 })), "other@rig", NOW)).toMatchObject({ verdict: "unknown", reasons: ["no_signals"] });
  });
  it("a fresh at_limit reactive event -> limited until it goes stale; advisory errors only count as recent failures", () => {
    const atLimit = sig({ sourceClass: "provider_event", authority: "reactive_error", staleAfter: "2026-09-29T10:10:00.000Z" });
    const advisory = sig({ sourceClass: "provider_event", authority: "reactive_error", automationUse: "advisory_only" });
    const oldEvent = sig({ sourceClass: "provider_event", authority: "reactive_error", staleAfter: "2026-09-29T09:00:00.000Z" });
    const h = seatProviderHealth(model(atLimit, advisory, oldEvent), SEAT, NOW);
    expect(h).toMatchObject({ verdict: "limited", limitedUntil: "2026-09-29T10:10:00.000Z", recentFailures: 2 }); // the stale one is not counted
    const onlyAdvisory = seatProviderHealth(model(advisory, sig({ usedPercent: 10 })), SEAT, NOW);
    expect(onlyAdvisory).toMatchObject({ verdict: "healthy", recentFailures: 1 });
  });
  it("an unparsable clock proves nothing -> unknown", () => {
    expect(seatProviderHealth(model(sig({ usedPercent: 100 })), SEAT, "not-a-time").verdict).toBe("unknown");
  });
  it("seat-keyed evidence (no account binding) counts for that seat", () => {
    const h = seatProviderHealth(
      { bindings: [], signals: [sig({ accountRef: undefined, seatSession: SEAT, sourceClass: "provider_statusline", usedPercent: 100, resetsAt: "2026-09-29T11:00:00.000Z" })] },
      SEAT,
      NOW,
    );
    expect(h.verdict).toBe("limited");
  });
});
