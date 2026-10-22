import { env } from "@/lib/env";

/**
 * The few Bot API methods the Telegram bridge uses (https://core.telegram.org/bots/api), over
 * TELEGRAM_API_URL with the bot's token. Errors come back as TelegramApiError with Telegram's own
 * code and description; the token is never part of an error or a log line.
 */

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    /** Telegram's error_code (an HTTP status), 0 when the request didn't get an answer. */
    readonly code: number,
    message: string,
    /** Seconds to wait before asking again (429). */
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${message}`);
    this.name = "TelegramApiError";
  }
}

export type TelegramUser = { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string; language_code?: string };
export type TelegramChat = { id: number; type: "private" | "group" | "supergroup" | "channel" };
export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
};
export type TelegramCallbackQuery = { id: string; from: TelegramUser; message?: TelegramMessage; data?: string };
export type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery };

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

/** What a sent message may carry beside its text. */
export type SendOptions = { keyboard?: InlineKeyboard; plain?: boolean };

/** How long getUpdates waits for something to come, in seconds. */
export const POLL_SECONDS = 50;

const apiUrl = (method: string) => `${env.telegramApiUrl}/bot${env.telegramBotToken}/${method}`;

/** Calls a Bot API method with a JSON body; its `result`, or TelegramApiError. */
export async function callApi<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  if (!env.telegramBotToken) throw new TelegramApiError(method, 0, "TELEGRAM_BOT_TOKEN is not set");
  let response: Response;
  try {
    response = await fetch(apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      // getUpdates holds the request open for POLL_SECONDS; every other call is quick.
      signal: AbortSignal.any([AbortSignal.timeout(method === "getUpdates" ? (POLL_SECONDS + 15) * 1000 : 30_000), ...(signal ? [signal] : [])]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TelegramApiError(method, 0, error instanceof Error ? error.name : "network error");
  }
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  } | null;
  if (!body?.ok) {
    throw new TelegramApiError(method, body?.error_code ?? response.status, body?.description ?? `HTTP ${response.status}`, body?.parameters?.retry_after);
  }
  return body.result as T;
}

/** Downloads a file a message carries (a voice message), at most `maxBytes` of it. */
export async function downloadFile(fileId: string, maxBytes: number, signal?: AbortSignal): Promise<Blob> {
  const file = await callApi<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId }, signal);
  if (!file.file_path) throw new TelegramApiError("getFile", 0, "The file can't be downloaded");
  if (file.file_size && file.file_size > maxBytes) throw new TelegramApiError("getFile", 413, "The file is too large");
  const response = await fetch(`${env.telegramApiUrl}/file/bot${env.telegramBotToken}/${file.file_path}`, {
    signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new TelegramApiError("getFile", response.status, `HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size > maxBytes) throw new TelegramApiError("getFile", 413, "The file is too large");
  return blob;
}

/** Sends a message in HTML (or as plain text); the sent message's id. */
export async function sendMessage(chatId: string, text: string, options: SendOptions = {}): Promise<number> {
  const sent = await callApi<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    ...(options.plain ? {} : { parse_mode: "HTML" }),
    link_preview_options: { is_disabled: true },
    ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
  });
  return sent.message_id;
}

/** Replaces a message's text (and drops its buttons, unless new ones are given). */
export async function editMessage(chatId: string, messageId: number, text: string, options: SendOptions = {}) {
  await callApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(options.plain ? {} : { parse_mode: "HTML" }),
    link_preview_options: { is_disabled: true },
    reply_markup: options.keyboard ?? { inline_keyboard: [] },
  });
}

/** Replaces a message's buttons, taking them away when none are given. */
export async function editButtons(chatId: string, messageId: number, keyboard?: InlineKeyboard) {
  await callApi("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: keyboard ?? { inline_keyboard: [] } });
}

/** Shows "typing…" in the chat for a few seconds. */
export async function sendTyping(chatId: string) {
  await callApi("sendChatAction", { chat_id: chatId, action: "typing" });
}

/** Answers a button press (stops its spinner), with a short notice when given. */
export async function answerCallback(callbackId: string, text?: string) {
  await callApi("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
}
