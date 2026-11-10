import { commandOf, handleEvent } from "@/server/chat-apps/bot";
import type { ChatEvent, Sender } from "@/server/chat-apps/transport";
import { answerCallback, type TelegramUpdate, type TelegramUser } from "./api";
import { telegramTransport } from "./transport";

/**
 * Telegram's updates as the chat-app bot's events (server/chat-apps/bot.ts): messages from people
 * (never from bots), with their voice message (or audio), document and the bot's question they
 * answer; button presses on the bot's messages.
 */

export { commandOf } from "@/server/chat-apps/bot";

const senderOf = (from: TelegramUser): Sender => ({
  id: String(from.id),
  name: [from.first_name, from.last_name].filter(Boolean).join(" "),
  username: from.username ?? null,
  languageCode: from.language_code,
});

/** An update as the bot's event; null for one it doesn't take. */
export function eventOf(update: TelegramUpdate): ChatEvent | null {
  const query = update.callback_query;
  if (query) {
    if (!query.message) return null;
    return {
      kind: "button",
      from: senderOf(query.from),
      chat: { id: String(query.message.chat.id) },
      messageId: String(query.message.message_id),
      messageText: query.message.text ?? "",
      data: query.data ?? "",
      callbackId: query.id,
    };
  }
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  const text = message.text ?? "";
  const voice = message.voice ?? message.audio;
  const document = message.document;
  return {
    kind: "message",
    from: senderOf(message.from),
    chat: { id: String(message.chat.id), private: message.chat.type === "private" },
    text,
    command: commandOf(text),
    ...(message.caption ? { caption: message.caption } : {}),
    ...(voice ? { voice: { ref: voice.file_id, duration: voice.duration, mimeType: voice.mime_type } } : {}),
    ...(document ? { document: { ref: document.file_id, name: document.file_name, mimeType: document.mime_type, size: document.file_size } } : {}),
    ...(message.reply_to_message ? { replyTo: String(message.reply_to_message.message_id) } : {}),
  };
}

/** Handles one update from Telegram; never throws (a failure is logged). */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const event = eventOf(update);
  // A press on a message Telegram no longer has: only its spinner to stop.
  if (!event) {
    if (update.callback_query) await answerCallback(update.callback_query.id).catch((error) => console.error("[telegram] update failed", error instanceof Error ? error.message : error));
    return;
  }
  await handleEvent(telegramTransport, event);
}
