/**
 * Related pages: the pages whose meaning is closest to a page's, from the embeddings the semantic
 * index already holds (semantic-index.ts), so nothing is sent to a model. Pages the page already
 * links to or is linked from, and the pages right above and under it, are left out: what is worth
 * showing is what the reader would not find from here. Only pages the reader can open right now
 * are compared at all (access is checked in the query, never taken from the index).
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pageChunk } from "@/db/schema";
import type { PageKind } from "@/db/schema";
import { pageVisibleTo, requirePageAccess, workspacesHeldBack } from "@/server/access";
import { aiTargetFor, embeddingModelOf, embeddingsEnabled, minSimilarityOf } from "@/server/ai";
import { listedPage } from "@/server/page-outdated";
import { maybeSweep } from "@/server/semantic-index";
import { meanEmbeddings } from "@/server/semantic-search";
import { passageOf, vectorLiteral } from "@/server/semantic-text";
import { workspaceSettings } from "@/server/workspaces";

/** Related pages listed under a page. */
export const RELATED_PAGES = 5;

export type RelatedPage = {
  id: string;
  workspaceId: string;
  kind: PageKind;
  title: string;
  icon: string | null;
  /** When it was last edited (ISO): an old page coming back is half the point. */
  updatedAt: string;
  /** The passage closest to the page, and the block it starts at. */
  passage: string;
  blockId: string | null;
  score: number;
};

/**
 * The pages closest in meaning to `pageId` that `userId` can open, best first. Empty without an
 * embeddings model, where the workspace has AI off or the request is held back by a sign-in
 * policy, and while the page isn't indexed yet. Throws AccessError when the user can't open it.
 */
export async function relatedPages(userId: string, pageId: string, limit = RELATED_PAGES): Promise<RelatedPage[]> {
  const found = await requirePageAccess(userId, pageId, "view");
  const workspaceId = found.workspaceId;
  if (!embeddingsEnabled() || found.archivedAt || found.inTemplate) return [];
  if ((await workspaceSettings(workspaceId)).ai === false) return [];
  if ((await workspacesHeldBack(userId, [workspaceId])).size) return [];
  const target = await aiTargetFor(workspaceId);
  const model = embeddingModelOf(target);
  if (!model) return [];
  const vector = (await meanEmbeddings(workspaceId, model, [pageId])).get(pageId);
  if (!vector?.length || !vector.every(Number.isFinite)) {
    // Not indexed yet: the index catches up in the background.
    maybeSweep(workspaceId);
    return [];
  }

  const rows = await db.execute<{
    page_id: string;
    block_id: string | null;
    text: string;
    score: number;
    kind: PageKind;
    title: string;
    icon: string | null;
    updated_at: Date;
  }>(sql`
    with near as materialized (
      select p.id from ${page} p
      where p.workspace_id = ${workspaceId}
        and p.id <> ${pageId}
        and p.id is distinct from ${found.parentId}
        and p.parent_id is distinct from ${pageId}
        and not exists (select 1 from page_link pl where pl.source_id = ${pageId} and pl.target_id = p.id)
        and not exists (select 1 from page_link pl where pl.target_id = ${pageId} and pl.source_id = p.id)
        and exists (select 1 from ${pageChunk} c where c.page_id = p.id and c.model = ${model} and c.dimensions = ${vector.length})
    ),
    visible as materialized (
      select p.id from ${page} p join near n on n.id = p.id
      where ${listedPage(workspaceId, { alias: "p" })} and ${pageVisibleTo(userId, "p")}
    ),
    ranked as (
      select c.page_id, c.block_id, c.text, embedding_cosine(c.embedding, ${vectorLiteral(vector)}::real[]) as score
      from ${pageChunk} c join visible v on v.id = c.page_id
      where c.model = ${model} and c.dimensions = ${vector.length}
    ),
    best as (
      select distinct on (page_id) page_id, block_id, text, score from ranked
      where score >= ${minSimilarityOf(target)}
      order by page_id, score desc
    )
    select b.page_id, b.block_id, b.text, b.score, p.kind, p.title, p.icon, p.updated_at
    from best b join ${page} p on p.id = b.page_id
    order by b.score desc, p.updated_at desc
    limit ${limit}
  `);
  return rows.map((r) => ({
    id: r.page_id,
    workspaceId,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    updatedAt: new Date(r.updated_at).toISOString(),
    passage: passageOf(r.text, r.title),
    blockId: r.block_id,
    score: Math.round(Number(r.score) * 1000) / 1000,
  }));
}
