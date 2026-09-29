// Roadmap 5.1 — Telegram inbound parsing with R's fail-closed allowlists, plus the chat check R never
// applied on inbound: an update is accepted only from an allowed USER in an allowed CHAT. An empty
// allowlist accepts nobody (fail closed). Bots, missing ids and empty text are refused with a reason.

import type { TelegramUpdate } from "./api.js";

export interface TelegramAllowlist {
  userIds: ReadonlySet<number>;
  chatIds: ReadonlySet<number>;
}

export type ParsedInbound =
  | { ok: true; updateId: number; userId: number; chatId: number; messageId: number; text: string; replyToMessageId?: number; replyToBotText?: string; replyToFromId?: number; threadId?: number }
  | { ok: false; updateId: number; reason: string };

/** Parse an id list (comma / space separated); non-numeric and zero ids are dropped (as R). */
export function parseIds(raw: string | undefined): Set<number> {
  const out = new Set<number>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    if (!/^-?\d+$/.test(part)) continue;
    const n = Number(part);
    if (Number.isSafeInteger(n) && n !== 0) out.add(n);
  }
  return out;
}

export function parseTelegramUpdate(u: TelegramUpdate, allow: TelegramAllowlist): ParsedInbound {
  const m = u.message;
  const no = (reason: string): ParsedInbound => ({ ok: false, updateId: u.update_id, reason });
  if (!m) return no("not a message");
  if (!allow.userIds.size) return no("no allowed users configured (fail closed)");
  if (!allow.chatIds.size) return no("no allowed chats configured (fail closed)");
  const userId = m.from?.id;
  if (typeof userId !== "number") return no("missing sender");
  if (m.from?.is_bot) return no("sender is a bot");
  if (!allow.userIds.has(userId)) return no(`user ${userId} is not allowed`);
  const chatId = m.chat?.id;
  if (typeof chatId !== "number") return no("missing chat");
  if (!allow.chatIds.has(chatId)) return no(`chat ${chatId} is not allowed`);
  const text = (m.text ?? "").trim();
  if (!text) return no("empty text");
  return {
    ok: true,
    updateId: u.update_id,
    userId,
    chatId,
    messageId: m.message_id,
    text,
    ...(m.reply_to_message ? { replyToMessageId: m.reply_to_message.message_id } : {}),
    // only a BOT message's text can carry the correlation reference (a human cannot forge one by quoting)
    ...(m.reply_to_message?.from?.is_bot && m.reply_to_message.text ? { replyToBotText: m.reply_to_message.text, replyToFromId: m.reply_to_message.from.id } : {}),
    ...(typeof m.message_thread_id === "number" ? { threadId: m.message_thread_id } : {}),
  };
}
