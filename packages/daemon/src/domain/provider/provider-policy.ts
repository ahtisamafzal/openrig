// Slice-04 (OPR.0.5.0.4) — BR-2, the no-fire policy predicate (packet 3ffa3c22 §2 + BR-2).
// A PURE predicate (no side effects, no action execution, no orchestration): it only decides
// whether one signal is eligible to trigger an automated switch. Automation NEVER fires on a
// signal that is unknown, not allow_switch_decision, or not provably fresh. Every failing
// condition contributes an explicit, fail-visible refusal reason.

import type {
  AccountAuthState,
  PrecheckReason,
  PrecheckResult,
  ProviderKind,
  ProviderSignal,
} from "./provider-types.js";

export type AutomationRefusal =
  | "sourceClass_unknown"
  | "authority_unknown"
  | "not_allow_switch_decision"
  | "no_freshness_bound"
  | "unparsable_freshness_bound"
  | "stale"
  // 3.5: evidence must already have happened — an unparsable or future `asOf` (clock skew, a
  // malformed producer) cannot prove anything about now
  | "unparsable_as_of"
  | "future_as_of";

export interface AutomationEligibility {
  eligible: boolean;
  refusals: AutomationRefusal[];
}

/**
 * BR-2 eligibility. Eligible ONLY when the signal is known (source + authority), explicitly
 * `allow_switch_decision`, and provably fresh. Fail-closed on freshness: a missing `staleAfter`
 * or an unparsable one is ineligible (NaN must never compare as fresh). Expiry is INCLUSIVE:
 * `now >= staleAfter` is stale. An unparsable `now` also cannot prove freshness → stale.
 */
export function signalEligibleForAutomation(
  signal: ProviderSignal,
  nowIso: string,
): AutomationEligibility {
  const refusals: AutomationRefusal[] = [];

  if (signal.sourceClass === "unknown") refusals.push("sourceClass_unknown");
  if (signal.authority === "unknown") refusals.push("authority_unknown");
  if (signal.automationUse !== "allow_switch_decision") refusals.push("not_allow_switch_decision");

  if (signal.staleAfter === undefined) {
    refusals.push("no_freshness_bound");
  } else {
    const staleMs = Date.parse(signal.staleAfter);
    if (Number.isNaN(staleMs)) {
      refusals.push("unparsable_freshness_bound");
    } else {
      const nowMs = Date.parse(nowIso);
      // Fail-closed: an unparsable `now`, or reaching/passing the bound, is stale.
      if (Number.isNaN(nowMs) || nowMs >= staleMs) refusals.push("stale");
    }
  }

  const asOfMs = Date.parse(signal.asOf);
  if (Number.isNaN(asOfMs)) refusals.push("unparsable_as_of");
  else {
    const nowMs = Date.parse(nowIso);
    if (Number.isNaN(nowMs) || asOfMs > nowMs) refusals.push("future_as_of");
  }

  return { eligible: refusals.length === 0, refusals };
}

// ── Seat provider health (roadmap 3.5) ──────────────────────────────────────────────────
// ONE time-bounded health calculation per seat, shared by the silence classifier (3.1) and by
// Arete's pre-dispatch / failover decisions (3.3/3.5). Only evidence that passes BR-2 eligibility
// (known, allow_switch_decision, provably fresh) can say `limited` or `healthy`; with no such
// evidence the verdict is `unknown` — and unknown never justifies switching away from a seat.

export type SeatHealthVerdict = "limited" | "healthy" | "unknown";

export interface SeatProviderHealth {
  seat: string;
  verdict: SeatHealthVerdict;
  /** When `limited`: the latest instant any limiting evidence says the limit lasts until. */
  limitedUntil?: string;
  /** Why the verdict is `unknown` (`no_signals` | `no_fresh_eligible_evidence`). */
  reasons: string[];
  /** Fresh reactive error events for the seat (advisory ones included): time-bounded by their
   *  freshness, so old failures never count (the Rust ledger's all-history flaw is not ported). */
  recentFailures: number;
  evidence: Array<{
    sourceClass: string;
    authority: string;
    window?: string;
    usedPercent?: number;
    resetsAt?: string;
    asOf: string;
    staleAfter?: string;
    eligible: boolean;
    refusals: AutomationRefusal[];
  }>;
  asOf: string;
}

type HealthModel = {
  bindings: Array<{ accountId: string | null; seatSession?: string }>;
  signals: ProviderSignal[];
};

export function seatProviderHealth(model: HealthModel, seat: string, nowIso: string): SeatProviderHealth {
  const nowMs = Date.parse(nowIso);
  const account = model.bindings.find((b) => b.seatSession === seat)?.accountId ?? null;
  const relevant = model.signals.filter((s) => s.seatSession === seat || (account !== null && s.accountRef === account));
  const evidence: SeatProviderHealth["evidence"] = [];
  let eligibleCount = 0;
  let limitedUntil: string | undefined;
  let limited = false;
  // an eligible exhausted window whose recovery cannot be proven: the seat can never be `healthy`
  let indeterminate = false;
  let recentFailures = 0;
  for (const s of relevant) {
    const el = signalEligibleForAutomation(s, nowIso);
    evidence.push({
      sourceClass: s.sourceClass,
      authority: s.authority,
      ...(s.window !== undefined ? { window: String(s.window) } : {}),
      ...(s.usedPercent !== undefined ? { usedPercent: s.usedPercent } : {}),
      ...(s.resetsAt !== undefined ? { resetsAt: s.resetsAt } : {}),
      asOf: s.asOf,
      ...(s.staleAfter !== undefined ? { staleAfter: s.staleAfter } : {}),
      eligible: el.eligible,
      refusals: el.refusals,
    });
    const reactive = s.sourceClass === "provider_event" && s.authority === "reactive_error";
    if (reactive && s.staleAfter && Date.parse(s.staleAfter) > nowMs) recentFailures++;
    if (!el.eligible) continue;
    let until: string | undefined;
    if (reactive) {
      until = s.staleAfter; // at-limit exhaustion, known only until the event goes stale
    } else if (typeof s.usedPercent === "number" && s.usedPercent >= 100) {
      // an exhausted window is authority only with a parseable reset still ahead; a missing,
      // malformed or passed reset says nothing either way (never limited, never healthy)
      const resetMs = s.resetsAt ? Date.parse(s.resetsAt) : NaN;
      if (!Number.isNaN(resetMs) && resetMs <= nowMs && Date.parse(s.asOf) < resetMs) continue; // sampled before a reset that has since happened: that window is over
      if (Number.isNaN(resetMs) || resetMs <= nowMs) {
        indeterminate = true; // no reset, a malformed one, or exhausted even after its reset: unprovable
        continue;
      }
      until = s.resetsAt;
    } else {
      eligibleCount++; // fresh, below the limit
      continue;
    }
    eligibleCount++;
    limited = true;
    if (until && (!limitedUntil || Date.parse(until) > Date.parse(limitedUntil))) limitedUntil = until;
  }
  const verdict: SeatHealthVerdict = limited ? "limited" : !indeterminate && eligibleCount > 0 ? "healthy" : "unknown";
  const reasons =
    verdict !== "unknown"
      ? []
      : relevant.length === 0
        ? ["no_signals"]
        : indeterminate
          ? ["exhausted_window_without_future_reset"]
          : ["no_fresh_eligible_evidence"];
  return { seat, verdict, ...(limitedUntil ? { limitedUntil } : {}), reasons, recentFailures, evidence, asOf: nowIso };
}

// ── Precheck: the §1 switch-safety gate ─────────────────────────────────────────────────
// precheckSwitch decides whether switching a seat to a target account is SAFE, so the UI and
// automation never offer an unsafe action. Every unsafe condition is an explicit, fail-visible
// reason; reasons combine deterministically. A pure predicate — no side effects.

// The subset of BR-2 refusals that mean the triggering signal is unknown/stale (as opposed to
// merely advisory, which is a BR-2 concern, not a precheck unknown/stale concern).
const SIGNAL_UNKNOWN_OR_STALE_REFUSALS: readonly AutomationRefusal[] = [
  "sourceClass_unknown",
  "authority_unknown",
  "no_freshness_bound",
  "unparsable_freshness_bound",
  "stale",
  "unparsable_as_of",
  "future_as_of",
];

/** Fields common to a manual and an automated precheck. */
interface PrecheckBase {
  /** The provider of the account being switched TO. */
  targetProvider: ProviderKind;
  /** Validate-at-use: the target's auth state, checked at precheck time (never assumed). */
  targetAuthState: AccountAuthState;
  /** Whether the seat currently has a live turn/conversation in flight. */
  seatHasLiveConversation: boolean;
}

/**
 * A manual precheck carries NEITHER a triggering signal nor a clock; an automated precheck
 * requires BOTH. The paired union makes "trigger without now" unrepresentable for typed
 * callers (the fail-closed hole is closed at the type level; a runtime guard below covers
 * untyped/JS callers).
 */
export type PrecheckInput = PrecheckBase &
  ({ triggeringSignal?: undefined; now?: undefined } | { triggeringSignal: ProviderSignal; now: string });

export function precheckSwitch(input: PrecheckInput): PrecheckResult {
  const reasons: PrecheckReason[] = [];

  // rig auth is codex-only at the current switch substrate → a claude target can't be rebound.
  if (input.targetProvider === "claude") reasons.push("rebind_unsupported_for_runtime");

  // Validate-at-use: only a confirmed-active target is safe. needs_reauth and unknown each fail
  // closed under their OWN reason — unknown is never relabeled as a re-auth need.
  if (input.targetAuthState === "needs_reauth") reasons.push("target_needs_reauth");
  else if (input.targetAuthState === "unknown") reasons.push("target_auth_unknown");

  if (input.seatHasLiveConversation) reasons.push("would_strand_live_conversation");

  // A triggering signal is present ONLY for an automated switch. Fail-closed for untyped/JS
  // callers: if `now` is missing or unparsable it CANNOT prove freshness — the shared predicate
  // maps an unparsable/absent now to NaN → stale, which is in the unknown/stale subset.
  if (input.triggeringSignal !== undefined) {
    const { refusals } = signalEligibleForAutomation(input.triggeringSignal, input.now as string);
    if (refusals.some((r) => SIGNAL_UNKNOWN_OR_STALE_REFUSALS.includes(r))) {
      reasons.push("signal_unknown_or_stale");
    }
  }

  // Deterministic dedupe, insertion-order preserved.
  const deduped = [...new Set(reasons)];
  return deduped.length === 0 ? { safe: true } : { safe: false, reasons: deduped };
}
