import { describe, it, expect, vi } from "vitest";
import { isGateItem, parseGateDecision } from "../src/domain/gateway/gate-decision.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";

// Roadmap 5.1: a reply to an Arete approval gate (tag `arete-gate`), from any human channel, must be
// approve / revise / reject; anything else never resolves the gate. Other parked items keep free text.

describe("gate decision vocabulary", () => {
  it("parses the allowed words (+ direction) and nothing else", () => {
    expect(parseGateDecision("approve")).toEqual({ decision: "approve" });
    expect(parseGateDecision("  Approve: ship it")).toEqual({ decision: "approve", direction: "ship it" });
    expect(parseGateDecision("revise - add the rollback section")).toEqual({ decision: "revise", direction: "add the rollback section" });
    expect(parseGateDecision("reject too risky")).toEqual({ decision: "reject", direction: "too risky" });
    for (const synonym of ["approved", "Approved: ship it", "rejected", "deny", "denied", "ok", "yes"]) expect(parseGateDecision(synonym)).toBeNull();
    expect(parseGateDecision("looks good to me")).toBeNull();
    expect(parseGateDecision("approvement pending")).toBeNull();
    expect(isGateItem(["arete-gate", "workflow:bugfix"])).toBe(true);
    expect(isGateItem(null)).toBe(false);
  });

  it("the shared reply resolver refuses a non-decision reply to a gate, and resolves a valid one", async () => {
    const items: Record<string, { tags: string[] | null; humanIntent?: string; destinationSession?: string }> = {
      gate: { tags: ["arete-gate"], destinationSession: "h@kernel" },
      other: { tags: ["some-park"], destinationSession: "h@kernel" },
    };
    const repo = { getById: (id: string) => items[id], transitionLog: { listForQitem: () => [] } } as never;
    const act = vi.fn(async () => ({}));
    const resolve = makeHumanReplyResolver(repo, { act });
    expect(await resolve({ qitemId: "gate", actorSession: "h@external", decision: "sounds fine" })).toBe("invalid-decision");
    expect(act).not.toHaveBeenCalled();
    expect(await resolve({ qitemId: "gate", actorSession: "h@external", decision: "approve" })).toBe("resolved");
    expect(await resolve({ qitemId: "other", actorSession: "h@external", decision: "any free text" })).toBe("resolved");
    expect(act).toHaveBeenCalledTimes(2);
    // 5.10: another human's reply never resolves this human's gate
    expect(await resolve({ qitemId: "gate", actorSession: "someone-else@external", decision: "approve" })).toBe("not-applicable");
    expect(act).toHaveBeenCalledTimes(2);
  });
});
