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
import { ARETE_GATE_TAG, isGateItem, parseGateDecision } from "../gate-decision.js";
import type { QueueRepository } from "../../queue-repository.js";
import { telegramApi, type TelegramApi, type FetchImpl } from "./api.js";
import { parseIds, parseTelegramUpdate } from "./inbound.js";
import { splitMessage, TELEGRAM_LIMIT } from "./split.js";

export const SECRET_TELEGRAM_TOKEN = "TELEGRAM_BOT_TOKEN";
export const SECRET_TELEGRAM_CHAT = "TELEGRAM_CHAT_ID";

/** How many open requests the "which one?" answer names. */
const OPEN_GATES_SHOWN = 10;

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
  // the journal is CREATED here, at build — never by the first send: the file is fsynced and, where
  // the platform supports directory handles (POSIX), so is its directory entry. On Windows there is
  // no directory fsync (documented limitation: NTFS journals the metadata of the create itself).
  if (!fs.existsSync(refsFile)) {
    const newState = !fs.existsSync(state);
    fs.mkdirSync(state, { recursive: true });
    const fd = fs.openSync(refsFile, "a");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (process.platform !== "win32") {
      // the journal's entry in `state`, and — when `state` itself is new — its entry in `home`
      for (const dir of newState ? [state, opts.home] : [state]) {
        const dfd = fs.openSync(dir, "r");
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      }
    }
  }
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

  /** The delivery receipt (the prefix every delivery-ledger reader matches; `platform=telegram`
   *  names the transport). Once per notification key; an informational update closes on delivery,
   *  exactly as on Slack — never a human decision. */
  function recordPosted(item: QueueItem, key: string, messageId: number): void {
    if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(item.qitemId, key)) return;
    opts.queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "daemon@kernel",
      ...(item.humanIntent === "update" ? { state: "done" as const, closureReason: "no-follow-on" } : {}),
      transitionNote: [
        "slack-owner-notification-posted",
        `notification_key=${key}`,
        `level=${item.ownerNotificationLevel ?? "RECORD"}`,
        `kind=${item.ownerNotificationKind ?? "unclassified"}`,
        ...(messageId ? [`message_ts=${messageId}`, `thread_ts=${messageId}`] : ["message_ts=unknown"]),
        "platform=telegram",
      ].join(" "),
    });
  }

  /** The open approval gates `sender` (a Telegram user id) is the human for. */
  function openGatesOf(sender: string): Array<{ qitemId: string; seat: string; summary: string }> {
    const reg = registry();
    if (!reg.ok) return [];
    const human = resolveSlackHandle(sender, reg.entities, "telegram");
    if (human.kind !== "registered") return [];
    // the query is filtered to THIS human in SQL (no global scan) and bounded: only zero / one /
    // several matters, plus up to 10 names for the "which one?" answer
    const out: Array<{ qitemId: string; seat: string; summary: string }> = [];
    for (const q of opts.queueRepo.openTaggedFor(human.address.split("@")[0]!, ARETE_GATE_TAG, OPEN_GATES_SHOWN + 1)) {
      const hit = ownedBy(q.qitemId, sender);
      if (hit) out.push({ ...hit, summary: q.summary ?? q.qitemId });
    }
    return out;
  }

  /**
   * The exact message a delivery started with (text of every part, and who asked), written durably
   * BEFORE part 1 is sent. A started delivery is finished from this record — not from the current
   * alert list, episode or policy — so nothing that changes afterwards (a newer notification, a
   * stricter dial, the item closing) can strand the rest of a message the human already sees.
   */
  // One file per ACTIVE plan (never an archive): written atomically (temp + fsync + rename) before
  // part 1, deleted once the delivery is complete — delivered message text does not persist here.
  const plansDir = path.join(state, "telegram-plans");
  type Plan = { key: string; qitemId: string; seat: string; parts: string[] };
  const planFile = (key: string) => path.join(plansDir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  function savePlan(plan: Plan): void {
    fs.mkdirSync(plansDir, { recursive: true });
    const file = planFile(plan.key);
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, JSON.stringify(plan));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }
  const dropPlan = (key: string) => fs.rmSync(planFile(key), { force: true });
  function loadPlans(): Map<string, Plan> {
    const out = new Map<string, Plan>();
    let files: string[] = [];
    try {
      files = fs.readdirSync(plansDir).filter((f) => f.endsWith(".json"));
    } catch {
      return out;
    }
    for (const f of files) {
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(plansDir, f), "utf8")) as Plan;
        out.set(plan.key, plan);
      } catch {
        /* unreadable: ignored (never a partial write — plans are renamed into place complete) */
      }
    }
    return out;
  }

  /** Send the parts of `plan` not yet sent (each recorded durably as it goes), then close it out. */
  async function finish(plan: Plan, seen: Set<string>, item: QueueItem | null): Promise<void> {
    let root: number | undefined;
    for (let i = 0; i < plan.parts.length; i++) {
      const done = [...seen].find((id) => id.startsWith(`${plan.key}#part${i}@`));
      if (done) {
        root ??= Number(done.slice(done.lastIndexOf("@") + 1));
        continue;
      }
      // (a crash in the instant between a send and its record can repeat that one part: Telegram
      // offers no idempotent send)
      const { messageId } = await api.sendMessage(postChat!, plan.parts[i]!, root ? { replyTo: root } : {});
      delivered.markDurable(`${plan.key}#part${i}@${messageId}`, "part-sent");
      seen.add(`${plan.key}#part${i}@${messageId}`);
      root ??= messageId;
      messages.put(postChat!, messageId, plan.qitemId, plan.seat);
    }
    delivered.markDurable(`${plan.key}#sent`, "sent"); // fsynced BEFORE the receipt: never re-sent
    if (item) recordPosted(item, plan.key, root ?? 0);
    delivered.mark(plan.key, "delivered");
    dropPlan(plan.key); // complete: the message text is not kept
  }

  async function sweepOnce(): Promise<{ sent: string[]; failed: string[] }> {
    const reg = registry();
    if (!reg.ok) return { sent: [], failed: [] };
    const seen = delivered.load();
    const sent: string[] = [];
    const failed: string[] = [];
    const started = loadPlans();

    // 1. finish every started delivery first, whatever the alert list / episode / policy says now
    for (const plan of started.values()) {
      if (seen.has(plan.key)) {
        dropPlan(plan.key); // delivered before a crash removed it
        continue;
      }
      try {
        await finish(plan, seen, opts.queueRepo.getById(plan.qitemId));
        sent.push(plan.qitemId);
      } catch (e) {
        failed.push(plan.qitemId);
        log(`telegram delivery of ${plan.qitemId} not finished: ${(e as Error).message} — resumed next sweep`);
      }
    }

    // 2. new deliveries: the current alerts, as the policy decides
    for (const item of await ports.listHumanAlerts({ minimumLevel: cfg.minimumLevelThatPosts })) {
      const key = item.notificationKey ?? item.qitemId;
      const human = humanOf(item, reg.entities);
      if (seen.has(key) || started.has(key) || !human?.connectorBindings.some((b) => b.kind === "telegram")) continue;
      if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(item.qitemId, key)) {
        delivered.mark(key, "delivered"); // receipted already (e.g. before this ledger existed)
        continue;
      }
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
        putRef(refToken(item.qitemId), item.qitemId); // durable BEFORE the send
        const plan: Plan = { key, qitemId: item.qitemId, seat: item.sourceSession ?? cfg.inboundDestination, parts: renderParts(item) };
        savePlan(plan); // the exact message, durable before part 1
        await finish(plan, seen, item);
        sent.push(item.qitemId);
      } catch (e) {
        failed.push(item.qitemId);
        log(`telegram delivery failed ${item.qitemId}: ${(e as Error).message} — resumed next sweep`);
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
        let ref = p.replyToBotText && p.replyToFromId === (await ownBotId()) ? refOf(p.replyToBotText, String(p.userId)) : undefined;
        let ambiguous = false;
        if (!ref && p.replyToMessageId === undefined && parseGateDecision(p.text)) {
          const open = openGatesOf(String(p.userId));
          if (open.length === 1) ref = { qitemId: open[0]!.qitemId, seat: open[0]!.seat };
          else if (open.length > 1) {
            ambiguous = true;
            const list = open.slice(0, OPEN_GATES_SHOWN).map((g, i) => `${i + 1}. ${g.summary}`).join("\n");
            const count = open.length > OPEN_GATES_SHOWN ? `more than ${OPEN_GATES_SHOWN}` : String(open.length);
            await api
              .sendMessage(p.chatId, `You have ${count} open requests — nothing was recorded. Reply (swipe left) to the one you mean:\n${list}`, { replyTo: p.messageId })
              .catch(() => undefined);
          }
        }
        if (!ambiguous) {
          if (ref) refFromReply.set(ev.ts!, ref);
          const r = await router.route(ev).finally(() => refFromReply.delete(ev.ts!));
          if (r.replyResolution === "invalid-decision") {
            await api.sendMessage(p.chatId, "Not recorded as a decision. Reply with: approve / revise <direction> / reject", { replyTo: p.messageId }).catch(() => undefined);
          }
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
