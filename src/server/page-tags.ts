/**
 * The `#tags` written in pages' text (lib/tags), indexed in `page_tag` for search: written from the
 * body on every save (collab/service.ts persistPage, syncPageTags), so they follow edits, copies,
 * restores and deletes. The text stays the source of truth; the rows only list it. Pages written
 * before tags were indexed, and those of a restored workspace, wait in `page_tag_queue` for a
 * backfill that reads each once.
 *
 * Search narrows to a tag with semantic-search.ts searchScope (`tags`); the search box and the
 * editor suggest the tags of pages the viewer can open (tagSuggestions).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pageTag, pageTagQueue } from "@/db/schema";
import { tagsInBlocks } from "@/lib/tag-blocks";
import { MAX_TAG_LENGTH, tagKey } from "@/lib/tags";
import { enforceWorkspacePolicy, pageVisibleTo } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { listedPage } from "@/server/page-outdated";
import { startSweep } from "@/server/sweep";

/** Brings the page's tags in line with its body. Never throws: a save goes on. */
export async function syncPageTags(pageId: string, blocks: unknown[]) {
  try {
    const wanted = tagsInBlocks(blocks);
    const existing = await db.select({ key: pageTag.key, label: pageTag.label, count: pageTag.count }).from(pageTag).where(eq(pageTag.pageId, pageId));
    if (!existing.length && !wanted.size) return;
    const gone = existing.filter((row) => !wanted.has(row.key)).map((row) => row.key);
    if (gone.length) await db.delete(pageTag).where(and(eq(pageTag.pageId, pageId), inArray(pageTag.key, gone)));
    const had = new Map(existing.map((row) => [row.key, row]));
    const changed = [...wanted].filter(([key, tag]) => {
      const before = had.get(key);
      return !before || before.label !== tag.label || before.count !== tag.count;
    });
    if (!changed.length) return;
    await db
      .insert(pageTag)
      .values(changed.map(([key, tag]) => ({ pageId, key, label: tag.label, count: tag.count })))
      .onConflictDoUpdate({ target: [pageTag.pageId, pageTag.key], set: { label: sql`excluded.label`, count: sql`excluded.count` } });
  } catch (error) {
    console.error(`could not update the tags of page ${pageId}`, error);
  }
}

/** Carries the tags of copied pages over to their copies (see duplicate.ts), whose bodies are the same. */
export async function copyPageTags(tx: Pick<typeof db, "execute">, pairs: { id: string; source_id: string }[]) {
  if (!pairs.length) return;
  await tx.execute(sql`
    insert into ${pageTag} (page_id, key, label, count)
    select m.id, t.key, t.label, t.count
    from jsonb_to_recordset(${JSON.stringify(pairs.map((p) => ({ id: p.id, source_id: p.source_id })))}::jsonb) as m(id text, source_id text)
    join ${pageTag} t on t.page_id = m.source_id
    on conflict do nothing
  `);
}

/** Pages read in each run of the backfill. */
const BACKFILL_BATCH = 50;
/** How often the backfill looks for pages waiting (a restore can queue some at any time). */
const BACKFILL_SWEEP_MS = 30_000;

/**
 * Reads the tags of a batch of queued pages. Each leaves the queue whether or not it could be read,
 * so it is tried once. Returns how many pages it took.
 */
export async function backfillPageTags(batch = BACKFILL_BATCH): Promise<number> {
  const queued = await db.select({ id: pageTagQueue.pageId }).from(pageTagQueue).limit(batch);
  for (const { id } of queued) {
    try {
      const { blocks } = await getCollab().readBlocks(id, { synced: true });
      await syncPageTags(id, blocks);
    } catch (error) {
      console.error(`could not index the tags of page ${id}`, error);
    }
    await db.delete(pageTagQueue).where(eq(pageTagQueue.pageId, id));
  }
  return queued.length;
}

/** Server only: indexes the tags of queued pages, now and whenever some are queued. */
export function startPageTagsBackfill() {
  return startSweep(BACKFILL_SWEEP_MS, () => backfillPageTags(), "could not backfill page tags");
}

/**
 * Queues the pages of a workspace whose body may hold a tag (a `#` followed by neither a space nor
 * another `#`, as a heading's marker is), for the backfill: after a restore, whose backup leaves the
 * index out.
 */
export async function queueWorkspaceTags(workspaceId: string) {
  await db.execute(sql`
    insert into ${pageTagQueue} (page_id)
    select id from ${page} where workspace_id = ${workspaceId} and content_markdown ~ '#[^\\s#]'
    on conflict do nothing
  `);
}

/** A tag the search box or the editor offers: its spelling, and on how many pages it is. */
export type TagSuggestion = { label: string; key: string; pages: number };

/** Most tags offered at once. */
const SUGGESTIONS = 20;

/**
 * The tags of the workspace's pages the user can open (out of the trash, templates and archived
 * pages) whose key starts with `prefix` (compared as tags are: `Ev/` finds `ev/tadilat`), on the
 * most pages first. A tag's spelling is the one of the oldest page carrying it.
 */
export async function tagSuggestions(userId: string, workspaceId: string, prefix: string): Promise<TagSuggestion[]> {
  const wanted = tagKey(prefix.trim().replace(/^#/, ""));
  if (!wanted || wanted.length > MAX_TAG_LENGTH) return [];
  await enforceWorkspacePolicy(userId, workspaceId);
  const like = `${wanted.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // Without JIT: the access check per page makes Postgres compile the query (see server/assigned.ts).
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set local jit = off`);
    return tx.execute<{ key: string; label: string; pages: number }>(sql`
      select t.key, (array_agg(t.label order by p.created_at, p.id))[1] as label, count(*)::int as pages
      from ${pageTag} t
      join ${page} p on p.id = t.page_id
      where t.key like ${like}
        and p.workspace_id = ${workspaceId}
        and ${listedPage(workspaceId, { alias: "p" })}
        and ${pageVisibleTo(userId, "p")}
      group by t.key
      order by pages desc, t.key
      limit ${SUGGESTIONS}
    `);
  });
  return rows.map((row) => ({ key: row.key, label: row.label, pages: Number(row.pages) }));
}
