// Roadmap 5.1 — the Telegram human gateway, inside O's gateway subsystem (not R's standalone poller).
// It shares Slack's human registry (bindings of kind "telegram", handle = Telegram user id), queue
// admission (InboundRouter: admit-iff-registered, seen dedup, dead-letter), reply resolution (the
// shared resolver: gate items accept only approve / revise / reject) and delivery policy
// (decideDelivery over the same dials). R's protocol semantics are kept: fail-closed user AND chat
// allowlists, a durable update offset, one poller per daemon (Telegram answers 409 to a second).
//
// Outbound does not use a second dispatcher: DispatchBuffer is one file per home, and the queue is
// already the durable source — a sweep re-selects anything not in the delivered ledger (at-least-once,
// marked only after every part is sent).

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { GatewayWire } from "../gateway-subsystem.js";
import { loadConfig } from "../slack/config.js";
import { resolveSecret } from "../slack/secrets.js";
import { SeenStore, DeadLetterStore } from "../slack/state-store.js";
import { makeQueuePorts, type QueueItem } from "../slack/queue-access.js";
import { InboundRouter, type SlackEvent } from "../slack/inbound.js";
import { loadHumanRegistry, resolveSlackHandle, type HumanFragment } from "../human-registry.js";
import { decideDelivery, isEscalationClass, resolveAvailability } from "../delivery-rules-engine.js";
import { isGateItem } from "../gate-decision.js";
import type { QueueRepository } from "../../queue-repository.js";
import { telegramApi, type TelegramApi, type FetchImpl } from "./api.js";
import { parseIds, parseTelegramUpdate } from "./inbound.js";
import { splitMessage, TELEGRAM_LIMIT } from "./split.js";

export const SECRET_TELEGRAM_TOKEN = "TELEGRAM_BOT_TOKEN";
export const SECRET_TELEGRAM_CHAT = "TELEGRAM_CHAT_ID";

type ReplyResolution = "resolved" | "already-resolved" | "not-applicable" | "invalid-decision";

export interface TelegramServiceOpts {
  home: string;
  queueRepo: QueueRepository;
  resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string }) => Promise<ReplyResolution>;
  log?: (msg: string) => void;
  /** Test seams. */
  api?: TelegramApi;
  fetchImpl?: FetchImpl;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  loadRegistry?: () => ReturnType<typeof loadHumanRegistry>;
}

export interface TelegramService {
  ready: boolean;
  startServices(): void;
  stop(): void;
  status(): Record<string, unknown>;
  sweepOnce(): Promise<{ sent: string[]; failed: string[] }>;
  pollOnce(): Promise<{ handled: number }>;
}

/** sent message -> the qitem it asked about (reply correlation survives restarts). */
class MessageMap {
  constructor(private readonly file: string) {}
  get(chatId: number, messageId: number): { qitemId: string; seat: string } | undefined {
    let raw = "";
    try { raw = fs.readFileSync(this.file, "utf8"); } catch { return undefined; }
    const key = `${chatId}:${messageId}`;
    for (const line of raw.split("\n").reverse()) {
      try {
        const r = JSON.parse(line) as { key: string; qitemId: string; seat: string };
        if (r.key === key) return r;
      } catch { /* torn tail line */ }
    }
    return undefined;
  }
  put(chatId: number, messageId: number, qitemId: string, seat: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ key: `${chatId}:${messageId}`, qitemId, seat }) + "\n");
  }
}

function readOffset(file: string): number {
  try {
    const n = (JSON.parse(fs.readFileSync(file, "utf8")) as { offset?: unknown }).offset;
    return typeof n === "number" && Number.isSafeInteger(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeOffset(file: string, offset: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ offset }));
  fs.renameSync(tmp, file);
}

const telegramHandles = (entities: readonly HumanFragment[]): Set<number> =>
  parseIds(entities.flatMap((e) => e.connectorBindings.filter((b) => b.kind === "telegram" && b.handle).map((b) => b.handle!)).join(","));

/** A bounded opaque correlation token for any qitem id (a caller-chosen id can be any size). */
export const refToken = (qitemId: string) => createHash("sha256").update(qitemId).digest("hex").slice(0, 24);

/** The message parts; EVERY part ends with `ref <token>`, so a reply to any part (the root
 *  included) can be correlated even when its map row was lost. The token -> qitem mapping is
 *  persisted BEFORE the send (see sweepOnce). */
function renderParts(item: QueueItem): string[] {
  const lines = [item.summary ?? "(no summary)"];
  if (item.body) lines.push("", item.body);
  if (item.humanDetail) lines.push("", item.humanDetail);
  if (isGateItem(item.tags)) lines.push("", "Reply to this message with: approve / revise <direction> / reject");
  const ref = `\n\nref ${refToken(item.qitemId)}`;
  return splitMessage(lines.join("\n"), TELEGRAM_LIMIT - ref.length).map((part) => part + ref);
}

export function buildTelegramService(opts: TelegramServiceOpts): TelegramService {
  const log = opts.log ?? (() => {});
  const cfg = loadConfig(opts.home);
  const lookup = { envFile: cfg.secretsEnvFile ?? undefined, ...(opts.env ? { env: opts.env } : {}), onRefused: (why: string) => log(`telegram secrets env file refused: ${why}`) };
  const token = resolveSecret(SECRET_TELEGRAM_TOKEN, lookup);
  const chatIds = parseIds(resolveSecret(SECRET_TELEGRAM_CHAT, lookup) ?? undefined);
  const postChat = [...chatIds][0];
  const ready = token !== null && postChat !== undefined;
  const missing = token === null ? "TELEGRAM_BOT_TOKEN unresolved" : "TELEGRAM_CHAT_ID unresolved";
  if (!ready) {
    log(`telegram not configured (${missing}) — inert`);
    const inert = async () => ({ sent: [], failed: [] });
    return { ready, startServices() {}, stop() {}, status: () => ({ platform: "telegram", ready, missing }), sweepOnce: inert, pollOnce: async () => ({ handled: 0 }) };
  }

  const api = opts.api ?? telegramApi(token!, { fetchImpl: opts.fetchImpl });
  const registry = opts.loadRegistry ?? (() => loadHumanRegistry(opts.home));
  const ports = makeQueuePorts(opts.queueRepo, { loadHumanRegistry: registry });
  const state = path.join(opts.home, "state");
  const delivered = new SeenStore(path.join(state, "telegram-delivered.jsonl"));
  const messages = new MessageMap(path.join(state, "telegram-message-map.jsonl"));
  const refsFile = path.join(state, "telegram-refs.jsonl");
  // DURABLE before the send: the record is flushed to stable storage (fsync); a failure throws, so
  // the notification is withheld and retried by the next sweep rather than sent uncorrelatable.
  // ponytail: the parent directory entry is not fsynced (Windows has no directory fsync); the
  // state directory already exists after the first run.
  const putRef = (token: string, qitemId: string) => {
    fs.mkdirSync(state, { recursive: true });
    const fd = fs.openSync(refsFile, "a");
    try {
      fs.writeSync(fd, JSON.stringify({ token, qitemId }) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const qitemForToken = (token: string): string | undefined => {
    let raw = "";
    try { raw = fs.readFileSync(refsFile, "utf8"); } catch { return undefined; }
    for (const line of raw.split("\n").reverse()) {
      try {
        const r = JSON.parse(line) as { token: string; qitemId: string };
        if (r.token === token) return r.qitemId;
      } catch { /* torn tail line */ }
    }
    return undefined;
  };
  const offsetFile = path.join(state, "telegram-offset.json");

  const router = new InboundRouter({
    queue: ports,
    seen: new SeenStore(path.join(state, "telegram-inbound-seen.jsonl")),
    deadLetter: new DeadLetterStore<SlackEvent>(path.join(state, "telegram-inbound-deadletter.jsonl")),
    destination: cfg.inboundDestination,
    resolveSender: (userId) => {
      const reg = registry();
      if (!reg.ok) return { admitted: false, teaching: `human registry unavailable — inbound refused (fail-closed): ${reg.error}` };
      const r = resolveSlackHandle(userId, reg.entities, "telegram");
      return r.kind === "registered" ? { admitted: true, source: r.address } : { admitted: false, teaching: r.error };
    },
    // a reply to a delivered message goes to exactly the seat that asked, correlated to its qitem;
    // anything else is an unrouted signal to the inbound destination (never guessed)
    resolveRoute: (ev) => {
      const [chat, replyTo] = [Number(ev.channel), Number(ev.thread_ts)];
      const mapped = ev.thread_ts ? messages.get(chat, replyTo) : undefined;
      // BOTH correlation paths require the replier to be the human the qitem is assigned to: in a
      // shared chat one registered human must never resolve another human's gate
      if (mapped && !ownedBy(mapped.qitemId, ev.user ?? "")) log(`telegram reply by ${ev.user} to ${mapped.qitemId} refused: not that item's human`);
      const hit = (mapped && ownedBy(mapped.qitemId, ev.user ?? "") ? mapped : undefined) ?? refFromReply.get(ev.ts ?? "");
      return hit
        ? { destination: hit.seat, tags: ["founder-telegram", "inbound", "thread", `reply-to:${hit.qitemId}`], correlationQitemId: hit.qitemId }
        : { destination: cfg.inboundDestination, tags: ["founder-telegram", "inbound", "unrouted-signal"] };
    },
    resolveHumanReply: opts.resolveHumanReply,
    log,
  });

  // A crash between sendMessage and the map write leaves no map row; the reply still quotes our own
  // message, whose last line is `ref <qitemId>`. It is used only when that qitem exists and names the
  // replying human (validated below), and routes to the qitem's asking seat.
  const refFromReply = new Map<string, { qitemId: string; seat: string }>();
  const refOf = (botText: string | undefined, sender: string): { qitemId: string; seat: string } | undefined => {
    const token = botText ? /(?:^|\n)ref ([0-9a-f]{24})\s*$/.exec(botText)?.[1] : undefined;
    const id = token ? qitemForToken(token) : undefined;
    return id ? ownedBy(id, sender) : undefined;
  };
  /** The qitem and its asking seat when `sender` (a Telegram user id) is the human it is assigned to. */
  function ownedBy(qitemId: string, sender: string): { qitemId: string; seat: string } | undefined {
    const q = opts.queueRepo.getById(qitemId);
    if (!q) return undefined;
    const reg = registry();
    if (!reg.ok) return undefined;
    const human = resolveSlackHandle(sender, reg.entities, "telegram");
    if (human.kind !== "registered") return undefined;
    const local = human.address.split("@")[0];
    const names = (s: string | null | undefined) => (s ?? "").split("@")[0] === local;
    if (names(q.destinationSession)) return { qitemId: q.qitemId, seat: q.sourceSession };
    if (names(q.blockedOn)) return { qitemId: q.qitemId, seat: q.destinationSession };
    return undefined;
  }

  const humanOf = (item: QueueItem, entities: readonly HumanFragment[]) =>
    entities.find((e) => e.entityId === (item.destinationSession ?? "").split("@")[0]);

  async function sweepOnce(): Promise<{ sent: string[]; failed: string[] }> {
    const reg = registry();
    if (!reg.ok) return { sent: [], failed: [] };
    const seen = delivered.load();
    const sent: string[] = [];
    const failed: string[] = [];
    for (const item of await ports.listHumanAlerts({ minimumLevel: cfg.minimumLevelThatPosts })) {
      const key = item.notificationKey ?? item.qitemId;
      const human = humanOf(item, reg.entities);
      if (seen.has(key) || !human?.connectorBindings.some((b) => b.kind === "telegram")) continue;
      // ponytail: Telegram posts the immediate outcomes only; log/digest/deferred stay with the
      // Slack path's digest flush + deferral jobs (Slack-only today). Add a Telegram arm when needed.
      const d = decideDelivery({
        level: item.ownerNotificationLevel ?? null,
        escalation: item.humanIntent !== "update" && isEscalationClass(item.tags),
        human: { entityId: human.entityId, deliveryClass: human.prefs.deliveryClass, availability: resolveAvailability(human.prefs) },
        dials: { minimumLevelThatPosts: cfg.minimumLevelThatPosts, minimumLevelThatInterrupts: cfg.minimumLevelThatInterrupts },
      });
      if (d.outcome !== "interrupt" && d.outcome !== "notify") continue;
      if (d.deferMinutes !== undefined) continue;
      try {
        let root: number | undefined;
        putRef(refToken(item.qitemId), item.qitemId); // durable BEFORE the send
        for (const part of renderParts(item)) {
          const { messageId } = await api.sendMessage(postChat!, part, root ? { replyTo: root } : {});
          root ??= messageId;
          messages.put(postChat!, messageId, item.qitemId, item.sourceSession ?? cfg.inboundDestination);
        }
        delivered.mark(key, "delivered");
        sent.push(item.qitemId);
      } catch (e) {
        failed.push(item.qitemId);
        log(`telegram delivery failed ${item.qitemId}: ${(e as Error).message} — retried next sweep`);
      }
    }
    return { sent, failed };
  }

  async function pollOnce(): Promise<{ handled: number }> {
    const reg = registry();
    const allow = { userIds: reg.ok ? telegramHandles(reg.entities) : new Set<number>(), chatIds };
    let offset = readOffset(offsetFile);
    const updates = await api.getUpdates(offset);
    for (const u of updates) {
      const p = parseTelegramUpdate(u, allow);
      if (p.ok) {
        const ev: SlackEvent = { type: "message", user: String(p.userId), text: p.text, ts: `tg-${p.updateId}`, channel: String(p.chatId), ...(p.replyToMessageId ? { thread_ts: String(p.replyToMessageId) } : {}) };
        // a quoted ref counts only when the quoted message is OUR bot's (never another bot's)
        const ref = p.replyToBotText && p.replyToFromId === (await ownBotId()) ? refOf(p.replyToBotText, String(p.userId)) : undefined;
        if (ref) refFromReply.set(ev.ts!, ref);
        const r = await router.route(ev).finally(() => refFromReply.delete(ev.ts!));
        if (r.replyResolution === "invalid-decision") {
          await api.sendMessage(p.chatId, "Not recorded as a decision. Reply with: approve / revise <direction> / reject", { replyTo: p.messageId }).catch(() => undefined);
        }
      } else {
        log(`telegram update ${u.update_id} refused: ${p.reason}`);
      }
      // a failed landing is dead-lettered durably by the router; a crash before this write re-polls
      // the update and the router's seen ledger absorbs it
      offset = Math.max(offset, u.update_id + 1);
      writeOffset(offsetFile, offset);
    }
    return { handled: updates.length };
  }

  let botId: number | undefined;
  const ownBotId = async () => (botId ??= (await api.getMe()).id);

  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let lastError: string | null = null;
  const tick = async () => {
    if (busy) return; // one poller per daemon; a second daemon gets Telegram's 409, surfaced below
    busy = true;
    try {
      await pollOnce();
      await router.retryDeadLetters();
      await sweepOnce();
      lastError = null;
    } catch (e) {
      lastError = (e as Error).message;
      log(`telegram tick failed: ${lastError}`);
    } finally {
      busy = false;
    }
  };

  return {
    ready,
    startServices() {
      if (timer) return;
      timer = setInterval(() => void tick(), opts.intervalMs ?? 5000);
      timer.unref?.();
      void tick();
      log("telegram gateway started (subsystem path)");
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    status: () => ({ platform: "telegram", ready, running: timer !== undefined, lastError }),
    sweepOnce,
    pollOnce,
  };
}

/** Run Telegram beside the Slack wire: one GatewayWire, both platforms' services. */
export function withTelegram(wire: GatewayWire, tg: TelegramService): GatewayWire {
  if (!tg.ready) return { ...wire, status: () => ({ ...(wire.status?.() ?? {}), telegram: tg.status() }) };
  return {
    ...wire,
    startServices: () => {
      wire.startServices?.();
      tg.startServices();
    },
    stop: () => {
      tg.stop();
      wire.stop();
    },
    status: () => ({ ...(wire.status?.() ?? {}), telegram: tg.status() }),
  };
}
