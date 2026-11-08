/**
 * What every part of Messages shares: the error a call answers with, who may see and write in a
 * channel, and `write`, the one way to change anything here. A write runs in a transaction that
 * first takes the workspace's next `rev` (`message_clock`; the row stays locked until commit, so the
 * workspace's writes commit in rev order), notes what it touched, and after the commit announces
 * it to the open connections (announce.ts).
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMember, messageClock } from "@/db/schema";
import type { MessageErrorCode } from "@/lib/message-wire";
import { findMembership, workspaceRoleOf, type AccessError } from "@/server/access";
import { isAiError } from "@/server/ai/errors";
import type { Tx } from "@/server/workspaces";

export class MessageError extends Error {
  constructor(
    readonly code: MessageErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "MessageError";
  }
}

export type ChannelRow = typeof channel.$inferSelect;
export type MemberRow = typeof channelMember.$inferSelect;
export type WorkspaceRole = NonNullable<Awaited<ReturnType<typeof findMembership>>>["role"];

/** What a write touched, announced once it commits. */
export type Touched = {
  workspaceId: string;
  rev: number;
  channels: Set<string>;
  goneChannels: Map<string, string[]>;
  members: Map<string, Set<string>>;
  left: Map<string, Set<string>>;
  messages: Set<string>;
  threads: Map<string, Set<string>>;
  drafts: Set<string>;
  goneDrafts: Map<string, { channelId: string; threadId: string }[]>;
  saved: Map<string, Set<string>>;
  goneSaved: Map<string, string[]>;
  sections: Map<string, Set<string>>;
  goneSections: Map<string, string[]>;
  statuses: Set<string>;
  scheduled: Map<string, Set<string>>;
  goneScheduled: Map<string, string[]>;
  roster: Set<string>;
  reads: { channelId: string; userId: string; seq: number }[];
  /** New messages to tell people about (notify.ts), once committed. */
  sent: string[];
};

const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
  const set = map.get(key) ?? new Set<V>();
  set.add(value);
  map.set(key, set);
};
const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => map.set(key, [...(map.get(key) ?? []), value]);

/** Records what a write did, for announce.ts. */
export class Changed {
  constructor(readonly t: Touched) {}
  get rev() {
    return this.t.rev;
  }
  channel(id: string) {
    this.t.channels.add(id);
  }
  channelGone(id: string, userIds: string[]) {
    this.t.goneChannels.set(id, userIds);
  }
  member(channelId: string, userId: string) {
    add(this.t.members, userId, channelId);
  }
  left(channelId: string, userId: string) {
    add(this.t.left, userId, channelId);
  }
  message(id: string) {
    this.t.messages.add(id);
  }
  thread(threadId: string, userId: string) {
    add(this.t.threads, userId, threadId);
  }
  draft(userId: string, channelId: string, threadId: string) {
    this.t.drafts.add(`${userId}\n${channelId}\n${threadId}`);
  }
  draftGone(userId: string, channelId: string, threadId: string) {
    push(this.t.goneDrafts, userId, { channelId, threadId });
  }
  saved(userId: string, messageId: string) {
    add(this.t.saved, userId, messageId);
  }
  savedGone(userId: string, messageId: string) {
    push(this.t.goneSaved, userId, messageId);
  }
  section(userId: string, id: string) {
    add(this.t.sections, userId, id);
  }
  sectionGone(userId: string, id: string) {
    push(this.t.goneSections, userId, id);
  }
  status(userId: string) {
    this.t.statuses.add(userId);
  }
  scheduled(userId: string, id: string) {
    add(this.t.scheduled, userId, id);
  }
  scheduledGone(userId: string, id: string) {
    push(this.t.goneScheduled, userId, id);
  }
  roster(channelId: string) {
    this.t.roster.add(channelId);
  }
  read(channelId: string, userId: string, seq: number) {
    this.t.reads.push({ channelId, userId, seq });
  }
  sent(messageId: string) {
    this.t.sent.push(messageId);
  }
}

/** Takes the workspace's next rev inside `tx`, locking its clock row until the transaction ends. */
export async function nextRev(tx: Tx, workspaceId: string): Promise<number> {
  const [row] = await tx
    .insert(messageClock)
    .values({ workspaceId, rev: 1 })
    .onConflictDoUpdate({ target: messageClock.workspaceId, set: { rev: sql`${messageClock.rev} + 1` } })
    .returning({ rev: messageClock.rev });
  return row.rev;
}

/** The workspace's latest committed rev: every change with a rev up to it is visible to a read started now. */
export async function currentRev(workspaceId: string): Promise<number> {
  const [row] = await db.select({ rev: messageClock.rev }).from(messageClock).where(eq(messageClock.workspaceId, workspaceId));
  return row?.rev ?? 0;
}

type Announcer = (touched: Touched) => Promise<void>;
const ANNOUNCER = "__leafdeskMessagesAnnounce";

/** announce.ts registers itself here, so this module needn't import the hub (and its callers the whole of it). */
export function setAnnouncer(announcer: Announcer) {
  (globalThis as Record<string, unknown>)[ANNOUNCER] = announcer;
}

/**
 * Runs `fn` as one write of the workspace's messages: in a transaction holding the next rev, and
 * announced after it commits. What it returns is the write's answer.
 */
export async function write<T>(workspaceId: string, fn: (tx: Tx, changed: Changed) => Promise<T>): Promise<T> {
  const touched: Touched = {
    workspaceId,
    rev: 0,
    channels: new Set(),
    goneChannels: new Map(),
    members: new Map(),
    left: new Map(),
    messages: new Set(),
    threads: new Map(),
    drafts: new Set(),
    goneDrafts: new Map(),
    saved: new Map(),
    goneSaved: new Map(),
    sections: new Map(),
    goneSections: new Map(),
    statuses: new Set(),
    scheduled: new Map(),
    goneScheduled: new Map(),
    roster: new Set(),
    reads: [],
    sent: [],
  };
  const result = await db.transaction(async (tx) => {
    touched.rev = await nextRev(tx, workspaceId);
    return fn(tx, new Changed(touched));
  });
  const announce = (globalThis as Record<string, unknown>)[ANNOUNCER] as Announcer | undefined;
  if (announce) await announce(touched).catch((error) => console.error("[messages] could not announce a change", error));
  return result;
}

/** The person's role in the workspace, refusing those outside it (the socket checks sign-in policies itself). */
export async function workspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole> {
  const membership = await findMembership(userId, workspaceId);
  if (!membership) throw new MessageError("notFound");
  return membership.role;
}

/**
 * SQL: the person may see the channel (on a query of `channel`): they are in its workspace and in
 * the channel, or it is public and they are no guest there.
 */
export function channelVisibleTo(userId: string): SQL {
  const role = workspaceRoleOf(sql`${userId}`, channel.workspaceId);
  return sql`(${role} is not null and (exists (select 1 from ${channelMember} cm where cm.channel_id = ${channel.id} and cm.user_id = ${userId})
    or (${channel.kind} = 'public' and ${role} <> 'guest')))`;
}

/** SQL: whether `userId` (an expression) is still in the channel's workspace, for lists of a channel's people. */
export const stillInWorkspace = (userId: SQL, workspaceId: SQL) => sql`${workspaceRoleOf(userId, workspaceId)} is not null`;

export type ChannelAccess = { channel: ChannelRow; member: MemberRow | null; role: WorkspaceRole };

/**
 * The channel and the person's place in it, refusing those who may not see it (`notFound`, as for
 * one that doesn't exist). `need`: `read` to see it, `write` to post (a member, not archived),
 * `admin` to change it (its admin, or a workspace owner who is in it or may see it).
 */
export async function requireChannel(userId: string, channelId: string, need: "read" | "write" | "admin" = "read", reader: Pick<typeof db, "select"> = db): Promise<ChannelAccess> {
  if (typeof channelId !== "string" || !channelId) throw new MessageError("notFound");
  const [row] = await reader.select().from(channel).where(eq(channel.id, channelId)).limit(1);
  if (!row) throw new MessageError("notFound");
  const membership = await findMembership(userId, row.workspaceId);
  if (!membership) throw new MessageError("notFound");
  const [member] = await reader
    .select()
    .from(channelMember)
    .where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, userId)))
    .limit(1);
  const visible = member || (row.kind === "public" && membership.role !== "guest");
  if (!visible) throw new MessageError("notFound");
  const access = { channel: row, member: member ?? null, role: membership.role };
  if (need === "read") return access;
  if (need === "write") {
    if (row.archivedAt) throw new MessageError("archived");
    if (!member) throw new MessageError("notMember");
    return access;
  }
  if (row.kind === "direct") throw new MessageError("notAllowed");
  if (member?.role === "admin" || membership.role === "owner") return access;
  throw new MessageError("notAllowed");
}

/** Turns what the rest of the server throws into a call's error. */
export function callError(error: unknown): { code: MessageErrorCode; message: string } {
  if (error instanceof MessageError) return { code: error.code, message: error.message };
  if (isAiError(error)) return { code: "ai", message: error.code };
  const name = (error as AccessError | undefined)?.name;
  if (name === "AccessError") return { code: "notFound", message: "Not found" };
  if (name && /Policy|TwoFactor|Sso|IpNotAllowed/.test(name)) return { code: "policy", message: "A sign-in policy holds this session back" };
  if ((error as { name?: string } | undefined)?.name === "FileError") return { code: "invalid", message: (error as Error).message };
  console.error("[messages] a call failed", error);
  return { code: "internal", message: "Something went wrong" };
}
