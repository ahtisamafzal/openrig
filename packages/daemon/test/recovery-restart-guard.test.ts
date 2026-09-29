import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { checkRecoveryRestart, recoveryGuardConfig, RECOVERY_EVENT, type RecoveryGuardConfig } from "../src/domain/recovery-restart-guard.js";

// Roadmap 3.2 — restart safety rules for agents' recovery restarts.

const EVIDENCE = { failureEvidence: "seat crashed: provider 529 overloaded x3", evidenceRef: "qitem q-dev-1 / watchdog job w1", healthConsulted: true };
const CFG: RecoveryGuardConfig = { retryCap: 2, windowHours: 24, protectedRoles: [], recoveryCallers: ["arete@arete-rig"] };

describe("recovery restart guard (roadmap 3.2)", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let ids: { rig: string; lead: string; dev: string; qa: string; other: string };

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    eventBus = new EventBus(db);
    const rig = rigRepo.createRig("r");
    const lead = rigRepo.addNode(rig.id, "lead.main", { runtime: "claude-code", role: "section-lead" });
    const dev = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", role: "developer" });
    const qa = rigRepo.addNode(rig.id, "dev.qa", { runtime: "claude-code", role: "qa" });
    const other = rigRepo.addNode(rig.id, "ops.x", { runtime: "claude-code", role: "ops" });
    rigRepo.addEdge(rig.id, lead.id, dev.id, "delegates_to");
    rigRepo.addEdge(rig.id, dev.id, qa.id, "delegates_to"); // lead -> dev -> qa (nested)
    for (const [n, s] of [[lead, "lead-main@r"], [dev, "dev-impl@r"], [qa, "dev-qa@r"], [other, "ops-x@r"]] as const) {
      sessions.registerSession(n.id, s);
    }
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
       VALUES ('q-dev-1', '2026-09-29T09:00:00Z', '2026-09-29T09:00:00Z', 'arete@arete-rig', 'dev-impl@r', 'in-progress', 'routine', NULL, '["arete-step:k"]', 'fix it')`,
    ).run();
    ids = { rig: rig.id, lead: lead.id, dev: dev.id, qa: qa.id, other: other.id };
  });
  afterEach(() => db.close());

  const dev = () => ({ nodeId: ids.dev, role: "developer", sessionName: "dev-impl@r" });
  const check = (caller: string | null, evidence: object | null = EVIDENCE, cfg: RecoveryGuardConfig = CFG, target = dev()) =>
    checkRecoveryRestart(db, { caller, target, evidence }, cfg);

  it("the operator is never gated: no identity, or a human seat", () => {
    expect(check(null, null)).toEqual({ allowed: true, caller: "operator" });
    expect(check("human@host", null)).toEqual({ allowed: true, caller: "operator" });
    expect(check("human-ops@kernel", null)).toEqual({ allowed: true, caller: "operator" });
  });

  it("an agent without evidence is refused with EVERY failing guard", () => {
    const d = check("arete@arete-rig", {});
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.reasons.join("\n")).toMatch(/failure evidence required/);
    expect(d.reasons.join("\n")).toMatch(/evidence reference required/);
    expect(d.reasons.join("\n")).toMatch(/health must be consulted/);
    expect(d.reasons).toHaveLength(3);
  });

  it("a complete request from Arete's recovery identity is allowed", () => {
    expect(check("arete@arete-rig")).toEqual({ allowed: true, caller: "agent", identity: "arete@arete-rig" });
  });

  it("hard retry cap: two recorded recovery restarts of the seat in the window refuse the third", () => {
    const record = () => eventBus.emit({ type: RECOVERY_EVENT, rigId: ids.rig, nodeId: ids.dev, logicalId: "dev.impl", caller: "arete@arete-rig", failureEvidence: "x", evidenceRef: "y" });
    record();
    expect(check("arete@arete-rig").allowed).toBe(true);
    record();
    const d = check("arete@arete-rig");
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.reasons[0]).toMatch(/hard retry cap reached: 2 recovery restart/);
    // outside the window they no longer count
    db.prepare("UPDATE events SET created_at = datetime('now', '-2 days') WHERE type = ?").run(RECOVERY_EVENT);
    expect(check("arete@arete-rig").allowed).toBe(true);
  });

  it("nothing to resume: a seat with no open queue work is not recovery-restarted", () => {
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = 'q-dev-1'").run();
    const d = check("arete@arete-rig");
    expect(!d.allowed && d.reasons).toEqual([expect.stringMatching(/nothing to resume/)]);
  });

  it("protected roles are never restarted by an agent (configurable, none by default)", () => {
    expect(recoveryGuardConfig({}).protectedRoles).toEqual([]);
    const d = check("arete@arete-rig", EVIDENCE, { ...CFG, protectedRoles: ["developer"] });
    expect(!d.allowed && d.reasons).toEqual([expect.stringMatching(/protected seat: role 'developer'/)]);
  });

  it("caller scope by delegates_to: an orchestrator may recover what it orchestrates (nested too), nothing else", () => {
    expect(check("lead-main@r").allowed).toBe(true); // lead -> dev
    const qa = { nodeId: ids.qa, role: "qa", sessionName: "dev-qa@r" };
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
       VALUES ('q-qa', '2026-09-29T09:00:00Z', '2026-09-29T09:00:00Z', 'x', 'dev-qa@r', 'in-progress', 'routine', NULL, NULL, 'b')`,
    ).run();
    expect(check("lead-main@r", EVIDENCE, CFG, qa).allowed).toBe(true); // lead -> dev -> qa
    const up = check("dev-impl@r", EVIDENCE, CFG, { nodeId: ids.lead, role: "section-lead", sessionName: "lead-main@r" });
    expect(!up.allowed && up.reasons.join()).toMatch(/does not orchestrate this seat/); // never upward
    const sideways = check("ops-x@r");
    expect(!sideways.allowed && sideways.reasons.join()).toMatch(/out of scope/);
    const self = check("dev-impl@r");
    expect(!self.allowed && self.reasons.join()).toMatch(/may not recovery-restart itself/);
    const unknown = check("stranger@nowhere");
    expect(!unknown.allowed && unknown.reasons.join()).toMatch(/unknown caller 'stranger@nowhere'/);
  });

  it("configuration from the environment", () => {
    expect(recoveryGuardConfig({ OPENRIG_RECOVERY_RETRY_CAP: "5", OPENRIG_RECOVERY_WINDOW_HOURS: "6", OPENRIG_PROTECTED_ROLES: "ceo, cto", OPENRIG_RECOVERY_CALLERS: "arete@a" })).toEqual({
      retryCap: 5, windowHours: 6, protectedRoles: ["ceo", "cto"], recoveryCallers: ["arete@a"],
    });
    expect(recoveryGuardConfig({ OPENRIG_RECOVERY_RETRY_CAP: "x" }).retryCap).toBe(2);
  });
});
