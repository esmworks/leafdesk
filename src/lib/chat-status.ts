/**
 * What the AI chat's conversation lists mark beside a conversation (components/ai-chat): an answer
 * being written, an answer waiting for the person's decision on a change, or an answer they haven't
 * read. Import-free: the sidebar's list is in every workspace page's first load.
 */

export type ConversationStatus = "answering" | "waiting" | "unread";

/** What the server says of a conversation (lib/ai-chat.ts ConversationSummary). */
type Summary = { answering?: true; waiting?: true; unread?: true };

/**
 * The one mark a conversation shows: answering wins over waiting, waiting over unread. `here`: what
 * this tab knows, following its answer (newer than the list it last read). `shown`: the person has
 * it in front of them, so nothing in it is unread (the list may not know yet).
 */
export function conversationStatus(c: Summary, here: { answering: boolean; waiting: boolean }, shown: boolean): ConversationStatus | null {
  if (here.answering) return here.waiting ? "waiting" : "answering";
  if (c.answering) return "answering";
  if (c.waiting) return "waiting";
  if (c.unread && !shown) return "unread";
  return null;
}
