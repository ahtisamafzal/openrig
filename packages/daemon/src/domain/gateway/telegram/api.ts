// Roadmap 5.1 — the Telegram Bot API over Node fetch (no curl). Honors 429 retry_after (bounded), never
// logs the token (errors are redacted), and returns typed results the poller and delivery use.

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean; username?: string };
    chat?: { id: number; type?: string };
    text?: string;
    message_thread_id?: number;
    reply_to_message?: { message_id: number; text?: string; from?: { id: number; is_bot?: boolean } };
  };
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
  }
}

const redact = (s: string, token: string) => (token ? s.split(token).join("<token>") : s);

export interface TelegramApi {
  /** The bot's own identity (its user id authenticates our own messages when they are quoted). */
  getMe(): Promise<{ id: number; username?: string }>;
  getUpdates(offset: number, timeoutSeconds?: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, opts?: { replyTo?: number }): Promise<{ messageId: number }>;
}

export function telegramApi(token: string, opts: { fetchImpl?: FetchImpl; base?: string; maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {}): TelegramApi {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.base ?? "https://api.telegram.org";
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 3;

  async function call<T>(method: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch (err) {
        throw new TelegramApiError(redact(`telegram ${method}: ${(err as Error).message}`, token), true);
      }
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
      if (json.ok) return json.result as T;
      const retryAfter = json.parameters?.retry_after;
      if (res.status === 429 && typeof retryAfter === "number" && attempt < maxRetries) {
        await sleep(Math.min(retryAfter, 60) * 1000);
        continue;
      }
      throw new TelegramApiError(redact(`telegram ${method} -> ${res.status}: ${json.description ?? "error"}`, token), res.status === 429 || res.status >= 500);
    }
  }

  return {
    getMe: async () => {
      const me = await call<{ id: number; username?: string }>("getMe", {});
      return { id: me.id, ...(me.username ? { username: me.username } : {}) };
    },
    getUpdates: (offset, timeoutSeconds = 0) => call<TelegramUpdate[]>("getUpdates", { offset, timeout: timeoutSeconds, allowed_updates: ["message"] }),
    async sendMessage(chatId, text, o = {}) {
      const r = await call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo } } : {}) });
      return { messageId: r.message_id };
    },
  };
}
