/**
 * The workspace check for someone (see lib/workspace-check): what is worth tidying among the pages
 * they can open. Access is checked by every query here, when the check runs: a page they can't
 * open is never a finding, never named, and never counted against another page (a link from it
 * doesn't keep a page from being an orphan, a link to it isn't broken).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { page, type RowProperties } from "@/db/schema";
import { markdownPageIds } from "@/lib/mentions";
import { atLeast } from "@/lib/property-access";
import {
  DEFAULT_DUPLICATE_SIMILARITY,
  DEFAULT_STALE_MONTHS,
  isEmptyPage,
  isOrphan,
  isStale,
  MAX_CHECKED_PAGES,
  MAX_DUPLICATE_PAGES,
  MAX_LINK_SUGGESTIONS,
  section,
  similarPairs,
  staleCutoff,
  type BrokenLink,
  type BrokenRelation,
  type BrokenWebLink,
  type CheckedPage,
  type CheckPage,
  type CheckPageKind,
  type DeadTarget,
  type DuplicateSection,
  type Orphan,
  type ExpiredVerification,
  type StalePage,
  type WebLinkSection,
  type WorkspaceCheck,
} from "@/lib/workspace-check";
import { env } from "@/lib/env";
import { isReported, markdownWebLinks, MAX_WEB_LINKS, normalizeWebLink, type WebLinkReason } from "@/lib/web-links";
import { AccessError, accessRank, getMembership, isGuest, levelFromRank, pageVisibleTo, requirePageAccess } from "@/server/access";
import { embeddingModelFor, embeddingsEnabled } from "@/server/ai";
import { updateRowProperties } from "@/server/databases";
import { loadProperties } from "@/server/derived";
import { listUnlinkedMentions, resolvePageRefs } from "@/server/mentions";
import { propertyAccessFor } from "@/server/property-access";
import { meanEmbeddings } from "@/server/semantic-search";
import { expiredVerifications } from "@/server/verification";
import { wantWebLinks, webLinkChecksEnabled, webLinkStates } from "@/server/web-links";
import { workspaceSettings } from "@/server/workspaces";

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Loaded = CheckedPage & { icon: string | null; parentId: string | null; hasRefs: boolean; hasWeb: boolean };

export type CheckOptions = {
  /** Pages nobody edited for this many months are stale (DEFAULT_STALE_MONTHS). */
  staleMonths?: number;
  /** How alike two pages must be to count as duplicates (DEFAULT_DUPLICATE_SIMILARITY). */
  minSimilarity?: number;
  now?: Date;
};

/**
 * Checks the workspace's pages that `userId` can open. Owners and members only: guests see just
 * the pages shared with them, where pages nothing leads to or nobody edits say little.
 */
export async function checkWorkspace(
  userId: string,
  workspaceId: string,
  { staleMonths = DEFAULT_STALE_MONTHS, minSimilarity = DEFAULT_DUPLICATE_SIMILARITY, now = new Date() }: CheckOptions = {},
): Promise<WorkspaceCheck> {
  const membership = await getMembership(userId, workspaceId);
  if (!membership || isGuest(membership.role)) throw new AccessError();

  const pages = await loadPages(userId, workspaceId);
  const truncated = pages.length > MAX_CHECKED_PAGES;
  const checked = pages.slice(0, MAX_CHECKED_PAGES);
  const byId = new Map(checked.map((p) => [p.id, p]));

  const editable = await editableOf(
    userId,
    checked.map((p) => p.id),
  );
  const asCheckPage = (p: Loaded): CheckPage => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, canEdit: editable.has(p.id) });

  const cutoff = staleCutoff(now, staleMonths);
  const orphans = checked.filter(isOrphan);
  const [brokenLinks, linkFrom, duplicates, brokenRelations, ended, brokenWebLinks] = await Promise.all([
    findBrokenLinks(
      userId,
      checked.filter((p) => p.hasRefs),
      asCheckPage,
    ),
    suggestLinks(userId, orphans.slice(0, MAX_LINK_SUGGESTIONS)),
    findDuplicates(workspaceId, checked, asCheckPage, minSimilarity),
    findBrokenRelations(userId, checked, byId, editable, asCheckPage),
    expiredVerifications(userId, workspaceId, MAX_CHECKED_PAGES),
    findBrokenWebLinks(userId, workspaceId, checked, asCheckPage, now),
  ]);

  return {
    workspaceId,
    checkedAt: now.toISOString(),
    pages: checked.length,
    truncated,
    staleMonths,
    brokenLinks: section(brokenLinks),
    orphans: section(orphans.map((p): Orphan => ({ ...asCheckPage(p), ...(linkFrom.has(p.id) ? { linkFrom: linkFrom.get(p.id) } : {}) }))),
    empty: section(checked.filter(isEmptyPage).map(asCheckPage)),
    stale: section(
      checked
        .filter((p) => isStale(p, cutoff))
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .map((p): StalePage => ({ ...asCheckPage(p), updatedAt: p.updatedAt.toISOString() })),
    ),
    // Of the pages looked at: the ones whose verification ended longest ago first.
    expiredVerifications: section(
      ended.flatMap((v): ExpiredVerification[] => {
        const p = byId.get(v.id);
        return p ? [{ ...asCheckPage(p), by: v.by, until: v.until }] : [];
      }),
    ),
    duplicates,
    brokenRelations: section(brokenRelations),
    brokenWebLinks,
  };
}

/** The workspace's pages the user can open, outside the trash and templates, last edited first. */
async function loadPages(userId: string, workspaceId: string): Promise<Loaded[]> {
  const parent = alias(page, "parent");
  const rows = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      kind: page.kind,
      parentId: page.parentId,
      parentKind: parent.kind,
      isSkill: page.isSkill,
      updatedAt: page.updatedAt,
      emptyBody: sql<boolean>`btrim(${page.contentMarkdown}) = ''`,
      hasRefs: sql<boolean>`strpos(${page.contentMarkdown}, '/p/') > 0`,
      hasWeb: sql<boolean>`strpos(${page.contentMarkdown}, 'http') > 0`,
      // Pages inside count whoever can open them: such a page isn't empty, and nothing leads nowhere.
      hasChildren: sql<boolean>`exists (select 1 from ${page} c where c.parent_id = ${page.id} and c.archived_at is null and not c.is_template)`,
    })
    .from(page)
    .leftJoin(parent, eq(parent.id, page.parentId))
    .where(and(eq(page.workspaceId, workspaceId), isNull(page.archivedAt), eq(page.inTemplate, false), pageVisibleTo(userId)))
    .orderBy(desc(page.updatedAt), desc(page.id))
    .limit(MAX_CHECKED_PAGES + 1);

  // Pages the user can open that link to each page: a link from one they can't doesn't count.
  const linked = new Set(
    (
      await db.execute<{ target_id: string }>(sql`
        select distinct pl.target_id from page_link pl
        join ${page} s on s.id = pl.source_id
        where s.workspace_id = ${workspaceId} and s.archived_at is null and not s.in_template
          and pl.source_id <> pl.target_id and ${pageVisibleTo(userId, "s")}
      `)
    ).map((r) => r.target_id),
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    kind: (r.kind === "database" ? "database" : r.parentKind === "database" ? "row" : "page") satisfies CheckPageKind,
    parentId: r.parentId,
    topLevel: !r.parentId,
    hasChildren: Boolean(r.hasChildren),
    linkedTo: linked.has(r.id),
    emptyBody: Boolean(r.emptyBody),
    hasRefs: Boolean(r.hasRefs),
    hasWeb: Boolean(r.hasWeb),
    isSkill: r.isSkill,
    updatedAt: new Date(r.updatedAt),
  }));
}

/** Of `ids`, the pages the user may edit. */
async function editableOf(userId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks(ids, 1000)) {
    const rows = await db
      .select({ id: page.id, level: accessRank(userId, sql`${page.id}`) })
      .from(page)
      .where(inArray(page.id, part));
    for (const r of rows) {
      const level = levelFromRank(r.level);
      if (level === "edit" || level === "full") out.add(r.id);
    }
  }
  return out;
}

/**
 * Of `ids`, the pages that lead nowhere for the user: in the trash (when they could open it) or
 * deleted for good. A page they can't open isn't among them, whatever became of it.
 */
async function deadTargets(userId: string, ids: string[]): Promise<Map<string, DeadTarget>> {
  const dead: string[] = [];
  for (const part of chunks([...new Set(ids)], 200)) {
    for (const ref of await resolvePageRefs(userId, part)) if (ref.status === "deleted") dead.push(ref.id);
  }
  const out = new Map<string, DeadTarget>(dead.map((id) => [id, { id, status: "deleted" }]));
  for (const part of chunks(dead, 1000)) {
    const trashed = await db
      .select({ id: page.id, title: page.title, icon: page.icon, level: accessRank(userId, sql`${page.id}`) })
      .from(page)
      .where(inArray(page.id, part));
    for (const r of trashed) {
      const level = levelFromRank(r.level);
      out.set(r.id, { id: r.id, status: "trash", title: r.title, icon: r.icon, canRestore: level === "edit" || level === "full" });
    }
  }
  return out;
}

/** Links and mentions in the bodies of `sources` to pages in the trash or deleted. */
async function findBrokenLinks(userId: string, sources: Loaded[], asCheckPage: (p: Loaded) => CheckPage): Promise<BrokenLink[]> {
  if (!sources.length) return [];
  const linksOf = new Map<string, string[]>();
  for (const part of chunks(sources, 500)) {
    const rows = await db
      .select({ id: page.id, markdown: page.contentMarkdown })
      .from(page)
      .where(
        inArray(
          page.id,
          part.map((p) => p.id),
        ),
      );
    for (const r of rows) {
      const ids = markdownPageIds(r.markdown).filter((id) => id !== r.id);
      if (ids.length) linksOf.set(r.id, ids);
    }
  }
  const dead = await deadTargets(userId, [...linksOf.values()].flat());
  const out: BrokenLink[] = [];
  for (const source of sources) {
    for (const id of linksOf.get(source.id) ?? []) {
      const target = dead.get(id);
      if (target) out.push({ source: asCheckPage(source), target });
    }
  }
  return out;
}

/** For each orphan, a page the user may edit that writes its title without linking it, if there is one. */
async function suggestLinks(userId: string, orphans: Loaded[]) {
  const out = new Map<string, { id: string; title: string; icon: string | null }>();
  for (const orphan of orphans) {
    try {
      const found = (await listUnlinkedMentions(userId, orphan.id)).find((m) => m.canEdit);
      if (found) out.set(orphan.id, { id: found.id, title: found.title, icon: found.icon });
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
    }
  }
  return out;
}

/**
 * Pairs of pages whose meaning is nearly the same: the mean of each page's chunk embeddings
 * (semantic-index.ts), compared pairwise. Skipped without an embeddings model, and where the
 * workspace has AI off (its pages aren't indexed then).
 */
async function findDuplicates(
  workspaceId: string,
  checked: Loaded[],
  asCheckPage: (p: Loaded) => CheckPage,
  minSimilarity: number,
): Promise<DuplicateSection> {
  const model = embeddingsEnabled() ? await embeddingModelFor(workspaceId) : null;
  if (!model) return { status: "skipped", reason: "noEmbeddings" };
  if ((await workspaceSettings(workspaceId)).ai === false) return { status: "skipped", reason: "aiOff" };
  // Pages only: rows say little each, and databases have no body.
  const candidates = checked.filter((p) => p.kind === "page").slice(0, MAX_DUPLICATE_PAGES);
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const means = await meanEmbeddings(
    workspaceId,
    model,
    candidates.map((p) => p.id),
  );
  const vectors = [...means].filter(([id]) => byId.has(id)).map(([id, vector]) => ({ id, vector }));
  const pairs = similarPairs(vectors, minSimilarity).map(({ a, b, similarity }) => ({
    a: asCheckPage(byId.get(a)!),
    b: asCheckPage(byId.get(b)!),
    similarity: Math.round(similarity * 1000) / 1000,
  }));
  return { status: "done", minSimilarity, compared: vectors.length, ...section(pairs) };
}

/**
 * Relation values of rows the user can open, in properties they may see there, that hold rows in
 * the trash or deleted.
 */
async function findBrokenRelations(
  userId: string,
  checked: Loaded[],
  byId: Map<string, Loaded>,
  editable: Set<string>,
  asCheckPage: (p: Loaded) => CheckPage,
): Promise<BrokenRelation[]> {
  const databaseIds = checked.filter((p) => p.kind === "database").map((p) => p.id);
  if (!databaseIds.length) return [];
  const relationsOf = new Map(
    [...(await loadProperties(databaseIds))]
      .map(([databaseId, props]) => [databaseId, props.filter((p) => p.type === "relation")] as const)
      .filter(([, props]) => props.length),
  );
  const rowIds = checked.filter((p) => p.kind === "row" && p.parentId && relationsOf.has(p.parentId)).map((p) => p.id);
  if (!rowIds.length) return [];
  const values: { id: string; parentId: string; properties: RowProperties; createdBy: string | null }[] = [];
  for (const part of chunks(rowIds, 1000)) {
    const rows = await db
      .select({ id: page.id, parentId: page.parentId, properties: page.properties, createdBy: page.createdBy })
      .from(page)
      .where(inArray(page.id, part));
    for (const r of rows) if (r.parentId) values.push({ ...r, parentId: r.parentId });
  }
  const byDatabase = [...Map.groupBy(values, (v) => v.parentId)];
  const accessOf = await Promise.all(byDatabase.map(([databaseId]) => propertyAccessFor(userId, databaseId)));

  type Found = { rowId: string; databaseId: string; property: { id: string; name: string }; targetId: string; canFix: boolean };
  const found: Found[] = [];
  for (const [i, [databaseId, rows]] of byDatabase.entries()) {
    const access = accessOf[i];
    for (const row of rows) {
      for (const prop of relationsOf.get(databaseId) ?? []) {
        const level = access.levelOf(prop.id, row);
        if (!atLeast(level, "view")) continue;
        const canFix = editable.has(row.id) && atLeast(level, "edit_values");
        for (const targetId of asIds(row.properties[prop.id])) {
          found.push({ rowId: row.id, databaseId, property: { id: prop.id, name: prop.name }, targetId, canFix });
        }
      }
    }
  }
  const dead = await deadTargets(
    userId,
    found.map((f) => f.targetId),
  );
  return found.flatMap((f): BrokenRelation[] => {
    const target = dead.get(f.targetId);
    const database = byId.get(f.databaseId)!;
    if (!target) return [];
    return [
      {
        row: asCheckPage(byId.get(f.rowId)!),
        database: { id: database.id, title: database.title, icon: database.icon },
        property: f.property,
        target,
        canFix: f.canFix,
      },
    ];
  });
}

/**
 * Web addresses in the bodies of `checked` (pages edited last first) and in the URL properties of
 * their rows the user may see there, that stopped working (server/web-links). Asks about them all,
 * so the ones not known yet are fetched in the background; the app's own addresses aren't web links.
 */
async function findBrokenWebLinks(
  userId: string,
  workspaceId: string,
  checked: Loaded[],
  asCheckPage: (p: Loaded) => CheckPage,
  now: Date,
): Promise<WebLinkSection> {
  if (!webLinkChecksEnabled()) return { status: "skipped" };
  const own = (() => {
    try {
      return new URL(env.appUrl).origin;
    } catch {
      return null;
    }
  })();
  type Found = { source: Loaded; url: string; property?: { id: string; name: string } };
  const found: Found[] = [];
  const urls = new Set<string>();
  const add = (f: Found) => {
    if (own && new URL(f.url).origin === own) return;
    if (!urls.has(f.url)) {
      if (urls.size >= MAX_WEB_LINKS) return;
      urls.add(f.url);
    }
    found.push(f);
  };

  const byId = new Map(checked.map((p) => [p.id, p]));
  const withWeb = checked.filter((p) => p.hasWeb);
  for (const part of chunks(withWeb, 500)) {
    const rows = await db
      .select({ id: page.id, markdown: page.contentMarkdown })
      .from(page)
      .where(
        inArray(
          page.id,
          part.map((p) => p.id),
        ),
      );
    const markdownOf = new Map(rows.map((r) => [r.id, r.markdown]));
    for (const p of part) for (const url of markdownWebLinks(markdownOf.get(p.id) ?? "")) add({ source: p, url });
  }

  // Rows' URL values, in the properties the user may see on each row.
  const databaseIds = checked.filter((p) => p.kind === "database").map((p) => p.id);
  const urlProps = new Map(
    [...(databaseIds.length ? await loadProperties(databaseIds) : new Map())]
      .map(([databaseId, props]) => [databaseId, props.filter((p: { type: string }) => p.type === "url")] as const)
      .filter(([, props]) => props.length),
  );
  const rowIds = checked.filter((p) => p.kind === "row" && p.parentId && urlProps.has(p.parentId)).map((p) => p.id);
  const values: { id: string; parentId: string; properties: RowProperties; createdBy: string | null }[] = [];
  for (const part of chunks(rowIds, 1000)) {
    const rows = await db
      .select({ id: page.id, parentId: page.parentId, properties: page.properties, createdBy: page.createdBy })
      .from(page)
      .where(inArray(page.id, part));
    for (const r of rows) if (r.parentId) values.push({ ...r, parentId: r.parentId });
  }
  for (const [databaseId, rows] of Map.groupBy(values, (v) => v.parentId)) {
    const access = await propertyAccessFor(userId, databaseId);
    for (const row of rows) {
      for (const prop of urlProps.get(databaseId) ?? []) {
        if (!atLeast(access.levelOf(prop.id, row), "view")) continue;
        const value = row.properties[prop.id];
        const url = typeof value === "string" ? normalizeWebLink(value.trim()) : null;
        if (url) add({ source: byId.get(row.id)!, url, property: { id: prop.id, name: prop.name } });
      }
    }
  }

  const list = [...urls];
  await wantWebLinks(workspaceId, list, now);
  const states = await webLinkStates(workspaceId, list);
  const broken = found.flatMap((f): BrokenWebLink[] => {
    const state = states.get(f.url);
    if (!state || !isReported(state)) return [];
    return [
      {
        source: asCheckPage(f.source),
        url: f.url,
        reason: (state.reason ?? "unreachable") as WebLinkReason,
        httpStatus: state.httpStatus,
        checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
        ...(f.property ? { property: f.property } : {}),
      },
    ];
  });
  const pending = list.filter((url) => (states.get(url)?.status ?? "pending") === "pending").length;
  return { status: "done", links: list.length, pending, ...section(broken) };
}

/**
 * Takes `targetId` out of the row's relation `propertyId` (a row in the trash or deleted, as the
 * check found). The user must be able to edit the row and that property; rows they can't see that
 * the relation holds stay. False when the relation doesn't hold it (any more).
 */
export async function removeRelationTarget(userId: string, rowId: string, propertyId: string, targetId: string): Promise<boolean> {
  const row = await requirePageAccess(userId, rowId, "edit");
  const current = asIds(row.properties[propertyId]);
  if (!current.includes(targetId)) return false;
  await updateRowProperties(userId, rowId, { [propertyId]: current.filter((id) => id !== targetId) });
  return true;
}
