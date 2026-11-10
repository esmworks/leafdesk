import { htmlToText } from "@/lib/telegram-format";
import type { Buttons, Transport } from "@/server/chat-apps/transport";
import { answerCallback, downloadFile, editButtons, editMessage, sendDocument, sendMessage, sendTyping, TelegramApiError, type InlineKeyboard } from "./api";

/**
 * Telegram as a chat app of the bot (server/chat-apps): the core's HTML goes as Telegram's own
 * HTML, again as plain text when Telegram can't parse its markup (400); buttons are an inline
 * keyboard, notices the press's toast, a note asked for a reply box (forceReply).
 */

const keyboardOf = (buttons: Buttons | undefined): InlineKeyboard | undefined =>
  buttons && { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? "" }))) };

/** Whether a refusal is of the markup (400, other than "not modified"): sent again as plain text. */
const badMarkup = (error: unknown) => error instanceof TelegramApiError && error.code === 400 && error.kind !== "notModified";

export const telegramTransport: Transport = {
  channel: "telegram",
  name: "Telegram",
  canEdit: true,
  canType: true,
  messageLimit: 4000,
  commandPrefix: "/",
  linkCommand: "start",

  async send(chat, text, options = {}) {
    const sendOptions = { keyboard: keyboardOf(options.buttons), ...(options.replyTo ? { replyTo: Number(options.replyTo) } : {}) };
    if (options.plain) return String(await sendMessage(chat, text, { ...sendOptions, plain: true }));
    try {
      return String(await sendMessage(chat, text, sendOptions));
    } catch (error) {
      if (!badMarkup(error)) throw error;
      return String(await sendMessage(chat, htmlToText(text), { ...sendOptions, plain: true }));
    }
  },

  async edit(chat, messageId, text, buttons) {
    const keyboard = keyboardOf(buttons);
    try {
      await editMessage(chat, Number(messageId), text, { keyboard });
    } catch (error) {
      if (!badMarkup(error)) throw error;
      await editMessage(chat, Number(messageId), htmlToText(text), { keyboard, plain: true });
    }
  },

  async editButtons(chat, messageId, buttons) {
    await editButtons(chat, Number(messageId), keyboardOf(buttons));
  },

  async typing(chat) {
    await sendTyping(chat);
  },

  async answerButton(press, notice) {
    await answerCallback(press.callbackId, notice);
  },

  async askForReply(chat, prompt, placeholder, about) {
    return String(await sendMessage(chat, prompt, { forceReply: placeholder, replyTo: Number(about) }));
  },

  downloadFile: (file, maxBytes, signal) => downloadFile(file.ref, maxBytes, signal),

  async sendDocument(chat, file, caption) {
    await sendDocument(chat, file, caption);
  },
};
