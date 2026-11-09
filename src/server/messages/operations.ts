/**
 * Team messages for the MCP tools and the REST API: the channels a person may read, a channel's or
 * a thread's messages, a search, and a message sent as them. Each runs as `ctx.userId`, first
 * through `requireMembership`, so sign-in policies and the workspace's connected-apps setting
 * apply as for pages; then through the same functions the app's socket calls (posts.ts,
 * search.ts), which check the channel. Bodies stay the Markdown they are stored as (lib/message-text.ts):
 * people, channels and pages are `leafdesk:` links, readable as they are.
 *
 * The AI chat and agents don't get these tools (ai-more-tools.ts `HIDDEN`): what people wrote in
 * channels is outside words to them, read only where a run is started from a channel.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as z from "zod";
import { db } from "@/db";
import { channel, channelMember, user } from "@/db/schema";
import { env } from "@/lib/env";
import { MESSAGE_LIMITS, messagesPath } from "@/lib/messages";
import type { MessageView } from "@/lib/message-wire";
import { AccessError, requireMembership } from "@/server/access";
import { ToolInputError } from "@/server/mcp/format";
import type { OperationContext } from "@/server/operations";
import { channelVisibleTo, MessageError } from "./core";
import { channelHistory, sendMessage, threadMessages } from "./posts";
import { searchMessages as findMessages } from "./search";
import { channelViews } from "./views";

const id = (what: string) => z.string().min(1).describe(`The ${what} id (a UUID from another tool's output).`);

export const messageInputs = {
  listChannels: z.object({
    workspace_id: id("workspace"),
    include_archived: z.boolean().optional().describe("Also list archived channels."),
  }),
  readMessages: z.object({
    channel_id: id("channel"),
    thread_id: z.string().min(1).optional().describe("A thread's first message (a message's id with reply_count above 0): its replies instead of the channel's list."),
    before: z.number().int().positive().optional().describe("Messages before this seq (next_before of the answer before), for older ones."),
    limit: z.number().int().min(1).max(100).optional().describe("How many messages, at most 100 (default 30)."),
  }),
  searchMessages: z.object({
    workspace_id: id("workspace"),
    query: z.string().max(500).optional().describe('Words, each matched as the start of a word; "quoted phrases" whole.'),
    channel_id: z.string().min(1).optional().describe("Only this channel."),
    from: z.string().min(1).optional().describe("Only messages this person wrote (a user id)."),
    after: z.string().optional().describe("Only messages sent after this date or time (ISO 8601)."),
    before: z.string().optional().describe("Only messages sent before this date or time (ISO 8601)."),
    cursor: z.string().optional().describe("next_cursor of the page before."),
  }),
  sendChannelMessage: z.object({
    channel_id: id("channel"),
    text: z
      .string()
      .min(1)
      .max(MESSAGE_LIMITS.body)
      .describe("Markdown. Mention a person as [@Name](leafdesk:user/<user id>), a page as [Title](leafdesk:page/<page id>); mentioned people are notified."),
    thread_id: z.string().min(1).optional().describe("Reply in this thread (its first message's id)."),
    also_in_channel: z.boolean().optional().describe("With thread_id: show the reply in the channel's list too."),
  }),
};

type Args<K extends keyof typeof messageInputs> = z.infer<(typeof messageInputs)[K]>;

/** Why a message call was refused, in an API's words: what can't be seen reads as not found. */
function apiError(error: unknown): unknown {
  if (!(error instanceof MessageError)) return error;
  switch (error.code) {
    case "notFound":
      return new AccessError();
    case "notMember":
      return new ToolInputError("Only the channel's members can post in it. Join it in the app first.");
    case "archived":
      return new ToolInputError("The channel is archived.");
    case "adminsOnly":
      return new ToolInputError("Only the channel's admins can post in it.");
    case "tooLong":
      return new ToolInputError(`A message has at most ${MESSAGE_LIMITS.body} characters.`);
    case "rateLimited":
      return new ToolInputError("Too many messages in a short time. Wait a minute and try again.");
    case "invalid":
      return new ToolInputError(error.message === "invalid" ? "The message can't be sent as it is." : `${error.message}.`);
    default:
      return new ToolInputError(error.message === error.code ? `The message call was refused (${error.code}).` : `${error.message}.`);
  }
}

async function refused<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw apiError(error);
  }
}

/** The workspace of a channel the person may see: its membership checked as for any workspace. */
async function channelWorkspace(userId: string, channelId: string): Promise<string> {
  const [row] = await db
    .select({ workspaceId: channel.workspaceId })
    .from(channel)
    .where(and(eq(channel.id, channelId), channelVisibleTo(userId)))
    .limit(1);
  if (!row) throw new AccessError();
  await requireMembership(userId, row.workspaceId);
  return row.workspaceId;
}

/** For REST tokens bound to a workspace: a channel's workspace, or null for none. */
export async function workspaceOfChannel(channelId: string): Promise<string | null> {
  const [row] = await db.select({ workspaceId: channel.workspaceId }).from(channel).where(eq(channel.id, channelId)).limit(1);
  return row?.workspaceId ?? null;
}

const link = (workspaceId: string, at: Parameters<typeof messagesPath>[1]) => `${env.appUrl}${messagesPath(workspaceId, at)}`;

async function namesOf(ids: Iterable<string>): Promise<Map<string, string>> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, list));
  return new Map(rows.map((r) => [r.id, r.name?.trim() || r.email]));
}

/** A message as the tools show it. */
function describe(m: MessageView, workspaceId: string, names: Map<string, string>) {
  const webhook = m.data?.webhook;
  const imported = m.data?.importedFrom;
  return {
    id: m.id,
    seq: m.seq,
    author_id: m.authorId,
    author: webhook?.name ?? (m.authorId ? (names.get(m.authorId) ?? null) : (imported?.name ?? null)),
    ...(webhook ? { via: "webhook" } : m.data?.automation ? { via: `automation ${m.data.automation.name}` } : {}),
    kind: m.kind,
    ...(m.kind === "system" ? { event: m.data?.system?.event ?? null } : {}),
    text: m.deletedAt ? "" : m.body,
    ...(m.deletedAt ? { deleted: true } : {}),
    created_at: m.createdAt,
    ...(m.editedAt ? { edited_at: m.editedAt } : {}),
    thread_id: m.threadId,
    ...(m.threadId ? {} : { reply_count: m.replyCount, last_reply_at: m.lastReplyAt }),
    ...(m.files.length ? { files: m.files.map((f) => ({ id: f.id, name: f.name, type: f.contentType, size: f.size, url: f.url.startsWith("/") ? `${env.appUrl}${f.url}` : f.url })) } : {}),
    ...(m.reactions.length ? { reactions: m.reactions.map((r) => ({ emoji: r.emoji, count: r.userIds.length })) } : {}),
    url: link(workspaceId, { channelId: m.channelId, threadId: m.threadId ?? undefined, messageId: m.id }),
  };
}

const authorsOf = (messages: MessageView[]) => messages.flatMap((m) => (m.authorId ? [m.authorId] : []));

/** The channels and direct conversations the person may read, most recently active first. */
export async function listChannels(ctx: OperationContext, { workspace_id, include_archived }: Args<"listChannels">) {
  const { userId } = ctx;
  await requireMembership(userId, workspace_id);
  const views = await channelViews(and(eq(channel.workspaceId, workspace_id), channelVisibleTo(userId), include_archived ? undefined : isNull(channel.archivedAt)));
  const memberships = await db
    .select({ channelId: channelMember.channelId })
    .from(channelMember)
    .innerJoin(channel, eq(channel.id, channelMember.channelId))
    .where(and(eq(channelMember.userId, userId), eq(channel.workspaceId, workspace_id)));
  const mine = new Set(memberships.map((r) => r.channelId));
  const names = await namesOf(views.flatMap((v) => v.people));
  views.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
  return {
    workspace_id,
    channels: views.map((v) => ({
      id: v.id,
      kind: v.kind,
      name: v.kind === "direct" ? v.people.filter((p) => p !== userId).map((p) => names.get(p) ?? "?").join(", ") || (names.get(userId) ?? "") : `#${v.name ?? ""}`,
      topic: v.topic || undefined,
      member: mine.has(v.id),
      members: v.memberCount,
      posting: v.posting,
      archived: Boolean(v.archivedAt),
      last_message_at: v.lastMessageAt,
      url: link(workspace_id, { channelId: v.id }),
    })),
  };
}

/** A channel's latest messages (or those before `before`), oldest first; or a thread's. */
export async function readMessages(ctx: OperationContext, { channel_id, thread_id, before, limit }: Args<"readMessages">) {
  const { userId } = ctx;
  const workspaceId = await channelWorkspace(userId, channel_id);
  if (thread_id) {
    const { root, replies } = await refused(() => threadMessages(userId, thread_id));
    if (root.channelId !== channel_id) throw new AccessError();
    const shown = replies.filter((r) => before === undefined || r.seq < before);
    const page = shown.slice(-(limit ?? 30));
    const names = await namesOf(authorsOf([root, ...page]));
    return {
      channel_id,
      thread: describe(root, workspaceId, names),
      messages: page.map((m) => describe(m, workspaceId, names)),
      has_more: shown.length > page.length,
      next_before: shown.length > page.length ? (page[0]?.seq ?? null) : null,
    };
  }
  const { messages, hasBefore } = await refused(() => channelHistory(userId, { channelId: channel_id, before, limit: limit ?? 30 }));
  const names = await namesOf(authorsOf(messages));
  return {
    channel_id,
    messages: messages.map((m) => describe(m, workspaceId, names)),
    has_more: hasBefore,
    next_before: hasBefore ? (messages[0]?.seq ?? null) : null,
  };
}

/** Messages in the channels the person may read, newest first, a page at a time. */
export async function searchMessages(ctx: OperationContext, { workspace_id, query, channel_id, from, after, before, cursor }: Args<"searchMessages">) {
  const { userId } = ctx;
  await requireMembership(userId, workspace_id);
  if (!query?.trim() && !channel_id && !from && !after && !before) throw new ToolInputError("Give words to look for, or narrow by channel_id, from, after or before.");
  const { messages, more } = await refused(() =>
    findMessages(userId, workspace_id, { query, in: channel_id ? [channel_id] : undefined, from: from ? [from] : undefined, after, before, cursor }),
  );
  const names = await namesOf(authorsOf(messages));
  const places = new Map((await channelViews(messages.length ? inArray(channel.id, [...new Set(messages.map((m) => m.channelId))]) : undefined)).map((c) => [c.id, c]));
  return {
    workspace_id,
    messages: messages.map((m) => ({ ...describe(m, workspace_id, names), channel_id: m.channelId, channel: places.get(m.channelId)?.kind === "direct" ? "direct" : `#${places.get(m.channelId)?.name ?? ""}` })),
    has_more: more,
    next_cursor: more ? (messages.at(-1)?.createdAt ?? null) : null,
  };
}

/** Sends a message as the person, in a channel or a thread they may post in. */
export async function sendChannelMessage(ctx: OperationContext, { channel_id, text, thread_id, also_in_channel }: Args<"sendChannelMessage">) {
  const { userId } = ctx;
  const workspaceId = await channelWorkspace(userId, channel_id);
  const { message, notInChannel } = await refused(() => sendMessage(userId, { channelId: channel_id, threadId: thread_id ?? null, body: text, alsoInChannel: also_in_channel === true }));
  const names = await namesOf([userId]);
  return {
    message: describe(message, workspaceId, names),
    // People mentioned who aren't in the channel: they weren't told.
    ...(notInChannel.length ? { not_in_channel: [...(await namesOf(notInChannel)).values()] } : {}),
  };
}
