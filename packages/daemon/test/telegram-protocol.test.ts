import { describe, it, expect } from "vitest";
import { splitMessage, TELEGRAM_LIMIT } from "../src/domain/gateway/telegram/split.js";
import { telegramApi, TelegramApiError } from "../src/domain/gateway/telegram/api.js";
import { parseIds, parseTelegramUpdate } from "../src/domain/gateway/telegram/inbound.js";

// Roadmap 5.1 — Telegram protocol semantics (R's, with its splitter and inbound-chat gaps fixed).

describe("telegram split", () => {
  it("keeps short text whole; splits on paragraphs, marks continuations, never exceeds the limit", () => {
    expect(splitMessage("hi")).toEqual(["hi"]);
    const para = "a".repeat(3000);
    const parts = splitMessage(`${para}\n\n${para}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(para);
    expect(parts[1]!.startsWith("[continue] ")).toBe(true);
    for (const p of splitMessage("x ".repeat(10_000))) expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
  });
  it("measures UTF-16 units and never cuts a surrogate pair (emoji)", () => {
    const parts = splitMessage("😀".repeat(3000)); // 6000 UTF-16 units, no spaces
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p)).toBe(false); // no lone high surrogate
    }
    expect(parts.join("").replace(/\[continue\] /g, "")).toBe("😀".repeat(3000));
  });
});

describe("telegram inbound (fail closed)", () => {
  const allow = { userIds: new Set([42]), chatIds: new Set([-1001]) };
  const upd = (over: Record<string, unknown> = {}) => ({ update_id: 7, message: { message_id: 3, from: { id: 42 }, chat: { id: -1001 }, text: "approve", ...over } });
  it("accepts an allowed user in an allowed chat, with reply-to correlation", () => {
    const r = parseTelegramUpdate(upd({ reply_to_message: { message_id: 99 } }) as never, allow);
    expect(r).toMatchObject({ ok: true, userId: 42, chatId: -1001, text: "approve", replyToMessageId: 99 });
  });
  it("refuses: unknown user, unknown CHAT (R never checked), bots, empty text, empty allowlists", () => {
    expect(parseTelegramUpdate(upd({ from: { id: 7 } }) as never, allow)).toMatchObject({ ok: false, reason: "user 7 is not allowed" });
    expect(parseTelegramUpdate(upd({ chat: { id: 5 } }) as never, allow)).toMatchObject({ ok: false, reason: "chat 5 is not allowed" });
    expect(parseTelegramUpdate(upd({ from: { id: 42, is_bot: true } }) as never, allow)).toMatchObject({ ok: false });
    expect(parseTelegramUpdate(upd({ text: "   " }) as never, allow)).toMatchObject({ ok: false, reason: "empty text" });
    expect(parseTelegramUpdate(upd() as never, { userIds: new Set(), chatIds: new Set([-1001]) })).toMatchObject({ ok: false });
    expect(parseTelegramUpdate(upd() as never, { userIds: new Set([42]), chatIds: new Set() })).toMatchObject({ ok: false });
  });
  it("id lists drop non-numeric and zero ids", () => {
    expect([...parseIds("42, x, 0, -1001 7")]).toEqual([42, -1001, 7]);
  });
});

describe("telegram api", () => {
  it("honors 429 retry_after, then succeeds; never leaks the token in errors", async () => {
    let calls = 0;
    const slept: number[] = [];
    const api = telegramApi("SECRET-TOKEN", {
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 2 } }), { status: 429 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), { status: 200 });
      },
      sleep: async (ms) => void slept.push(ms),
    });
    expect(await api.sendMessage(1, "hi")).toEqual({ messageId: 55 });
    expect(slept).toEqual([2000]);
    const bad = telegramApi("SECRET-TOKEN", { fetchImpl: async () => { throw new Error("connect to https://api.telegram.org/botSECRET-TOKEN failed"); } });
    const err = await bad.sendMessage(1, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(String((err as Error).message)).not.toContain("SECRET-TOKEN");
  });
});
