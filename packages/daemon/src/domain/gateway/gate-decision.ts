// Roadmap 5.1 — the human-gate decision vocabulary, shared by every human channel (Slack, Telegram).
// A reply that resolves an Arete approval gate (a queue item tagged `arete-gate`) must be one of
// EXACTLY approve / revise / reject (+ optional direction); synonyms (approved, deny, ...) and
// anything else never resolve the gate. Arete's seat-link/gate.ts reader accepts a superset, so this
// can only refuse more, never resolve more.

export const ARETE_GATE_TAG = "arete-gate";

export type GateDecisionKind = "approve" | "revise" | "reject";

export interface GateDecision {
  decision: GateDecisionKind;
  direction?: string;
}

/** The decision a reply carries, or null when it is not one of the allowed words. */
export function parseGateDecision(text: string): GateDecision | null {
  const m = /^\s*(approve|revise|reject)\b[\s:,.-]*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const decision = m[1]!.toLowerCase() as GateDecisionKind;
  const direction = m[2]!.trim();
  return { decision, ...(direction ? { direction } : {}) };
}

/** Is this queue item an Arete approval gate (so its reply must follow the gate vocabulary)? */
export function isGateItem(tags: readonly string[] | null | undefined): boolean {
  return !!tags?.includes(ARETE_GATE_TAG);
}
