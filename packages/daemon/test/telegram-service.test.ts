import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { buildTelegramService } from "../src/domain/gateway/telegram/telegram-service.js";
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
    async getUpdates(offset) { return inbox.filter((u) => u.update_id >= offset); },
    async sendMessage(chatId, text, o = {}) { sent.push({ chatId, text, ...(o.replyTo ? { replyTo: o.replyTo } : {}) }); return { messageId: nextId++ }; },
  };
  const reply = (updateId: number, text: string, replyTo?: number, from = 42, chat = -1001) =>
    inbox.push({ update_id: updateId, message: { message_id: 500 + updateId, from: { id: from }, chat: { id: chat }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } });
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
});
