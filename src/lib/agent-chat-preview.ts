// What a chat app's message shows of an agent's answer while it is written (server/chat-apps/agent-chat.ts):
// the text so far, escaped as the bot's HTML, cut short and marked as still being written.

import { escapeHtml } from "./telegram-format";

const WRITING = " ✍️";
const MORE = "…";

/**
 * The preview of `text`: escaped, at most `max` characters in all, the mark included. A longer text
 * is cut where its escaped form still fits (an `&` takes five, a `<` four), never inside a
 * character: a cut between the two halves of a surrogate pair leaves a string Telegram refuses.
 * Empty for text with nothing to show yet.
 */
export function livePreview(text: string, max: number): string {
  if (!text.trim()) return "";
  const whole = escapeHtml(text);
  if (whole.length + WRITING.length <= max) return `${whole}${WRITING}`;
  const room = max - MORE.length - WRITING.length;
  let kept = "";
  for (const char of text) {
    const escaped = escapeHtml(char);
    if (kept.length + escaped.length > room) break;
    kept += escaped;
  }
  return `${kept}${MORE}${WRITING}`;
}
