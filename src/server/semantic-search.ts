/**
 * Semantic search (#43): pages whose chunks (semantic-index.ts) are closest in meaning to a query,
 * ranked by cosine similarity in SQL (`embedding_cosine`, no pgvector needed). Only pages the
 * reader can access right now are ranked: access is checked when the query runs, never taken from
 * the index. pages.searchPages merges these results with full-text search.
 *
 * The query's embedding is cached briefly and limited per person (search runs as they type); when
 * the model can't be reached or the limit is reached, search quietly falls back to full text.
 *
 * Each workspace searches with its own embeddings model (its own AI account's or the server's): a
 * search across workspaces embeds the query once per AI account and model, each paid for by one of
 * that account's workspaces, and ranks every group's chunks against its own vector.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { dailyNote, page, pageChunk, pageTag } from "@/db/schema";
import type { PageKind } from "@/db/schema";
import { sharedLimiter } from "@/lib/rate-limit";
import type { TimeRange } from "@/lib/search-filters";
import type { SearchKind } from "@/lib/search-query";
import { pageVisibleTo, workspacesHeldBack } from "@/server/access";
import { aiTargetFor, embed, embeddingModelFor, embeddingModelOf, embeddingsEnabled, minSimilarityOf } from "@/server/ai";
import { listedPage, isOutdated } from "@/server/page-outdated";
import { maybeSweep } from "@/server/semantic-index";
import { passageOf, vectorLiteral } from "@/server/semantic-text";
import { activeVerification } from "@/server/verification";
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
  createdAt: Date;
  /** Cosine similarity of the best chunk. */
  score: number;
  /** The best chunk's passage (without the title it was embedded with) and where it starts. */
  passage: string;
  blockId: string | null;
  /** Archived, itself or through a page above it: only when the search includes archived pages. */
  outdated: boolean;
  /** Verified right now (server/verification): it ranks above an otherwise equal page. */
  verified: boolean;
};

type Cache = Map<string, number[]>;
const CACHE_KEY = "__leafdeskQueryVectors";
const cache = ((globalThis as Record<string, unknown>)[CACHE_KEY] ??= new Map()) as Cache;

/** The query's embedding by `workspaceId`'s model, or null when it can't be had now (limit, provider trouble). */
async function queryVector(userId: string, query: string, workspaceId: string, model: string): Promise<number[] | null> {
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

/** What an AI chat keeps to: a page and the pages under it, or the pages of a teamspace. */
export type ChatScopeRef = { kind: "page" | "teamspace"; id: string };

/**
 * The condition that a page of `alias` is in a chat's scope: under the page, or in the teamspace
 * (every page of a teamspace's tree carries its id, see page.teamspaceId).
 */
export function inScope(scope: ChatScopeRef, alias = "p"): SQL {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`Bad table alias: ${alias}`);
  return scope.kind === "page" ? inSubtree(scope.id, alias) : sql`${sql.raw(`"${alias}"."teamspace_id"`)} = ${scope.id}`;
}

/**
 * The indexed chunks of `pageIds` (of their workspace's current model), by page. No access checks:
 * only for pages a search just found for the reader.
 */
export async function chunksOfPages(pageIds: string[]): Promise<Map<string, { blockId: string | null; position: number; text: string }[]>> {
  const out = new Map<string, { blockId: string | null; position: number; text: string }[]>();
  if (!pageIds.length || !embeddingsEnabled()) return out;
  const pages = await db.select({ id: page.id, workspaceId: page.workspaceId }).from(page).where(inArray(page.id, pageIds));
  const byWorkspace = new Map<string, string[]>();
  for (const p of pages) byWorkspace.set(p.workspaceId, [...(byWorkspace.get(p.workspaceId) ?? []), p.id]);
  for (const [workspaceId, ids] of byWorkspace) {
    const model = await embeddingModelFor(workspaceId);
    if (!model) continue;
    const rows = await db
      .select({ pageId: pageChunk.pageId, blockId: pageChunk.blockId, position: pageChunk.position, text: pageChunk.text })
      .from(pageChunk)
      .where(and(inArray(pageChunk.pageId, ids), eq(pageChunk.model, model)));
    for (const { pageId, ...chunk } of rows) out.set(pageId, [...(out.get(pageId) ?? []), chunk]);
  }
  return out;
}

/**
 * The searchable workspaces grouped by what embeds their queries: one AI account (or the server's
 * settings) and model per group, with its similarity threshold.
 */
export async function embeddingGroups(workspaceIds: string[]) {
  const groups = new Map<string, { model: string; minSimilarity: number; workspaceIds: string[] }>();
  for (const id of workspaceIds) {
    const target = await aiTargetFor(id);
    const model = embeddingModelOf(target);
    if (!target || !model) continue;
    const key = `${target.accountId ?? "instance"}\u0000${model}`;
    const group = groups.get(key);
    if (group) group.workspaceIds.push(id);
    else groups.set(key, { model, minSimilarity: minSimilarityOf(target), workspaceIds: [id] });
  }
  return [...groups.values()];
}

/**
 * Where a search looks: under pages (any of them), at pages of some kinds (see lib/search-query),
 * and at archived pages too (`includeOutdated`, see server/page-outdated.ts; left out otherwise).
 */
export type SearchScope = {
  withinPageId?: string;
  withinPageIds?: string[];
  /** Only pages of this teamspace (an AI chat kept to it). */
  withinTeamspaceId?: string;
  kinds?: SearchKind[];
  includeOutdated?: boolean;
  verifiedOnly?: boolean;
  /** Only pages of one of these teamspaces (the search box's teamspace filter). */
  teamspaceIds?: string[];
  /** Only pages one of these people created, or edited last (lib/search-filters). */
  createdBy?: string[];
  editedBy?: string[];
  /** Only pages created, or last edited, in this time. */
  createdIn?: TimeRange;
  editedIn?: TimeRange;
  /** Only pages whose text carries each of these tags or one under it (lib/tags keys, server/page-tags). */
  tags?: string[];
};

/**
 * The `and …` conditions a search scope puts on the pages of `alias`: inside `withinPageId` and
 * inside one of `withinPageIds` (each the page itself or under it), in `withinTeamspaceId`, of one of `kinds` (a row is a
 * page whose parent is a database, a journal page one of `userId`'s daily notes), and verified
 * right now with `verifiedOnly` (server/verification), in one of `teamspaceIds`, created or last
 * edited by one of `createdBy` / `editedBy`, created or last edited in `createdIn` / `editedIn`, and
 * carrying each of `tags` (`home` or one under it, `home/renovation`). Empty for no scope.
 */
export function searchScope(
  {
    withinPageId,
    withinPageIds = [],
    withinTeamspaceId,
    kinds = [],
    verifiedOnly = false,
    teamspaceIds = [],
    createdBy = [],
    editedBy = [],
    createdIn,
    editedIn,
    tags = [],
  }: SearchScope,
  userId: string,
  alias = "p",
): SQL {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`Bad table alias: ${alias}`);
  const column = (name: string) => sql.raw(`"${alias}"."${name}"`);
  const oneOf = (name: string, values: string[]) => sql`${column(name)} in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
  const parts: SQL[] = [];
  if (withinPageId) parts.push(inSubtree(withinPageId, alias));
  if (withinTeamspaceId) parts.push(inScope({ kind: "teamspace", id: withinTeamspaceId }, alias));
  if (withinPageIds.length) parts.push(sql`(${sql.join(withinPageIds.map((id) => inSubtree(id, alias)), sql` or `)})`);
  if (kinds.length) {
    const kind = sql.raw(`"${alias}"."kind"`);
    const inDatabase = sql`exists (select 1 from ${page} pk where pk.id = ${sql.raw(`"${alias}"."parent_id"`)} and pk.kind = 'database')`;
    const byKind: Record<SearchKind, SQL> = {
      page: sql`(${kind} = 'page' and not ${inDatabase})`,
      database: sql`${kind} = 'database'`,
      row: sql`(${kind} = 'page' and ${inDatabase})`,
      journal: sql`exists (select 1 from ${dailyNote} dn where dn.page_id = ${sql.raw(`"${alias}"."id"`)} and dn.user_id = ${userId})`,
    };
    parts.push(sql`(${sql.join(kinds.map((k) => byKind[k]), sql` or `)})`);
  }
  if (verifiedOnly) parts.push(activeVerification(alias));
  if (teamspaceIds.length) parts.push(oneOf("teamspace_id", teamspaceIds));
  if (createdBy.length) parts.push(oneOf("created_by", createdBy));
  if (editedBy.length) parts.push(oneOf("updated_by", editedBy));
  for (const [name, range] of [["created_at", createdIn], ["updated_at", editedIn]] as const) {
    if (range?.from) parts.push(sql`${column(name)} >= ${range.from.toISOString()}::timestamptz`);
    if (range?.to) parts.push(sql`${column(name)} < ${range.to.toISOString()}::timestamptz`);
  }
  for (const tag of tags) {
    const under = `${tag.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
    parts.push(sql`exists (select 1 from ${pageTag} pt where pt.page_id = ${column("id")} and (pt.key = ${tag} or pt.key like ${under}))`);
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
  if (!embeddingsEnabled() || q.length < MIN_SEMANTIC_QUERY) return [];
  const workspaces = await searchableWorkspaces(userId, workspaceId);
  if (!workspaces.length) return [];
  const groups = await embeddingGroups(workspaces);
  // Lazy backfill: pages the index missed get indexed in the background.
  for (const group of groups) for (const id of group.workspaceIds) maybeSweep(id);
  const hits: SemanticHit[] = [];
  for (const group of groups) {
    // Paid for by the workspace searched in, else the group's first.
    const payer = workspaceId && group.workspaceIds.includes(workspaceId) ? workspaceId : group.workspaceIds[0];
    const vector = await queryVector(userId, q, payer, group.model);
    if (vector) hits.push(...(await rankGroup(userId, vector, { ...group, limit }, scope)));
  }
  return hits
    .sort((a, b) => b.score - a.score || Number(b.verified) - Number(a.verified) || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit);
}

/** The best `limit` pages of a group of workspaces that share one model, ranked against its query vector. */
async function rankGroup(
  userId: string,
  vector: number[],
  { model, minSimilarity, workspaceIds: workspaces, limit }: { model: string; minSimilarity: number; workspaceIds: string[]; limit: number },
  scope: SearchScope,
): Promise<SemanticHit[]> {
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
    created_at: Date;
    outdated: boolean;
    verified: boolean;
  }>(sql`
    with candidates as materialized (
      select distinct c.page_id from ${pageChunk} c
      where c.workspace_id in (${sql.join(workspaces.map((w) => sql`${w}`), sql`, `)})
        and c.model = ${model} and c.dimensions = ${vector.length}
    ),
    visible as materialized (
      -- Access first, then ranking: only pages the user can open right now are compared at all.
      select p.id from ${page} p join candidates k on k.page_id = p.id
      where ${listedPage(workspaces, { alias: "p", includeOutdated: scope.includeOutdated })}
        ${searchScope(scope, userId)}
        and ${pageVisibleTo(userId, "p")}
    ),
    ranked as (
      select c.page_id, c.block_id, c.text, embedding_cosine(c.embedding, ${vectorLiteral(vector)}::real[]) as score
      from ${pageChunk} c join visible v on v.id = c.page_id
      where c.model = ${model} and c.dimensions = ${vector.length}
    ),
    best as (
      select distinct on (page_id) page_id, block_id, text, score from ranked
      where score >= ${minSimilarity}
      order by page_id, score desc
    )
    select b.page_id, b.block_id, b.text, b.score, p.workspace_id, p.teamspace_id,
      -- A parent they can't see isn't named, not even by id.
      case when p.parent_id is not null and ${pageVisibleTo(userId, "parent")} then p.parent_id end as parent_id,
      p.kind, p.title, p.icon, p.updated_at, p.created_at,
      ${scope.includeOutdated ? isOutdated(workspaces, "p") : sql`false`} as outdated,
      ${activeVerification("p")} as verified
    from best b
    join ${page} p on p.id = b.page_id
    left join ${page} parent on parent.id = p.parent_id
    -- A verified page above an otherwise equal one (server/verification).
    order by b.score desc, verified desc, p.updated_at desc
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
    createdAt: new Date(r.created_at),
    score: Number(r.score),
    passage: passageOf(r.text, r.title),
    blockId: r.block_id,
    outdated: Boolean(r.outdated),
    verified: Boolean(r.verified),
  }));
}
