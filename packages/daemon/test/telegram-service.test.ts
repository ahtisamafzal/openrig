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
    async getMe() { return { id: 999, username: "AreteBot" }; },
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

  it("/run <flow> <task> from the registered human starts the flow through Arete's signed inbound, and says so", async () => {
    const { createHmac } = await import("node:crypto");
    const { api, sent, reply } = fakeApi();
    const calls: Array<{ url: string; body: string; sig: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body), sig: (init?.headers as Record<string, string>)["x-hub-signature-256"]! });
      const wf = JSON.parse(String(init?.body)).workflowId;
      return wf === "design-check"
        ? new Response(JSON.stringify({ ok: true, runId: "telegram-7", workflowId: wf }), { status: 202 })
        : new Response(JSON.stringify({ ok: false, error: "invalid_workflowId" }), { status: 400 });
    };
    const svc = buildTelegramService({ home, queueRepo: repo, env: { ...env, ARETE_INBOUND_WEBHOOK_SECRET: "s3cret", ARETE_URL: "http://arete:4111/" }, api, fetchImpl, loadRegistry: () => registry as never });
    reply(7, "/run design-check a settings page\nwith dark mode");
    await svc.pollOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://arete:4111/arete/signals/inbound");
    expect(JSON.parse(calls[0]!.body)).toEqual({ workflowId: "design-check", inputData: { task: "a settings page\nwith dark mode" }, source: "telegram", runId: "telegram-7" });
    expect(calls[0]!.sig).toBe(`sha256=${createHmac("sha256", "s3cret").update(calls[0]!.body).digest("hex")}`);
    expect(sent.at(-1)).toMatchObject({ chatId: -1001, replyTo: 507 });
    expect(sent.at(-1)!.text).toContain("Started design-check (run telegram-7)");
    expect(repo.list({ activeOnly: false, limit: 100 })).toHaveLength(0); // a command, not a message to the lead seat
    reply(8, "/run nope do it");
    await svc.pollOnce();
    expect(sent.at(-1)!.text).toContain('no flow "nope"');
    reply(9, "/run");
    await svc.pollOnce();
    expect(sent.at(-1)!.text).toContain("Usage: /run <flow> <task>");
    expect(calls).toHaveLength(2);
  });

  it("/run with an unclear answer is retried with the SAME run id until Arete answers; never 'Not started'", async () => {
    const { api, sent, reply } = fakeApi();
    const bodies: string[] = [];
    let answer: () => Response | never = () => { throw new Error("socket hang up after the commit"); };
    const fetchImpl = async (_url: string, init?: RequestInit) => (bodies.push(String(init?.body)), answer());
    const svc = buildTelegramService({ home, queueRepo: repo, env: { ...env, ARETE_INBOUND_WEBHOOK_SECRET: "s" }, api, fetchImpl, loadRegistry: () => registry as never });
    reply(11, "/run design-check a settings page");
    await svc.pollOnce();
    expect(sent.at(-1)!.text).toContain("Retrying the same run automatically");
    expect(sent.at(-1)!.text).not.toContain("Not started");
    answer = () => new Response("<html>bad gateway</html>", { status: 502 }); // still unclear
    await svc.retryPendingRuns!();
    answer = () => new Response(JSON.stringify({ ok: true, runId: "telegram-11", status: "exists" }), { status: 202 });
    await svc.retryPendingRuns!();
    expect(sent.at(-1)!.text).toContain("Started design-check (run telegram-11)");
    expect(new Set(bodies).size).toBe(1); // every attempt was the identical signed request
    expect(bodies).toHaveLength(3);
    await svc.retryPendingRuns!();
    expect(bodies).toHaveLength(3); // nothing left pending
  });

  it("/run: an answer Telegram fails to deliver is kept pending (flushed to disk) and re-reported", async () => {
    const { readFileSync } = await import("node:fs");
    const { api, sent, reply } = fakeApi();
    const realSend = api.sendMessage;
    let failSends = 1;
    api.sendMessage = async (...a) => (failSends-- > 0 ? Promise.reject(new Error("telegram 502")) : realSend(...a));
    let posts = 0;
    const fetchImpl = async () => (posts++, new Response(JSON.stringify({ ok: true, runId: "telegram-31", status: posts > 1 ? "exists" : "started" }), { status: 202 }));
    const svc = buildTelegramService({ home, queueRepo: repo, env: { ...env, ARETE_INBOUND_WEBHOOK_SECRET: "s" }, api, fetchImpl, loadRegistry: () => registry as never });
    reply(31, "/run design-check x");
    await svc.pollOnce(); // started, but "Started ..." could not be delivered
    const pending = JSON.parse(readFileSync(join(home, "state", "telegram-run-pending.json"), "utf8")) as Array<{ runId: string }>;
    expect(pending.map((p) => p.runId)).toEqual(["telegram-31"]);
    await svc.retryPendingRuns!(); // Arete: exists (idempotent) -> the human is told now
    expect(sent.at(-1)!.text).toContain("Started design-check (run telegram-31)");
    expect(posts).toBe(2);
    expect(JSON.parse(readFileSync(join(home, "state", "telegram-run-pending.json"), "utf8"))).toEqual([]);
  });

  it("/run retries never hold up Telegram: an Arete outage leaves polling and notifications prompt", async () => {
    const { writeFileSync: write, mkdirSync } = await import("node:fs");
    const { api, sent } = fakeApi();
    let posts = 0;
    const fetchImpl = () => (posts++, new Promise<Response>(() => {})); // Arete never answers
    mkdirSync(join(home, "state"), { recursive: true });
    const stuck = Array.from({ length: 12 }, (_, i) => ({ flow: "design-check", runId: `telegram-${900 + i}`, body: "{}", chatId: -1001, messageId: 1, tries: i }));
    write(join(home, "state", "telegram-run-pending.json"), JSON.stringify(stuck));
    const svc = buildTelegramService({ home, queueRepo: repo, env: { ...env, ARETE_INBOUND_WEBHOOK_SECRET: "s" }, api, fetchImpl, loadRegistry: () => registry as never, intervalMs: 60_000 });
    const gate = await repo.create(gateRequest);
    svc.startServices();
    try {
      await vi.waitFor(() => expect(sent.some((m) => m.text.includes("approve / revise"))).toBe(true), { timeout: 2000 });
      expect(gate.qitemId).toBeTruthy();
      expect(posts).toBe(1); // one retry in flight at a time, started after the tick's real work
    } finally {
      svc.stop();
    }
  });

  it("/run@otherbot is not ours (handled as an ordinary message); /run@AreteBot is", async () => {
    const { api, reply } = fakeApi();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, runId: "r" }), { status: 202 }));
    const svc = buildTelegramService({ home, queueRepo: repo, env: { ...env, ARETE_INBOUND_WEBHOOK_SECRET: "s" }, api, fetchImpl, loadRegistry: () => registry as never });
    reply(21, "/run@OtherBot design-check x");
    await svc.pollOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.list({ activeOnly: false, limit: 100 })).toHaveLength(1); // landed like any message
    reply(22, "/run@arete_BOT design-check x");
    await svc.pollOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    reply(23, "/run@AreteBot design-check x");
    await svc.pollOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("/run is refused without the shared secret, and from anyone who is not a registered human", async () => {
    const { api, sent, reply } = fakeApi();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));
    const svc = buildTelegramService({ home, queueRepo: repo, env, api, fetchImpl, loadRegistry: () => registry as never });
    reply(1, "/run design-check x");
    await svc.pollOnce();
    expect(sent.at(-1)!.text).toContain("ARETE_INBOUND_WEBHOOK_SECRET is not configured");
    const stranger = { ok: true as const, entities: [] };
    const svc2 = buildTelegramService({ home: mkdtempSync(join(tmpdir(), "telegram-gw-")), queueRepo: repo, env: { ...env, ARETE_INBOUND_WEBHOOK_SECRET: "s" }, api, fetchImpl, loadRegistry: () => stranger as never });
    reply(2, "/run design-check x");
    await svc2.pollOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("a receipt that fails to record after the send is healed next sweep — recorded, never re-sent", async () => {
    const { api, sent } = fakeApi();
    const { svc } = build(api);
    const gate = await repo.create(gateRequest);
    const realUpdate = repo.update.bind(repo);
    const spy = vi.spyOn(repo, "update").mockImplementationOnce(() => {
      throw new Error("database busy");
    });
    expect((await svc.sweepOnce()).failed).toEqual([gate.qitemId]);
    expect(sent).toHaveLength(1); // it WAS delivered
    spy.mockImplementation(realUpdate);
    const receipts = () => repo.transitionLog.listForQitem(gate.qitemId).filter((t) => (t.transitionNote ?? "").startsWith("slack-owner-notification-posted "));
    expect(receipts()).toHaveLength(0);
    await svc.sweepOnce();
    expect(sent).toHaveLength(1); // healed without a second message
    expect(receipts()).toHaveLength(1);
    expect(repo.findUndelivered().map((q) => q.qitemId)).not.toContain(gate.qitemId);
    await svc.sweepOnce();
    expect(sent).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
  });

  it("the open-gate count is never truncated: two of the human's gates behind 500 others are still 'several'", async () => {
    const { api, sent, reply } = fakeApi();
    const { svc, act } = build(api);
    // the founder's OLD gate sits behind 501 newer ones (the list is newest-first), the second is new
    const old = await repo.create({ ...gateRequest, summary: "Founder gate A" });
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(new Date(Date.now() - 86_400_000).toISOString(), old.qitemId);
    for (let i = 0; i < 501; i++) await repo.create({ sourceSession: "author@rig", destinationSession: "worker@rig", summary: `agent gate ${i}`, body: "x", tags: ["arete-gate"], nudge: false });
    await repo.create({ ...gateRequest, summary: "Founder gate B" });
    reply(1, "approve");
    await svc.pollOnce();
    expect(act).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text).toContain("You have 2 open requests");
    // the lookup is filtered to the human in SQL and bounded — never a scan of every open gate
    const scan = vi.spyOn(repo, "list");
    const found = repo.openTaggedFor("human-founder", "arete-gate", 11);
    expect(found.map((q) => q.summary)).toEqual(["Founder gate B", "Founder gate A"]);
    expect(scan).not.toHaveBeenCalled();
  });

  it("the 'which one?' answer names at most 10 and says 'more than 10' beyond that", async () => {
    const { api, sent, reply } = fakeApi();
    const { svc, act } = build(api);
    for (let i = 0; i < 12; i++) await repo.create({ ...gateRequest, summary: `Gate ${i}` });
    reply(1, "reject");
    await svc.pollOnce();
    expect(act).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text).toContain("You have more than 10 open requests");
    expect(sent.at(-1)!.text.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(10);
  });

  it("a multipart delivery that fails after part 1 resumes at part 2 — part 1 is never sent twice", async () => {
    const { api, sent } = fakeApi();
    const { svc } = build(api);
    const gate = await repo.create({ ...gateRequest, body: "x".repeat(9000) });
    const realSend = api.sendMessage.bind(api);
    let calls = 0;
    api.sendMessage = async (chatId, text, o) => {
      if (++calls === 2) throw new Error("telegram 502");
      return realSend(chatId, text, o);
    };
    expect((await svc.sweepOnce()).failed).toEqual([gate.qitemId]);
    expect(sent).toHaveLength(1); // part 1 went out, part 2 failed
    const rootId = 100;
    await svc.sweepOnce();
    const parts = sent.length;
    expect(parts).toBeGreaterThanOrEqual(3); // 9000 chars -> at least 3 parts in total
    expect(sent.filter((m) => m.text === sent[0]!.text)).toHaveLength(1); // part 1 exactly once
    expect(sent.slice(1).every((m) => m.replyTo === rootId)).toBe(true); // resumed parts thread under part 1
    expect(repo.transitionLog.listForQitem(gate.qitemId).filter((t) => (t.transitionNote ?? "").startsWith("slack-owner-notification-posted "))).toHaveLength(1);
    await svc.sweepOnce();
    expect(sent).toHaveLength(parts); // nothing re-sent afterwards
  });

  it("a started multipart delivery is always finished, even if the human went away meanwhile (a deferral never strands a fragment)", async () => {
    const { api, sent } = fakeApi();
    let prefs: Record<string, unknown> = { deliveryClass: "B" };
    const reg = () => ({ ok: true as const, entities: [{ ...registry.entities[0]!, prefs }] });
    const repo2 = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: reg as never });
    const svc = buildTelegramService({ home, queueRepo: repo2, env, api, loadRegistry: reg as never });
    const gate = await repo2.create({ ...gateRequest, tags: ["arete-gate", "escalation"], body: "x".repeat(9000) }); // an escalation: "away" defers it
    const realSend = api.sendMessage.bind(api);
    let calls = 0;
    api.sendMessage = async (chatId, text, o) => {
      if (++calls === 2) throw new Error("telegram 502");
      return realSend(chatId, text, o);
    };
    await svc.sweepOnce();
    expect(sent).toHaveLength(1);
    prefs = { deliveryClass: "B", availability: "away" }; // now the policy DEFERS a gate by 30 minutes
    await svc.sweepOnce();
    expect(sent.length).toBeGreaterThanOrEqual(3); // the rest arrived anyway
    expect(sent.slice(1).every((m) => m.replyTo === 100)).toBe(true);
    expect(gate.qitemId).toBeTruthy();
  });

  it("a started delivery is finished from its saved plan even after the item left the alert list", async () => {
    const { api, sent } = fakeApi();
    const { svc } = build(api);
    const gate = await repo.create({ ...gateRequest, body: "x".repeat(9000) });
    const realSend = api.sendMessage.bind(api);
    let calls = 0;
    api.sendMessage = async (chatId, text, o) => {
      if (++calls === 2) throw new Error("telegram 502");
      return realSend(chatId, text, o);
    };
    await svc.sweepOnce();
    expect(sent).toHaveLength(1);
    const firstPart = sent[0]!.text;
    // the item closes before the next sweep: it is no longer an alert at all
    repo.update({ qitemId: gate.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on", transitionNote: "closed elsewhere" });
    await svc.sweepOnce();
    expect(sent.length).toBeGreaterThanOrEqual(3); // the rest of the message the human already sees
    expect(sent.filter((m) => m.text === firstPart)).toHaveLength(1);
    expect(sent.slice(1).every((m) => m.replyTo === 100)).toBe(true);
    const total = sent.length;
    await svc.sweepOnce();
    expect(sent).toHaveLength(total); // finished once, never again
    // and the finished message's text is no longer kept anywhere in the gateway state
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const stateText = walk(join(home, "state")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(stateText).not.toContain("x".repeat(200));
  });

  it("a temp plan a crash left behind (before its rename) is removed; no message text survives", async () => {
    const { mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
    const dir = join(home, "state", "telegram-plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "abc.json.tmp-99999"), JSON.stringify({ key: "old", parts: ["SECRET BODY TEXT"] }));
    const { api } = fakeApi();
    await build(api).svc.sweepOnce();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("if the plan's directory entry cannot be made durable (off Windows), nothing is sent", async () => {
    const { api, sent } = fakeApi();
    const svc = buildTelegramService({
      home, queueRepo: repo, env, api, loadRegistry: () => registry as never, platform: "linux",
      fsyncDir: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    });
    const gate = await repo.create(gateRequest);
    expect((await svc.sweepOnce()).failed).toEqual([gate.qitemId]);
    expect(sent).toHaveLength(0);
    // on Windows (no directory handle) the same failure is tolerated and the message goes out
    const win = buildTelegramService({
      home, queueRepo: repo, env, api, loadRegistry: () => registry as never, platform: "win32",
      fsyncDir: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
    });
    expect((await win.sweepOnce()).sent).toEqual([gate.qitemId]);
  });

  it("POSIX barriers: a new plans dir's parent AND the dir are fsynced before part 1; temp removal is fsynced", async () => {
    const { api, sent } = fakeApi();
    const events: string[] = [];
    const realSend = api.sendMessage.bind(api);
    api.sendMessage = async (c, t, o) => (events.push("send"), realSend(c, t, o));
    const fsyncDir = (d: string) => void events.push(`fsync:${d.endsWith("telegram-plans") ? "plans" : d.endsWith("state") ? "state" : d}`);
    const svc = buildTelegramService({ home, queueRepo: repo, env, api, loadRegistry: () => registry as never, platform: "linux", fsyncDir });
    await repo.create(gateRequest);
    await svc.sweepOnce();
    expect(events.slice(0, 3)).toEqual(["fsync:state", "fsync:plans", "send"]);
    expect(sent).toHaveLength(1);
    // a stale temp removal is followed by a plans-dir barrier
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home, "state", "telegram-plans", "x.json.tmp-1"), "SECRET");
    events.length = 0;
    await svc.sweepOnce();
    expect(events[0]).toBe("fsync:plans");
    // and a failing parent barrier on a brand-new dir sends nothing
    const home2 = mkdtempSync(join(tmpdir(), "telegram-gw2-"));
    const { api: api2, sent: sent2 } = fakeApi();
    const bad = buildTelegramService({ home: home2, queueRepo: repo, env, api: api2, loadRegistry: () => registry as never, platform: "linux",
      fsyncDir: (d) => { if (d.endsWith("state")) throw Object.assign(new Error("EIO"), { code: "EIO" }); } });
    await repo.create({ ...gateRequest, summary: "second" });
    await bad.sweepOnce();
    expect(sent2).toHaveLength(0);
    rmSync(home2, { recursive: true, force: true });
  });

  it("a delivery marks '#sent' durably BEFORE the receipt is written", async () => {
    const { api } = fakeApi();
    const { svc } = build(api);
    const gate = await repo.create(gateRequest);
    const order: string[] = [];
    const { SeenStore } = await import("../src/domain/gateway/slack/state-store.js");
    const durable = vi.spyOn(SeenStore.prototype, "markDurable").mockImplementation(function (this: InstanceType<typeof SeenStore>, id: string, status: string) {
      order.push(id.startsWith("plan:") ? "durable:plan" : id.endsWith("#sent") ? "durable:#sent" : id.includes("#part") ? "durable:part" : `durable:${id}`);
      this.mark(id, status);
    });
    const realUpdate = repo.update.bind(repo);
    vi.spyOn(repo, "update").mockImplementation((u) => (order.push("receipt"), realUpdate(u)));
    await svc.sweepOnce();
    durable.mockRestore();
    expect(order).toEqual(["durable:part", "durable:#sent", "receipt"]); // each part, #sent, then the receipt
    expect(gate.qitemId).toBeTruthy();
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
