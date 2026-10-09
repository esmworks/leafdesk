/**
 * Semantic search (#43): pages whose chunks (semantic-index.ts) are closest in meaning to a query,
 * ranked by cosine similarity in SQL (`embedding_cosine`, no pgvector needed). Only pages the
 * reader can access right now are ranked: access is checked when the query runs, never taken from
 * the index. pages.searchPages merges these results with full-text search.
 *
 * The query's embedding is cached briefly and limited per person (search runs as they type); when
 * the model can't be reached or the limit is reached, search quietly falls back to full text.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { page, pageChunk } from "@/db/schema";
import type { PageKind } from "@/db/schema";
import { sharedLimiter } from "@/lib/rate-limit";
import type { SearchKind } from "@/lib/search-query";
import { pageVisibleTo, workspacesHeldBack } from "@/server/access";
import { embed, embeddingModel, embeddingsEnabled, minSimilarity } from "@/server/ai";
import { maybeSweep } from "@/server/semantic-index";
import { passageOf, vectorLiteral } from "@/server/semantic-text";
import { listWorkspaces, workspaceSettings } from "@/server/workspaces";

/** Queries shorter than this aren't searched by meaning (they match too much). */
export const MIN_SEMANTIC_QUERY = 3;
/** Query embeddings per person per minute. */
const QUERIES_PER_MINUTE = 60;
const QUERY_TIMEOUT_MS = 5_000;
const CACHE_SIZE = 500;

export type SemanticHit = {
  id: string;
  workspaceId: string;
  teamspaceId: string | null;
  parentId: string | null;
  kind: PageKind;
  title: string;
  icon: string | null;
  updatedAt: Date;
  /** Cosine similarity of the best chunk. */
  score: number;
  /** The best chunk's passage (without the title it was embedded with) and where it starts. */
  passage: string;
  blockId: string | null;
};

type Cache = Map<string, number[]>;
const CACHE_KEY = "__leafdeskQueryVectors";
const cache = ((globalThis as Record<string, unknown>)[CACHE_KEY] ??= new Map()) as Cache;

/** The query's embedding, or null when it can't be had now (limit, provider trouble). */
async function queryVector(userId: string, query: string, workspaceId: string | null): Promise<number[] | null> {
  const model = embeddingModel();
  if (!model) return null;
  const key = `${model}\u0000${query}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const limiter = sharedLimiter("ai:search", QUERIES_PER_MINUTE, 60_000);
  if (limiter.retryAfter(userId) > 0) return null;
  limiter.hit(userId);
  try {
    const [vector] = await embed([query], {
      feature: "search.query",
      userId,
      workspaceId,
      skipRateLimit: true,
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!vector?.length) return null;
    cache.set(key, vector);
    for (const old of cache.keys()) {
      if (cache.size <= CACHE_SIZE) break;
      cache.delete(old);
    }
    return vector;
  } catch {
    // Logged by the AI layer; full-text results still come.
    return null;
  }
}

/** Forgets cached query embeddings (tests). */
export function clearQueryCache() {
  cache.clear();
}

/**
 * The workspaces (of `workspaceId`, or all of the user's) where semantic search runs: the user is
 * in them, AI is on there, and the request's session isn't held back by a two-step policy.
 */
async function searchableWorkspaces(userId: string, workspaceId?: string): Promise<string[]> {
  const theirs = (await listWorkspaces(userId)).map((w) => w.id).filter((id) => !workspaceId || id === workspaceId);
  const on = await Promise.all(theirs.map(async (id) => (await workspaceSettings(id)).ai !== false));
  const ids = theirs.filter((_, i) => on[i]);
  const held = await workspacesHeldBack(userId, ids);
  return ids.filter((id) => !held.has(id));
}

/** SQL: `p.id` lies in the tree under (and including) `rootId`. */
export function inSubtree(rootId: string, alias = "p"): SQL {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`Bad table alias: ${alias}`);
  return sql`${sql.raw(`"${alias}"."id"`)} in (
    with recursive sub as (
      select id from ${page} where id = ${rootId}
      union all
      select c.id from ${page} c join sub on c.parent_id = sub.id
    ) select id from sub
  )`;
}

/** Where a search looks: under pages (any of them), and at pages of some kinds (see lib/search-query). */
export type SearchScope = { withinPageId?: string; withinPageIds?: string[]; kinds?: SearchKind[] };

/**
 * The `and …` conditions a search scope puts on the pages of `alias`: inside `withinPageId` and
 * inside one of `withinPageIds` (each the page itself or under it), of one of `kinds` (a row is a
 * page whose parent is a database). Empty for no scope.
 */
export function searchScope({ withinPageId, withinPageIds = [], kinds = [] }: SearchScope, alias = "p"): SQL {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`Bad table alias: ${alias}`);
  const parts: SQL[] = [];
  if (withinPageId) parts.push(inSubtree(withinPageId, alias));
  if (withinPageIds.length) parts.push(sql`(${sql.join(withinPageIds.map((id) => inSubtree(id, alias)), sql` or `)})`);
  if (kinds.length) {
    const kind = sql.raw(`"${alias}"."kind"`);
    const inDatabase = sql`exists (select 1 from ${page} pk where pk.id = ${sql.raw(`"${alias}"."parent_id"`)} and pk.kind = 'database')`;
    const byKind: Record<SearchKind, SQL> = {
      page: sql`(${kind} = 'page' and not ${inDatabase})`,
      database: sql`${kind} = 'database'`,
      row: sql`(${kind} = 'page' and ${inDatabase})`,
    };
    parts.push(sql`(${sql.join(kinds.map((k) => byKind[k]), sql` or `)})`);
  }
  return parts.length ? sql`and ${sql.join(parts, sql` and `)}` : sql``;
}

/**
 * Pages closest in meaning to `query` that the user may see, best first (their best chunk each).
 * Empty without an embeddings model, for very short queries, and when the query can't be embedded.
 */
export async function semanticSearch(
  userId: string,
  query: string,
  { workspaceId, limit = 20, ...scope }: { workspaceId?: string; limit?: number } & SearchScope = {},
): Promise<SemanticHit[]> {
  const q = query.trim();
  const model = embeddingModel();
  if (!embeddingsEnabled() || !model || q.length < MIN_SEMANTIC_QUERY) return [];
  const workspaces = await searchableWorkspaces(userId, workspaceId);
  if (!workspaces.length) return [];
  // Lazy backfill: pages the index missed get indexed in the background.
  for (const id of workspaces) maybeSweep(id);
  const vector = await queryVector(userId, q, workspaceId ?? null);
  if (!vector) return [];

  const rows = await db.execute<{
    page_id: string;
    block_id: string | null;
    text: string;
    score: number;
    workspace_id: string;
    teamspace_id: string | null;
    parent_id: string | null;
    kind: PageKind;
    title: string;
    icon: string | null;
    updated_at: Date;
  }>(sql`
    with candidates as materialized (
      select distinct c.page_id from ${pageChunk} c
      where c.workspace_id in (${sql.join(workspaces.map((w) => sql`${w}`), sql`, `)})
        and c.model = ${model} and c.dimensions = ${vector.length}
    ),
    visible as materialized (
      -- Access first, then ranking: only pages the user can open right now are compared at all.
      select p.id from ${page} p join candidates k on k.page_id = p.id
      where p.archived_at is null and not p.in_template
        ${searchScope(scope)}
        and ${pageVisibleTo(userId, "p")}
    ),
    ranked as (
      select c.page_id, c.block_id, c.text, embedding_cosine(c.embedding, ${vectorLiteral(vector)}::real[]) as score
      from ${pageChunk} c join visible v on v.id = c.page_id
      where c.model = ${model} and c.dimensions = ${vector.length}
    ),
    best as (
      select distinct on (page_id) page_id, block_id, text, score from ranked
      where score >= ${minSimilarity()}
      order by page_id, score desc
    )
    select b.page_id, b.block_id, b.text, b.score, p.workspace_id, p.teamspace_id,
      -- A parent they can't see isn't named, not even by id.
      case when p.parent_id is not null and ${pageVisibleTo(userId, "parent")} then p.parent_id end as parent_id,
      p.kind, p.title, p.icon, p.updated_at
    from best b
    join ${page} p on p.id = b.page_id
    left join ${page} parent on parent.id = p.parent_id
    order by b.score desc, p.updated_at desc
    limit ${limit}
  `);
  return rows.map((r) => ({
    id: r.page_id,
    workspaceId: r.workspace_id,
    teamspaceId: r.teamspace_id,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    updatedAt: new Date(r.updated_at),
    score: Number(r.score),
    passage: passageOf(r.text, r.title),
    blockId: r.block_id,
  }));
}
