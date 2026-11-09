/**
 * Messages' shared rules (server/messages/, components/messages/): kinds, limits and names, with
 * no imports, so the browser's first load can take what it needs of it.
 */

export type ChannelKind = "public" | "private" | "direct";
/** Which messages notify a member: `default` follows the kind (all of a direct conversation, mentions of a channel). */
export type ChannelNotify = "default" | "all" | "mentions" | "none";
export type PostingPolicy = "everyone" | "admins";

/** What a system message says happened, written in each reader's language when shown. */
export type SystemEvent =
  | { event: "created" }
  | { event: "joined" }
  | { event: "left" }
  | { event: "added"; users: string[] }
  | { event: "removed"; users: string[] }
  | { event: "renamed"; from: string; to: string }
  | { event: "topic"; to: string }
  | { event: "description"; to: string }
  | { event: "private"; to: boolean }
  | { event: "archived" }
  | { event: "unarchived" };

/** A message's extras: a system message's event, the message it forwards, how it came. */
export type MessageData = {
  system?: SystemEvent;
  /** A forwarded message, as it was when forwarded (its author, channel and words). */
  forward?: { messageId: string; channelId: string; authorId: string | null; body: string; createdAt: string };
  /** Written by an agent's run (its id): the message shows it. */
  agentRunId?: string;
  /** Came from an import (Slack): who wrote it there, when no person here matched. */
  importedFrom?: { source: "slack"; name: string };
  /** Posted to a channel's webhook (server/messages/webhooks.ts): it has no author and shows the webhook's name. */
  webhook?: { id: string; name: string };
  /** Posted by an automation's "Post in a channel" step, as its person: the message names it. */
  automation?: { id: string; name: string };
  /** Cards of the web links in its words, fetched by the server after it was sent or edited (server/messages/link-previews.ts). */
  previews?: MessagePreview[];
  /** Its author took the previews away: none are fetched for it again. */
  previewsHidden?: boolean;
};

/** A web link's card under a message (lib/message-links). */
export type MessagePreview = { url: string; title: string; description: string; image: string; favicon: string; siteName: string };

export const MESSAGE_LIMITS = {
  /** Characters of a message's Markdown. */
  body: 40_000,
  /** Files in one message. */
  files: 10,
  /** People in a direct conversation, the person included. */
  directPeople: 9,
  /** Characters of a channel's name, topic and description. */
  name: 80,
  topic: 250,
  description: 1000,
  /** Different emoji on one message, and characters of one. */
  reactions: 50,
  emoji: 32,
  /** Messages in one page of a channel's history. */
  page: 50,
  /** Characters of a status. */
  status: 100,
  /** Sections of one person's channel list. */
  sections: 30,
} as const;

/** How long after it is sent its writer may still edit a message: always. Delete too. Kept as a rule for the day an owner wants one. */
export const EDIT_WINDOW_MS = Infinity;

/** People typing are shown this long after their last keystroke's notice; the box sends one at most this often. */
export const TYPING_SHOWN_MS = 6000;
export const TYPING_EVERY_MS = 3000;

/**
 * A channel's name as typed, made into one: lowercase, spaces and dots to `-`, nothing but letters,
 * digits, `-` and `_` (any script's letters, so "satış" and "設計" stay), no `-` at either end.
 * Lowercased without a locale: the same on the server and in every browser ("İ" becomes "i̇", which
 * the letters rule keeps, as typed in Turkish).
 */
export function channelName(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/[\s.]+/g, "-")
    .replace(/[^\p{L}\p{M}\p{N}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MESSAGE_LIMITS.name);
}

/** Why a name can't be a channel's, or null when it can (it must already be `channelName`'s own result). */
export function channelNameError(name: string): "empty" | "tooLong" | "invalid" | null {
  if (!name) return "empty";
  if (name.length > MESSAGE_LIMITS.name) return "tooLong";
  if (channelName(name) !== name) return "invalid";
  return null;
}

/** The key of a direct conversation between these people: their distinct ids, sorted. */
export function directKey(userIds: Iterable<string>): string {
  return [...new Set(userIds)].sort().join(",");
}

/** Whether a reaction is one emoji (with its skin tone or joiners), not words. */
export function isEmoji(text: unknown): text is string {
  if (typeof text !== "string" || !text || text.length > MESSAGE_LIMITS.emoji) return false;
  if (/[\p{L}\p{N}\s]/u.test(text.replace(/[\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}]/gu, "").replace(/[#*0-9]\u{FE0F}?\u{20E3}/gu, ""))) return false;
  return /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\u{FE0F}?\u{20E3}/u.test(text);
}

/** A message id from a client: a UUID, which the sender's client makes so a retry stores it once. */
export function isMessageId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Who a member's notifications come for when they left it at `default`. */
export function notifyLevel(notify: ChannelNotify, kind: ChannelKind): Exclude<ChannelNotify, "default"> {
  if (notify !== "default") return notify;
  return kind === "direct" ? "all" : "mentions";
}

/** What the Messages place shows besides a channel. */
export const MESSAGE_VIEWS = ["threads", "activity", "saved", "drafts", "search", "browse"] as const;
export type MessagesView = (typeof MESSAGE_VIEWS)[number];

/**
 * Where the Messages place is: a channel (`c`), a thread open beside it (`t`), a message to show
 * (`m`), or one of its other views (`v`, a search's words in `q`). All in the query, so the page
 * moves between them with `history.pushState` and no round trip to the server.
 */
export type MessagesAt = { channelId?: string | null; threadId?: string | null; messageId?: string | null; view?: MessagesView | null; query?: string | null };

/** The address of a place in Messages. */
export function messagesPath(workspaceId: string, at?: MessagesAt | null): string {
  const params = new URLSearchParams();
  if (at?.view) params.set("v", at.view);
  if (at?.query) params.set("q", at.query);
  if (at?.channelId) params.set("c", at.channelId);
  if (at?.threadId) params.set("t", at.threadId);
  if (at?.messageId) params.set("m", at.messageId);
  const query = params.toString();
  return `/w/${workspaceId}/messages${query ? `?${query}` : ""}`;
}

/** Reads `messagesPath`'s query back. */
export function messagesAt(search: string | URLSearchParams): MessagesAt {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const view = params.get("v");
  return {
    view: (MESSAGE_VIEWS as readonly string[]).includes(view ?? "") ? (view as MessagesView) : null,
    query: params.get("q"),
    channelId: params.get("c"),
    threadId: params.get("t"),
    messageId: params.get("m"),
  };
}
