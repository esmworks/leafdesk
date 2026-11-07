/**
 * What the Messages websocket (`MESSAGES_PATH`, server/messages/socket.ts) carries, both ways, as
 * JSON frames. The browser calls (`call`, answered by a `result` with the same `id`) and the server
 * sends `changes` as they happen, plus typing and presence, which are kept nowhere.
 *
 * Everything a client keeps carries the `rev` of the write that last changed it. `changes` are
 * idempotent: a client may apply the same ones twice. After a lost connection it calls `sync` with
 * the `rev` of its last `bootstrap` or `sync` and gets everything changed since, which keeps it
 * whole even when live changes were missed while it was away.
 */
import type { ChannelKind, ChannelNotify, MessageData, PostingPolicy } from "./messages";

export const MESSAGES_PATH = "/messages-socket";

/** The browser pings this often; the server closes a connection it hasn't heard from in three times as long. */
export const PING_EVERY_MS = 25_000;

export type ChannelView = {
  id: string;
  kind: ChannelKind;
  name: string | null;
  topic: string;
  description: string;
  posting: PostingPolicy;
  joinNew: boolean;
  createdBy: string | null;
  createdAt: string;
  archivedAt: string | null;
  lastSeq: number;
  lastMessageAt: string | null;
  memberCount: number;
  /** A direct conversation's people, in order; empty for a channel (`members` lists its people). */
  people: string[];
  rev: number;
};

/** The person's own membership of a channel. */
export type MembershipView = {
  channelId: string;
  role: "admin" | "member";
  joinedAt: string;
  lastReadSeq: number;
  /** Unread messages in the channel's main list as the server counted them (at most 99), not the person's own. */
  unread: number;
  mentions: number;
  notify: ChannelNotify;
  muted: boolean;
  starred: boolean;
  hidden: boolean;
  sectionId: string | null;
  rev: number;
};

export type FileView = { id: string; url: string; name: string; contentType: string; size: number; width: number | null; height: number | null };
export type ReactionView = { emoji: string; userIds: string[] };

export type MessageView = {
  id: string;
  channelId: string;
  seq: number;
  threadId: string | null;
  authorId: string | null;
  kind: "message" | "system";
  body: string;
  data: MessageData | null;
  alsoInChannel: boolean;
  replyCount: number;
  lastReplySeq: number;
  lastReplyAt: string | null;
  repliers: string[];
  editedAt: string | null;
  deletedAt: string | null;
  pinnedAt: string | null;
  pinnedBy: string | null;
  createdAt: string;
  reactions: ReactionView[];
  files: FileView[];
  rev: number;
};

/** A thread the person follows, or did. */
export type ThreadView = { threadId: string; channelId: string; following: boolean; lastReadSeq: number; mentions: number; lastReplyAt: string | null; rev: number };
export type DraftView = { channelId: string; threadId: string; body: string; fileIds: string[]; updatedAt: string; rev: number };
export type SavedView = { messageId: string; channelId: string; createdAt: string; remindAt: string | null; doneAt: string | null; rev: number };
export type SectionView = { id: string; name: string; position: number; collapsed: boolean; rev: number };
export type StatusView = { userId: string; emoji: string | null; text: string; statusUntil: string | null; quietUntil: string | null; previews: boolean; rev: number };
export type ScheduledView = { id: string; channelId: string; threadId: string | null; body: string; fileIds: string[]; sendAt: string; failure: string | null; rev: number };

/** Someone in the workspace, as messages show them. */
export type PersonView = { id: string; name: string; email: string; image: string | null; role: string; agent: boolean };

export type Presence = "active" | "away" | "offline";

/** What changed, for this person: added or replaced by id, or gone. */
export type Changes = {
  rev: number;
  channels?: ChannelView[];
  /** Channels the person can no longer see (deleted, or a private one they left). */
  goneChannels?: string[];
  memberships?: MembershipView[];
  /** Channels the person is no longer in (they may still see a public one). */
  leftChannels?: string[];
  messages?: MessageView[];
  threads?: ThreadView[];
  drafts?: DraftView[];
  goneDrafts?: { channelId: string; threadId: string }[];
  saved?: SavedView[];
  goneSaved?: string[];
  sections?: SectionView[];
  goneSections?: string[];
  statuses?: StatusView[];
  scheduled?: ScheduledView[];
  goneScheduled?: string[];
  /** A channel's people changed: whoever shows its list of people reads it again. */
  roster?: string[];
  /** How far people read in small channels and direct conversations (read marks). */
  reads?: { channelId: string; userId: string; seq: number }[];
};

export type Bootstrap = Changes & {
  me: string;
  people: PersonView[];
  presence: Record<string, Presence>;
};

export type ServerFrame =
  | { t: "hello"; connectionId: string; userId: string }
  | { t: "result"; id: number; ok: true; data: unknown }
  | { t: "result"; id: number; ok: false; error: { code: string; message: string } }
  | { t: "changes"; d: Changes }
  | { t: "typing"; channelId: string; threadId: string | null; userId: string }
  | { t: "presence"; userId: string; state: Presence }
  /** Who has the channel open, for the head's "viewing" faces. */
  | { t: "viewers"; channelId: string; userIds: string[] }
  | { t: "pong" }
  /** The session ended or lost access: the browser stops reconnecting until the page loads again. */
  | { t: "closed"; reason: "signedOut" | "policy" | "removed" };

export type ClientFrame = { t: "call"; id: number; op: string; args?: unknown } | { t: "ping" };

/** The codes a failed call answers with, which the browser words in the person's language. */
export type MessageErrorCode =
  | "notFound"
  | "notAllowed"
  | "notMember"
  | "archived"
  | "invalid"
  | "tooLong"
  | "nameTaken"
  | "adminsOnly"
  | "tooMany"
  | "held"
  | "policy"
  | "rateLimited"
  | "internal";
