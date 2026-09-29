// Roadmap 3.1 — Arete's 6-way silence classifier, ported verbatim (Arete
// harness/watchdog/classify.ts + tick.ts, itself a port of the Rust
// watchdog.rs classify_silence / tick_decision). Pure: no I/O, no clock.
//
// The branch order is load-bearing: compaction/blocked and provider health are
// consulted BEFORE any nudge, so a seat that is legitimately waiting or whose
// provider is down is never nudged.

export type SilenceClass =
  | "compaction" // compacting / blocked -> pause the stall clock
  | "provider_failure" // provider permanently unhealthy -> escalate, never nudge
  | "transient" // rate limit / temporary provider error -> pause
  | "dormant" // announced dormant -> pause
  | "genuine_stall" // no valid reason -> nudge ladder
  | "unknown"; // nudges exhausted -> escalate

export interface SilenceAgentState {
  status?: "idle" | "active" | "blocked" | (string & {});
  customStatus?: string;
}

export interface SilenceHealth {
  recentFailureCount: number;
  permanentlyUnhealthy: boolean;
  /** e.g. 'rate_limit' | 'temporary_provider_error'. */
  lastFailureClass?: string;
}

export interface SilenceDormant {
  isDormant: boolean;
  reason?: string;
}

export interface SilenceConfig {
  /** Nudges before the classifier escalates to the lead (Arete default 3). */
  nudgeLimit: number;
  /** Hard nudge cap; past it the escalation goes to a human (Arete default 3). */
  maxNudges: number;
}

export type SilenceDecision =
  | { kind: "pause"; classification: SilenceClass; reason: string }
  | { kind: "nudge"; classification: SilenceClass; nudgeNumber: number }
  | { kind: "escalate"; classification: SilenceClass; target: "lead" | "human"; reason: string; nudgeCount: number };

type Action = { kind: "pauseClock" } | { kind: "nudge"; nudgeNumber: number } | { kind: "escalate"; target: "lead" };

export function classifySilence(
  agent: SilenceAgentState,
  health: SilenceHealth,
  dormant: SilenceDormant,
  nudgeCount: number,
  config: Pick<SilenceConfig, "nudgeLimit">,
): { classification: SilenceClass; action: Action } {
  if (agent.customStatus === "compacting" || agent.status === "blocked") {
    return { classification: "compaction", action: { kind: "pauseClock" } };
  }
  if (health.permanentlyUnhealthy) {
    return { classification: "provider_failure", action: { kind: "escalate", target: "lead" } };
  }
  if (health.lastFailureClass === "rate_limit" || health.lastFailureClass === "temporary_provider_error") {
    return { classification: "transient", action: { kind: "pauseClock" } };
  }
  if (dormant.isDormant) {
    return { classification: "dormant", action: { kind: "pauseClock" } };
  }
  if (nudgeCount < config.nudgeLimit) {
    return { classification: "genuine_stall", action: { kind: "nudge", nudgeNumber: nudgeCount + 1 } };
  }
  return { classification: "unknown", action: { kind: "escalate", target: "lead" } };
}

/** tick_decision: the classifier plus the hard nudge cap (past it -> a human). */
export function decideSilence(
  agent: SilenceAgentState,
  health: SilenceHealth,
  dormant: SilenceDormant,
  nudgeCount: number,
  config: SilenceConfig,
): SilenceDecision {
  const { classification, action } = classifySilence(agent, health, dormant, nudgeCount, config);
  if (action.kind === "pauseClock") return { kind: "pause", classification, reason: `pausing — ${classification}` };
  if (action.kind === "escalate") {
    return { kind: "escalate", classification, target: action.target, reason: classification, nudgeCount };
  }
  const nudgeNumber = Math.max(action.nudgeNumber, nudgeCount + 1);
  if (nudgeNumber > config.maxNudges) {
    return { kind: "escalate", classification, target: "human", reason: `nudge cap (${config.maxNudges}) exceeded`, nudgeCount };
  }
  return { kind: "nudge", classification, nudgeNumber };
}
