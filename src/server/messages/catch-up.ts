/**
 * Catch up: the AI sums up what a person hasn't read in a channel (the messages after `since`, the
 * seq they had read to when they opened it) or a long thread, on the fast model while they wait.
 * Reads only what the person may read (requireChannel, threadMessages) and changes nothing: the
 * messages stay unread. Prompt and answer: catch-up-prompt.ts.
 */
import { and, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { channelMember, channelMessage, user } from "@/db/schema";
import { isAiLanguage } from "@/lib/ai";
import { CATCH_UP_MAX_MESSAGES, type CatchUp } from "@/lib/message-catch-up";
import { broadcastOf, mentionedUserIds } from "@/lib/message-text";
import type { MessageView } from "@/lib/message-wire";
import { AiError, aiConfig, complete, contentChars } from "@/server/ai";
import { aiAvailable } from "@/server/ai-writing";
import { catchUpPrompt, readCatchUp, type CatchUpMessage } from "./catch-up-prompt";
import { MessageError, requireChannel } from "./core";
import { threadMessages } from "./posts";
import { messageViews } from "./views";

/** Room for the messages in a prompt: what the model takes, but no more than a quick answer reads. */
const roomFor = () => Math.max(4_000, Math.min(contentChars(aiConfig().limits) - 2_500, 60_000));

const said = (m: MessageView) => m.kind === "message" && !m.deletedAt;

export async function catchUp(userId: string, input: { channelId?: unknown; threadId?: unknown; since?: unknown; language?: unknown }): Promise<CatchUp> {
  const language = isAiLanguage(input.language) ? input.language : undefined;
  let messages: MessageView[];
  let left = 0;
  let channelId: string;
  const thread = typeof input.threadId === "string" && input.threadId !== "";
  if (thread) {
    const { root, replies } = await threadMessages(userId, input.threadId);
    channelId = root.channelId;
    const kept = replies.filter(said);
    left = Math.max(0, kept.length - (CATCH_UP_MAX_MESSAGES - 1));
    messages = [root, ...kept.slice(left)];
  } else {
    channelId = typeof input.channelId === "string" ? input.channelId : "";
    const { channel: row, member } = await requireChannel(userId, channelId);
    // What the person hadn't read when they opened the channel; reading since doesn't move it.
    const since = Number.isInteger(input.since) ? Math.min(Math.max(input.since as number, 0), row.lastSeq) : (member?.lastReadSeq ?? row.lastSeq);
    const unread = and(eq(channelMessage.channelId, row.id), gt(channelMessage.seq, since), eq(channelMessage.kind, "message"), isNull(channelMessage.deletedAt));
    const [newest, [{ total }]] = await Promise.all([
      messageViews(unread, { order: "desc", limit: CATCH_UP_MAX_MESSAGES }),
      db.select({ total: count() }).from(channelMessage).where(unread),
    ]);
    messages = newest.reverse();
    left = Math.max(0, total - messages.length);
  }
  const { channel: row } = await requireChannel(userId, channelId);
  if (!(await aiAvailable(row.workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  if (!messages.filter(said).length) return { summary: "", decisions: [], questions: [], open: [], read: 0, left: 0 };

  const ids = [...new Set([userId, ...messages.flatMap((m) => (m.authorId ? [m.authorId] : []))])];
  const names = new Map((await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))).map((p) => [p.id, p.name]));
  const others = row.kind === "direct" ? await directNames(row.id, userId) : [];
  const place = row.kind === "direct" ? `a direct conversation${others.length ? ` with ${others.join(", ")}` : ""}` : `the channel #${row.name ?? ""}`;
  const shown: CatchUpMessage[] = messages.filter(said).map((m) => ({
    id: m.id,
    threadId: m.threadId,
    author: (m.authorId && names.get(m.authorId)) || "Someone",
    mine: m.authorId === userId,
    mentionsYou: mentionedUserIds(m.body).includes(userId) || broadcastOf(m.body) !== null,
    at: new Date(m.createdAt),
    body: m.body,
    files: m.files.map((f) => f.name),
  }));

  const prompt = catchUpPrompt({ place, thread, reader: { id: userId, name: names.get(userId) ?? "you" }, messages: shown, left, language }, roomFor());
  const answer = await complete({
    feature: "messages.catchUp",
    userId,
    workspaceId: row.workspaceId,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.prompt }],
    maxOutputTokens: 2_000,
  });
  if (!answer.text.trim()) throw new MessageError("internal", "The AI gave no answer");
  return readCatchUp(answer.text, prompt.refs, { read: prompt.refs.size, left: prompt.left });
}

/** The names of the others in a direct conversation. */
async function directNames(channelId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: user.name })
    .from(channelMember)
    .innerJoin(user, eq(user.id, channelMember.userId))
    .where(and(eq(channelMember.channelId, channelId), ne(channelMember.userId, userId)))
    .limit(8);
  return rows.map((r) => r.name);
}
