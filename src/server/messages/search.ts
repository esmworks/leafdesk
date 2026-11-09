/**
 * Searching messages: words (each as a prefix, folded as the vectors are, Chinese and Japanese by
 * their pieces, quoted phrases whole) in the channels the person may read, narrowed by who wrote,
 * where, what it has and when, newest first, a page at a time.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMessage, messageFile, messageReaction } from "@/db/schema";
import { parseSearchQuery } from "@/lib/search-query";
import { searchQueryParts } from "@/lib/search-words";
import type { MessageView } from "@/lib/message-wire";
import { searchFoldSql } from "@/server/search-fold-sql";
import { channelVisibleTo, MessageError, workspaceRole } from "./core";
import { withExtras } from "./views";

export type MessageSearch = {
  query?: unknown;
  from?: unknown;
  in?: unknown;
  has?: unknown;
  after?: unknown;
  before?: unknown;
  /** The `createdAt` of the last hit of the page before, for the next page. */
  cursor?: unknown;
};

const PAGE = 30;
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 50) : []);
const date = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The tsquery of the words and phrases typed, or null when there are none. */
function wordsQuery(text: string): SQL | null {
  const { text: rest, phrases } = parseSearchQuery(text);
  const { words, cjk } = searchQueryParts(rest);
  const parts: SQL[] = [
    ...(/[\p{L}\p{N}]/u.test(words) ? [sql`nullif(regexp_replace(plainto_tsquery('simple', ${searchFoldSql(words)})::text, '''( &|$)', ''':*\\1', 'g'), '')::tsquery`] : []),
    ...cjk.map((run) => sql`to_tsquery('simple', ${run})`),
    ...phrases.flatMap((phrase) => {
      const p = searchQueryParts(phrase);
      return [...(/[\p{L}\p{N}]/u.test(p.words) ? [sql`phraseto_tsquery('simple', ${searchFoldSql(p.words)})`] : []), ...p.cjk.map((run) => sql`to_tsquery('simple', ${run})`)];
    }),
  ];
  return parts.length ? sql`(${sql.join(parts, sql` && `)})` : null;
}

export async function searchMessages(userId: string, workspaceId: string, input: MessageSearch): Promise<{ messages: MessageView[]; more: boolean }> {
  await workspaceRole(userId, workspaceId);
  const text = typeof input.query === "string" ? input.query.trim().slice(0, 500) : "";
  const words = text ? wordsQuery(text) : null;
  if (text && !words) return { messages: [], more: false };
  const from = ids(input.from);
  const where = ids(input.in);
  const has = ids(input.has);
  const after = date(input.after);
  const before = date(input.before);
  const cursor = date(input.cursor);
  if (!words && !from.length && !where.length && !has.length && !after && !before) throw new MessageError("invalid");
  const readable = db
    .select({ id: channel.id })
    .from(channel)
    .where(and(eq(channel.workspaceId, workspaceId), channelVisibleTo(userId)));
  const rows = await db
    .select()
    .from(channelMessage)
    .where(
      and(
        eq(channelMessage.workspaceId, workspaceId),
        inArray(channelMessage.channelId, readable),
        eq(channelMessage.kind, "message"),
        isNull(channelMessage.deletedAt),
        words ? sql`${channelMessage.searchVector} @@ ${words}` : undefined,
        from.length ? inArray(channelMessage.authorId, from) : undefined,
        where.length ? inArray(channelMessage.channelId, where) : undefined,
        has.includes("file") ? sql`exists (select 1 from ${messageFile} f where f.message_id = ${channelMessage.id})` : undefined,
        has.includes("image") ? sql`exists (select 1 from ${messageFile} f join file x on x.id = f.file_id where f.message_id = ${channelMessage.id} and x.content_type like 'image/%')` : undefined,
        has.includes("link") ? sql`${channelMessage.body} ~ 'https?://'` : undefined,
        has.includes("pin") ? isNotNull(channelMessage.pinnedAt) : undefined,
        has.includes("reaction") ? sql`exists (select 1 from ${messageReaction} r where r.message_id = ${channelMessage.id})` : undefined,
        has.includes("thread") ? sql`${channelMessage.replyCount} > 0` : undefined,
        after ? gte(channelMessage.createdAt, after) : undefined,
        before ? lt(channelMessage.createdAt, before) : undefined,
        cursor ? lt(channelMessage.createdAt, cursor) : undefined,
      ),
    )
    .orderBy(desc(channelMessage.createdAt))
    .limit(PAGE + 1);
  return { messages: await withExtras(rows.slice(0, PAGE), userId), more: rows.length > PAGE };
}
