// Telegram platform module — bot-based channel posting.
//
// Auth model: a bot token issued by @BotFather, plus a chat reference
// (a @username for public channels, or a numeric chat id for private
// channels / groups). The user MUST add the bot to the channel as an
// admin with "Post Messages" permission — Telegram itself enforces this
// on the server side; we surface a readable error if it isn't satisfied.
//
// Token shape: "<bot_id>:<35-char-alnum-token>". Stored AES-GCM-encrypted
// in sp_account.enc_access_token.
//
// API base: https://api.telegram.org/bot<TOKEN>/<method>
//
// Validation flow (called from connectTelegramBot):
//   1. GET /getMe — confirms token is valid, returns bot username.
//   2. GET /getChat?chat_id=<chat> — resolves the channel + confirms the
//      bot can see it. Returns id (numeric, stable) + title + username.
//
// Posting: POST /sendMessage with chat_id + text. Telegram's hard text
// limit is 4096 chars per message.

export const TELEGRAM_MAX_CHARS = 4096;

const TOKEN_REGEX = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const API_BASE = "https://api.telegram.org";

export function validateTelegramToken(token: string): string {
  const t = token.trim();
  if (!TOKEN_REGEX.test(t)) {
    throw new Error("Telegram bot token has the wrong shape (expect 123456789:ABC-...).");
  }
  return t;
}

// Normalise the chat reference: accepts @channelname, channelname,
// t.me/channelname URLs, or a bare numeric id. Returns the form Telegram
// wants on the wire — either "@channelname" or "-100<digits>".
export function normalizeTelegramChat(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("Telegram chat id is required.");
  // t.me URLs.
  const m = /^https?:\/\/t\.me\/([A-Za-z0-9_]+)/i.exec(s);
  if (m) s = m[1];
  // Numeric channel ids (private channels start with -100).
  if (/^-?\d+$/.test(s)) return s;
  // Public channel @username.
  if (!s.startsWith("@")) s = `@${s}`;
  if (!/^@[A-Za-z0-9_]{4,}$/.test(s)) {
    throw new Error("Telegram channel name looks malformed.");
  }
  return s;
}

async function tgGet<T>(
  token: string,
  method: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${API_BASE}/bot${token}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  const json = (await res.json().catch(() => null)) as
    | { ok: true; result: T }
    | { ok: false; description?: string; error_code?: number }
    | null;
  if (!json) {
    throw new Error(`Telegram ${method}: non-JSON response (${res.status})`);
  }
  if (!json.ok) {
    throw new Error(`Telegram ${method}: ${json.description ?? "unknown error"}`);
  }
  return json.result;
}

export type TelegramBotInfo = {
  id: number;
  username: string; // without leading @
};

export async function getTelegramBotInfo(
  token: string,
): Promise<TelegramBotInfo> {
  const r = await tgGet<{ id: number; username?: string }>(token, "getMe");
  if (!r.username) {
    throw new Error("Telegram bot has no username (set one in @BotFather).");
  }
  return { id: r.id, username: r.username };
}

export type TelegramChatInfo = {
  id: number;
  title: string;
  username: string | null; // public channel @name without leading @
  type: string; // 'channel' | 'group' | 'supergroup' | 'private'
};

export async function getTelegramChatInfo(input: {
  token: string;
  chatRef: string;
}): Promise<TelegramChatInfo> {
  const chat = normalizeTelegramChat(input.chatRef);
  const r = await tgGet<{
    id: number;
    title?: string;
    username?: string;
    type: string;
  }>(input.token, "getChat", { chat_id: chat });
  return {
    id: r.id,
    title: r.title ?? r.username ?? String(r.id),
    username: r.username ?? null,
    type: r.type,
  };
}

export type TelegramPostResult = {
  messageId: number;
  webUrl: string;
};

export async function sendTelegramMessage(input: {
  token: string;
  chatId: number | string;
  text: string;
}): Promise<TelegramPostResult> {
  const text = input.text.slice(0, TELEGRAM_MAX_CHARS);
  const url = `${API_BASE}/bot${input.token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      text,
      // Markdown rendering would be nice, but inconsistent character escaping
      // across MarkdownV2/HTML burns more support time than it saves. Plain
      // text keeps user expectations clear; UI calls this out.
      disable_web_page_preview: false,
    }),
  });
  const json = (await res.json().catch(() => null)) as
    | { ok: true; result: { message_id: number; chat: { username?: string; id: number } } }
    | { ok: false; description?: string }
    | null;
  if (!json || !("ok" in json)) {
    throw new Error(`Telegram sendMessage: bad response (${res.status})`);
  }
  if (!json.ok) {
    throw new Error(`Telegram sendMessage: ${json.description ?? "unknown error"}`);
  }
  // Permalink format: https://t.me/{username}/{message_id} for public channels,
  // https://t.me/c/{abs_internal_id}/{message_id} for private. Internal-id is
  // the numeric chat id with the "-100" prefix stripped.
  const chat = json.result.chat;
  let webUrl: string;
  if (chat.username) {
    webUrl = `https://t.me/${chat.username}/${json.result.message_id}`;
  } else {
    const abs = String(chat.id).replace(/^-100/, "");
    webUrl = `https://t.me/c/${abs}/${json.result.message_id}`;
  }
  return { messageId: json.result.message_id, webUrl };
}
