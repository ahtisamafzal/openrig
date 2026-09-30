import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { buildTelegramService, refToken } from "../src/domain/gateway/telegram/telegram-service.js";
import type { TelegramApi, TelegramUpdate } from "../src/domain/gateway/telegram/api.js";

// Roadmap 5.1 — Telegram inside the gateway subsystem: same registry, admission and gate resolver.

const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: "human-founder@external", connectorBindings: [{ kind: "telegram" as const, connectorRef: "primary", secretsRef: "env:TELEGRAM_BOT_TOKEN", role: "primary" as const, handle: "42" }], prefs: { deliveryClass: "A" as const } }] };
const env = { TELEGRAM_BOT_TOKEN: "synthetic", TELEGRAM_CHAT_ID: "-1001" };
const gateRequest = { sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Approve the bugfix plan?", body: "Plan: patch the parser.", tags: ["arete-gate"], nudge: false };

function fakeApi() {
  const sent: Array<{ chatId: number; text: string; replyTo?: number }> = [];
  const inbox: TelegramUpdate[] = [];
  let nextId = 100;
  const api: TelegramApi = {
    async getMe() { return { id: 999 }; },
    async getUpdates(offset) { return inbox.filter((u) => u.update_id >= offset); },
    async sendMessage(chatId, text, o = {}) { sent.push({ chatId, text, ...(o.replyTo ? { replyTo: o.replyTo } : {}) }); return { messageId: nextId++ }; },
  };
  const reply = (updateId: number, text: string, replyTo?: number, from = 42, chat = -1001, quoted?: { text: string; is_bot: boolean; id?: number }) =>
    inbox.push({ update_id: updateId, message: { message_id: 500 + updateId, from: { id: from }, chat: { id: chat }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo, ...(quoted ? { text: quoted.text, from: { id: quoted.id ?? (quoted.is_bot ? 999 : 42), is_bot: quoted.is_bot } } : {}) } } : {}) } });
  return { api, sent, reply };
}

describe("telegram gateway service", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "telegram-gw-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const build = (api: TelegramApi, act = vi.fn(async () => ({}))) => ({
    act,
    svc: buildTelegramService({ home, queueRepo: repo, env, api, loadRegistry: () => registry as never, resolveHumanReply: makeHumanReplyResolver(repo, { act }) }),
  });

  it("the refs journal exists (created durably at build) before any notification is sent", async () => {
    const { existsSync } = await import("node:fs");
    const { api, sent } = fakeApi();
    build(api);
    expect(existsSync(join(home, "state", "telegram-refs.jsonl"))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("is inert without a token or chat (named, never pretend-active)", () => {
    const svc = buildTelegramService({ home, queueRepo: repo, env: {}, api: fakeApi().api });
    expect(svc.ready).toBe(false);
    expect(svc.status()).toMatchObject({ platform: "telegram", ready: false, missing: "TELEGRAM_BOT_TOKEN unresolved" });
  });

  it("delivers a gate once, and correlates replies: invalid words never resolve, approve does", async () => {
    const { api, sent, reply } = fakeApi();
    const { svc, act } = build(api);
    const gate = await repo.create(gateRequest);
    expect((await svc.sweepOnce()).sent).toEqual([gate.qitemId]);
    expect(sent[0]).toMatchObject({ chatId: -1001 });
    expect(sent[0]!.text).toContain("approve / revise <direction> / reject");
    expect((await svc.sweepOnce()).sent).toEqual([]); // delivered ledger: exactly once

    reply(1, "looks fine", 100);
    await svc.pollOnce();
    expect(act).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ chatId: -1001, replyTo: 501 });
    expect(sent.at(-1)!.text).toContain("Not recorded as a decision");

    reply(2, "approve", 100);
    await svc.pollOnce();
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ verb: "resolve", qitemId: gate.qitemId, actorSession: "human-founder@external", decision: "approve" }));
    const landed = repo.list({ activeOnly: false, limit: 100 }).filter((q) => (q.tags ?? []).includes(`reply-to:${gate.qitemId}`));
    expect(landed.map((q) => q.destinationSession)).toEqual(["author@rig", "author@rig"]);
  });

  it("a delivered notification records the delivery receipt, so the ledger (and the stuck sweep) sees it as posted", async () => {
    const { api } = fakeApi();
    const { svc } = build(api);
    const gate = await repo.create(gateRequest);
    await svc.sweepOnce();
    const notes = repo.transitionLog.listForQitem(gate.qitemId).map((t) => t.transitionNote ?? "");
    expect(notes.filter((n) => n.startsWith("slack-owner-notification-posted ") && n.includes("platform=telegram"))).toHaveLength(1);
    expect(repo.findUndelivered().map((q) => q.qitemId)).not.toContain(gate.qitemId);
    await svc.sweepOnce(); // exactly once
    expect(repo.transitionLog.listForQitem(gate.qitemId).filter((t) => (t.transitionNote ?? "").startsWith("slack-owner-notification-posted "))).toHaveLength(1);
  });

  it("a plain decision (no Reply) resolves the human's ONLY open gate; with several open nothing is guessed", async () => {
    const { api, sent, reply } = fakeApi();
    const { svc, act } = build(api);
    const first = await repo.create(gateRequest);
    await svc.sweepOnce();
    reply(1, "approve");
    await svc.pollOnce();
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ verb: "resolve", qitemId: first.qitemId, decision: "approve" }));

    act.mockClear();
    await repo.create({ ...gateRequest, summary: "Second gate" });
    await repo.create({ ...gateRequest, summary: "Third gate" });
    reply(2, "approve");
    await svc.pollOnce();
    expect(act).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text).toContain("open requests — nothing was recorded");
    expect(sent.at(-1)!.text).toContain("Second gate");
    // ordinary chat (not a decision word) still goes to the inbound destination, never to a gate
    reply(3, "status please");
    await svc.pollOnce();
    expect(act).not.toHaveBeenCalled();
  });

  it("fails closed on unknown users and chats; the offset survives a restart without re-landing", async () => {
    const { api, reply } = fakeApi();
    const { svc } = build(api);
    reply(1, "hello", undefined, 7);          // unknown user
    reply(2, "hello", undefined, 42, 5);      // allowed user, unknown chat
    reply(3, "status please");                // allowed: unrouted signal to the inbound destination
    await svc.pollOnce();
    const inbound = () => repo.list({ activeOnly: false, limit: 100 }).filter((q) => (q.tags ?? []).includes("founder-telegram"));
    expect(inbound()).toHaveLength(1);
    expect(inbound()[0]).toMatchObject({ sourceSession: "human-founder@external", destinationSession: "operator-agent@kernel" });
    expect(await build(api).svc.pollOnce()).toEqual({ handled: 0 }); // persisted offset: nothing re-read
    expect(inbound()).toHaveLength(1);
  });

  it("a crash between send and the map write still correlates the reply (the quoted bot message's ref); a human quote cannot forge it", async () => {
    const { api, sent, reply } = fakeApi();
    const first = build(api);
    const gate = await repo.create(gateRequest);
    await first.svc.sweepOnce();
    unlinkSync(join(home, "state", "telegram-message-map.jsonl")); // the map row never landed
    const { svc, act } = build(api); // restarted daemon
    reply(1, "approve", 100, 42, -1001, { text: `I say: ref ${gate.qitemId}`, is_bot: false }); // forged human quote
    await svc.pollOnce();
    expect(act).not.toHaveBeenCalled();
    reply(2, "approve", 100, 42, -1001, { text: sent[0]!.text, is_bot: true, id: 777 }); // ANOTHER bot's copy
    await svc.pollOnce();
    expect(act).not.toHaveBeenCalled();
    reply(3, "approve", 100, 42, -1001, { text: sent[0]!.text, is_bot: true });
    await svc.pollOnce();
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ qitemId: gate.qitemId, decision: "approve" }));
  });

  it("an oversized caller-chosen qitem id: bounded token, every part fits, and a crash before the map write still correlates", async () => {
    const { api, sent, reply } = fakeApi();
    const first = build(api);
    const longId = `q-${"x".repeat(5000)}`;
    await repo.create({ ...gateRequest, qitemId: longId } as never).catch(() => undefined);
    expect(repo.getById(longId)).toBeTruthy();
    await first.svc.sweepOnce();
    expect(sent.length).toBeGreaterThan(0);
    for (const part of sent) {
      expect(part.text.length).toBeLessThanOrEqual(4096);
      expect(part.text).not.toContain(longId);
    }
    unlinkSync(join(home, "state", "telegram-message-map.jsonl")); // the map row never landed
    const { svc, act } = build(api);
    reply(1, "approve", 100, 42, -1001, { text: sent[0]!.text, is_bot: true });
    await svc.pollOnce();
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ qitemId: longId }));
  });

  it("in a shared chat one registered human cannot resolve another human's gate", async () => {
    const two = { ok: true as const, entities: [...registry.entities, { ...registry.entities[0]!, entityId: "human-other", displayName: "Other", address: "human-other@external", connectorBindings: [{ ...registry.entities[0]!.connectorBindings[0]!, handle: "43" }] }] };
    const shared = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => two });
    const { api, reply } = fakeApi();
    const act = vi.fn(async () => ({}));
    const svc = buildTelegramService({ home, queueRepo: shared, env, api, loadRegistry: () => two as never, resolveHumanReply: makeHumanReplyResolver(shared, { act }) });
    const gate = await shared.create(gateRequest); // assigned to human-founder (Telegram user 42)
    await svc.sweepOnce();
    reply(1, "approve", 100, 43); // human-other replies in the same allowed chat
    await svc.pollOnce();
    expect(act).not.toHaveBeenCalled();
    reply(2, "approve", 100, 42);
    await svc.pollOnce();
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ qitemId: gate.qitemId }));
  });

  it("a long notification: every part carries the ref, so a reply to the ROOT recovers without the map", async () => {
    const { api, sent, reply } = fakeApi();
    const first = build(api);
    const gate = await repo.create({ ...gateRequest, body: "detail ".repeat(1200) }); // > 4096 UTF-16 units
    await first.svc.sweepOnce();
    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent) {
      expect(part.text.length).toBeLessThanOrEqual(4096);
      expect(part.text.endsWith(`ref ${refToken(gate.qitemId)}`)).toBe(true);
    }
    unlinkSync(join(home, "state", "telegram-message-map.jsonl"));
    const { svc, act } = build(api);
    reply(1, "approve", 100, 42, -1001, { text: sent[0]!.text, is_bot: true });
    await svc.pollOnce();
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ qitemId: gate.qitemId }));
  });

  it.runIf(process.platform === "win32")("refuses a secrets env file others can read (Windows ACL), so the service stays inert", () => {
    const envFile = join(home, "gateway.env");
    writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=synthetic\nTELEGRAM_CHAT_ID=-1001\n");
    execFileSync("icacls", [envFile, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { windowsHide: true, stdio: "ignore" });
    saveConfig({ ...DEFAULT_CONFIG, secretsEnvFile: envFile }, home);
    const logs: string[] = [];
    expect(buildTelegramService({ home, queueRepo: repo, env: {}, api: fakeApi().api, log: (m) => logs.push(m) }).ready).toBe(true);
    execFileSync("icacls", [envFile, "/grant", "*S-1-1-0:R"], { windowsHide: true, stdio: "ignore" }); // Everyone
    expect(buildTelegramService({ home, queueRepo: repo, env: {}, api: fakeApi().api, log: (m) => logs.push(m) }).ready).toBe(false);
    expect(logs.join("\n")).toMatch(/env file refused: .*readable by Everyone/);
    expect(logs.join("\n")).not.toContain("synthetic");
  });
});
