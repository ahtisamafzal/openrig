import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { buildTelegramService } from "../src/domain/gateway/telegram/telegram-service.js";
import type { TelegramApi, TelegramUpdate } from "../src/domain/gateway/telegram/api.js";
import { NtfyNotificationAdapter } from "../src/domain/mission-control/notification-adapter-ntfy.js";
import { WebhookNotificationAdapter } from "../src/domain/mission-control/notification-adapter-webhook.js";

// Roadmap 5.10 — ONE human-channel gate contract, run against every reply-capable channel
// (Telegram, Slack): correlation to the exact gate, registered-human authorization, the
// approve / revise / reject vocabulary, duplicate and out-of-order replies, expired gates and a
// restart between delivery and reply. ntfy / webhook are asserted outbound-only.

const binding = (kind: "slack" | "telegram", handle: string) => ({ kind, connectorRef: "primary", secretsRef: "env:X", role: "primary" as const, handle });
const human = (id: string, slack: string, tg: string) => ({
  entityId: id, class: "human" as const, displayName: id, address: `${id}@external`,
  connectorBindings: [binding("slack", slack), { ...binding("telegram", tg), role: "secondary" as const }],
  prefs: { deliveryClass: "A" as const },
});
const registry = { ok: true as const, entities: [human("human-founder", "UFOUNDER", "42"), human("human-other", "UOTHER", "43")] };

/** A channel under contract: deliver a gate, then reply to it as a given platform user. */
interface Channel {
  deliver(qitemId: string): Promise<void>;
  reply(text: string, from: "founder" | "other" | "stranger", opts?: { redeliver?: boolean }): Promise<void>;
  restart(): void;
}

let home: string;
let db: ReturnType<typeof createDb>;
let repo: QueueRepository;
let resolver: ReturnType<typeof makeHumanReplyResolver>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "channel-contract-"));
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry, transport: { async send() { return { ok: true, verified: true }; } } });
  resolver = makeHumanReplyResolver(repo, new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) }));
});
afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

function slackChannel(): Channel {
  let seq = 0;
  let last: SlackEvent | undefined;
  const map = () => new ThreadSeatMap(db);
  let router: InboundRouter;
  const build = () => {
    router = new InboundRouter({
      queue: makeQueuePorts(repo, { loadHumanRegistry: () => registry }),
      seen: new SeenStore(join(home, "slack-seen.jsonl")),
      deadLetter: new DeadLetterStore<SlackEvent>(join(home, "slack-dead.jsonl")),
      destination: "operator-agent@kernel",
      resolveSender: (u) => {
        const r = resolveSlackHandle(u, registry.entities);
        return r.kind === "registered" ? { admitted: true, source: r.address } : { admitted: false, teaching: r.error };
      },
      resolveRoute: makeThreadRouteResolver({ map: map(), unroutedDestination: "operator-agent@kernel" }),
      resolveHumanReply: resolver,
    });
  };
  build();
  return {
    async deliver(qitemId) {
      map().open({ threadTs: "T-GATE", channel: "C", human: "human-founder@external", seat: "author@rig", conversationId: qitemId });
    },
    async reply(text, from, o = {}) {
      const user = { founder: "UFOUNDER", other: "UOTHER", stranger: "USTRANGER" }[from];
      const ev: SlackEvent = o.redeliver && last ? last : { type: "message", user, text, ts: `${++seq}.1`, thread_ts: "T-GATE", channel: "C" };
      last = ev;
      await router.route(ev);
    },
    restart: build,
  };
}

function telegramChannel(): Channel {
  const inbox: TelegramUpdate[] = [];
  const sent: Array<{ text: string }> = [];
  let nextMsg = 100;
  const api: TelegramApi = {
    async getMe() { return { id: 999 }; },
    async getUpdates(offset) { return inbox.filter((u) => u.update_id >= offset); },
    async sendMessage(_chat, text) { sent.push({ text }); return { messageId: nextMsg++ }; },
  };
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-1001" };
  const make = () => buildTelegramService({ home, queueRepo: repo, env, api, loadRegistry: () => registry as never, resolveHumanReply: resolver });
  let svc = make();
  let update = 0;
  return {
    async deliver() {
      await svc.sweepOnce();
    },
    async reply(text, from, o = {}) {
      const uid = { founder: 42, other: 43, stranger: 7 }[from];
      if (o.redeliver) {
        // Telegram re-serves an update the offset did not yet pass: re-poll from before it
        const u = inbox.at(-1)!;
        await svc.pollOnce();
        inbox.push({ ...u }); // the same update id again (a duplicate delivery)
      } else {
        inbox.push({ update_id: ++update, message: { message_id: 500 + update, from: { id: uid }, chat: { id: -1001 }, text, reply_to_message: { message_id: 100 } } });
      }
      await svc.pollOnce();
    },
    restart() { svc = make(); },
  };
}

const gate = () => repo.create({ sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Approve the plan?", body: "Plan.", evidenceRef: "proof/plan.md", tags: ["arete-gate"], tier: "human-gate", nudge: false } as never);
const resolved = (qitemId: string) => repo.listTransitions(qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").length;

for (const [name, make] of [["telegram", telegramChannel], ["slack", slackChannel]] as const) {
  describe(`human-channel gate contract: ${name}`, () => {
    it("correlates a reply to exactly its gate and resolves it once; duplicates and later replies never resolve again", async () => {
      const ch = make();
      const g = await gate();
      await ch.deliver(g.qitemId);
      await ch.reply("approve", "founder");
      expect(resolved(g.qitemId)).toBe(1);
      await ch.reply("approve", "founder", { redeliver: true }); // the same event delivered again
      await ch.reply("reject changed my mind", "founder"); // out of order: after the resolution
      expect(resolved(g.qitemId)).toBe(1);
    });

    it("authorization: an unregistered sender and ANOTHER registered human never resolve the gate", async () => {
      const ch = make();
      const g = await gate();
      await ch.deliver(g.qitemId);
      await ch.reply("approve", "stranger");
      await ch.reply("approve", "other");
      expect(resolved(g.qitemId)).toBe(0);
      await ch.reply("approve", "founder");
      expect(resolved(g.qitemId)).toBe(1);
    });

    it("vocabulary: only approve / revise / reject resolve a gate", async () => {
      const ch = make();
      const g = await gate();
      await ch.deliver(g.qitemId);
      for (const t of ["looks good", "approved", "ok"]) await ch.reply(t, "founder");
      expect(resolved(g.qitemId)).toBe(0);
      await ch.reply("revise add the rollback section", "founder");
      expect(resolved(g.qitemId)).toBe(1);
    });

    it("an expired (closed) gate is never resolved by a late reply", async () => {
      const ch = make();
      const g = await gate();
      await ch.deliver(g.qitemId);
      repo.update({ qitemId: g.qitemId, actorSession: "author@rig", state: "done", closureReason: "canceled", transitionNote: "gate expired" } as never);
      await ch.reply("approve", "founder");
      expect(resolved(g.qitemId)).toBe(0);
    });

    it("a restart between delivery and reply still resolves the gate exactly once", async () => {
      const ch = make();
      const g = await gate();
      await ch.deliver(g.qitemId);
      ch.restart();
      await ch.reply("approve", "founder");
      expect(resolved(g.qitemId)).toBe(1);
    });
  });
}

describe("a failed gate resolution is retried", () => {
  it("the reply's item already landed: the dead-letter retry resolves the gate exactly once", async () => {
    let fail = true;
    const flaky: typeof resolver = async (input) => {
      if (fail) {
        fail = false;
        throw new Error("mission control briefly unavailable");
      }
      return resolver(input);
    };
    const map = new ThreadSeatMap(db);
    const router = new InboundRouter({
      queue: makeQueuePorts(repo, { loadHumanRegistry: () => registry }),
      seen: new SeenStore(join(home, "retry-seen.jsonl")),
      deadLetter: new DeadLetterStore<SlackEvent>(join(home, "retry-dead.jsonl")),
      destination: "operator-agent@kernel",
      resolveSender: (u) => {
        const r = resolveSlackHandle(u, registry.entities);
        return r.kind === "registered" ? { admitted: true, source: r.address } : { admitted: false, teaching: r.error };
      },
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "operator-agent@kernel" }),
      resolveHumanReply: flaky,
    });
    const g = await gate();
    map.open({ threadTs: "T-GATE", channel: "C", human: "human-founder@external", seat: "author@rig", conversationId: g.qitemId });
    const first = await router.route({ type: "message", user: "UFOUNDER", text: "approve", ts: "9.1", thread_ts: "T-GATE", channel: "C" });
    expect(first.disposition).toBe("dead-lettered");
    expect(resolved(g.qitemId)).toBe(0);
    await router.retryDeadLetters();
    expect(resolved(g.qitemId)).toBe(1);
    await router.retryDeadLetters();
    expect(resolved(g.qitemId)).toBe(1);
  });

  it("a failure dead-lettered WHILE a retry pass runs survives the pass's replace; overlapping passes join", async () => {
    const dead = new DeadLetterStore<SlackEvent>(join(home, "race-dead.jsonl"));
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow: typeof resolver = async (input) => {
      calls++;
      if (calls === 1) throw new Error("down"); // the first reply dead-letters
      if (calls === 2) {
        await paused; // the retry pass is mid-flight, after readAll()
        throw new Error("still down");
      }
      if (calls === 3) throw new Error("down again"); // the concurrent live reply dead-letters
      return resolver(input);
    };
    const map = new ThreadSeatMap(db);
    const router = new InboundRouter({
      queue: makeQueuePorts(repo, { loadHumanRegistry: () => registry }),
      seen: new SeenStore(join(home, "race-seen.jsonl")),
      deadLetter: dead,
      destination: "operator-agent@kernel",
      resolveSender: (u) => {
        const r = resolveSlackHandle(u, registry.entities);
        return r.kind === "registered" ? { admitted: true, source: r.address } : { admitted: false, teaching: r.error };
      },
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "operator-agent@kernel" }),
      resolveHumanReply: slow,
    });
    const g1 = await gate();
    const g2 = await gate();
    map.open({ threadTs: "T-R1", channel: "C", human: "human-founder@external", seat: "author@rig", conversationId: g1.qitemId });
    map.open({ threadTs: "T-R2", channel: "C", human: "human-founder@external", seat: "author@rig", conversationId: g2.qitemId });
    expect((await router.route({ type: "message", user: "UFOUNDER", text: "approve", ts: "8.1", thread_ts: "T-R1", channel: "C" })).disposition).toBe("dead-lettered");
    const pass = router.retryDeadLetters();
    const joined = router.retryDeadLetters();
    await new Promise((r) => setTimeout(r, 20));
    expect((await router.route({ type: "message", user: "UFOUNDER", text: "approve", ts: "8.2", thread_ts: "T-R2", channel: "C" })).disposition).toBe("dead-lettered");
    release();
    expect(await joined).toEqual(await pass);
    expect(dead.readAll().map((e) => e.ev.ts).sort()).toEqual(["8.1", "8.2"]);
    await router.retryDeadLetters();
    expect(resolved(g1.qitemId)).toBe(1);
    expect(resolved(g2.qitemId)).toBe(1);
    expect(dead.readAll()).toEqual([]);
  });

  it("two routers (two daemons) sharing one journal: overlapping passes and a live failure lose nothing", async () => {
    const journal = join(home, "shared-dead.jsonl");
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    let calls = 0;
    const flaky: typeof resolver = async (input) => {
      calls++;
      if (calls === 1) throw new Error("down"); // 7.1 dead-letters
      if (calls <= 3) {
        await paused; // BOTH routers' passes are mid-flight
        throw new Error("still down");
      }
      if (calls === 4) throw new Error("down again"); // 7.2 dead-letters during the passes
      return resolver(input);
    };
    const map = new ThreadSeatMap(db);
    const router = () =>
      new InboundRouter({
        queue: makeQueuePorts(repo, { loadHumanRegistry: () => registry }),
        seen: new SeenStore(join(home, "shared-seen.jsonl")),
        deadLetter: new DeadLetterStore<SlackEvent>(journal), // a separate store instance per daemon
        destination: "operator-agent@kernel",
        resolveSender: (u) => {
          const r = resolveSlackHandle(u, registry.entities);
          return r.kind === "registered" ? { admitted: true, source: r.address } : { admitted: false, teaching: r.error };
        },
        resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "operator-agent@kernel" }),
        resolveHumanReply: flaky,
      });
    const a = router();
    const b = router();
    const g1 = await gate();
    const g2 = await gate();
    map.open({ threadTs: "T-S1", channel: "C", human: "human-founder@external", seat: "author@rig", conversationId: g1.qitemId });
    map.open({ threadTs: "T-S2", channel: "C", human: "human-founder@external", seat: "author@rig", conversationId: g2.qitemId });
    expect((await a.route({ type: "message", user: "UFOUNDER", text: "approve", ts: "7.1", thread_ts: "T-S1", channel: "C" })).disposition).toBe("dead-lettered");
    const passA = a.retryDeadLetters();
    const passB = b.retryDeadLetters();
    await new Promise((r) => setTimeout(r, 20));
    expect((await a.route({ type: "message", user: "UFOUNDER", text: "approve", ts: "7.2", thread_ts: "T-S2", channel: "C" })).disposition).toBe("dead-lettered");
    release();
    await Promise.all([passA, passB]);
    const inspect = new DeadLetterStore<SlackEvent>(journal);
    expect(inspect.readAll().map((e) => e.ev.ts).sort()).toEqual(["7.1", "7.2"]);
    await b.retryDeadLetters();
    expect(resolved(g1.qitemId)).toBe(1);
    expect(resolved(g2.qitemId)).toBe(1);
    expect(inspect.readAll()).toEqual([]);
  });
});

describe("outbound-only channels", () => {
  it("ntfy and webhook adapters can only send (no inbound reply surface)", () => {
    for (const a of [new NtfyNotificationAdapter({ topicUrl: "https://ntfy.sh/x" }), new WebhookNotificationAdapter({ endpointUrl: "https://example.invalid/h" })]) {
      expect(typeof a.send).toBe("function");
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(a)).filter((k) => k !== "constructor");
      expect(surface.filter((k) => /receive|reply|resolve|poll|inbound/i.test(k))).toEqual([]);
    }
  });
});
