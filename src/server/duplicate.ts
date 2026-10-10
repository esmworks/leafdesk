import { and, asc, eq, gt, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import * as Y from "yjs";
import { db } from "@/db";
import {
  databaseProperty,
  databaseView,
  page,
  pageGroupPermission,
  pagePermission,
  propertyPermission,
  type PageKind,
  type RowProperties,
} from "@/db/schema";
import {
  copyAccess,
  dropPropertyReferences,
  planDuplicate,
  planPropertyRules,
  redactCopy,
  type CopyAccess,
  type DuplicatePlan,
  type PlannedPage,
  type SourcePage,
  type SourceRule,
} from "@/lib/duplicate";
import { DATABASE_BLOCK, mapReferenceLines, referenceLine, remapInlineDatabases } from "@/lib/embed-blocks";
import { positionBetween } from "@/lib/properties";
import { stripReminders } from "@/lib/mentions";
import { stripComments } from "@/lib/strip-comments";
import { AccessError, pageVisibleTo, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { queueAutomations } from "@/server/automations/queue";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { bulkRowIds, dropCopiedSubItems, rowsWithAccess, syncPairedRelations, withCode, type BulkResult } from "@/server/databases";
import { copyReferences } from "@/server/mentions";
import { keepFullAccess, makePagePrivate } from "@/server/permissions";
import type { PropertyAccess } from "@/lib/property-access-rows";
import { propertyAccessFor } from "@/server/property-access";
import { placeTopLevel, TeamspaceError } from "@/server/teamspaces";
import { requireTopLevel } from "@/server/workspaces";

/** Larger subtrees are refused rather than copied in one long transaction. */
export const MAX_DUPLICATE_PAGES = 2000;

/** Where `copyPageTree` puts the copy, and what it carries over from the source. */
export type CopyTarget = {
  parentId: string | null;
  /** Whether the destination lies in a template (see `page.inTemplate`); false at the top level. */
  parentInTemplate: boolean;
  title: string;
  /** Right after the source when missing, as "Duplicate" places it. */
  position?: number;
  /** Whether the copy's root is a template; the source's own flag when missing. */
  rootTemplate?: boolean;
  /**
   * Copy the root's own permission entries (Duplicate), or let the root inherit its new parent's
   * access (a page made from a template). Entries of the pages under it are always copied.
   */
  rootPermissions: boolean;
  /**
   * The teamspace of a copy at the top level (null: a private page); under a parent the copy
   * belongs to the parent's.
   */
  teamspaceId: string | null;
  /** A private top-level copy is theirs alone, like any private page they add. */
  private: boolean;
  /** Leave the source's comment threads (and their marks in the text) behind. */
  stripComments: boolean;
};

export type CopiedTree = {
  plan: DuplicatePlan;
  /** The copy of the source page. */
  root: { id: string; properties: RowProperties; isTemplate: boolean; inTemplate: boolean };
};

/**
 * Copies `source` and everything live under it that the user can see (subpages, databases with
 * their properties, views, rows and row templates, pages inside rows) to `target`. The caller has
 * checked access to the source and the destination. Pages under the copy keep their permission
 * entries, so they are never visible to more people than their source. Favorites, publication,
 * history and locks stay with the original.
 */
export async function copyPageTree(
  actor: WriteActor,
  source: { id: string; workspaceId: string; parentId: string | null; position: number; isTemplate: boolean },
  target: CopyTarget,
): Promise<CopiedTree> {
  const { userId } = actor;
  const pageId = source.id;
  // Read before the transaction: it goes through the pool, which a transaction waiting on it
  // would hold a connection of.
  const accessOf = await accessForCopy(userId, source);

  const copied = await db.transaction(async (tx) => {
    // Walk down live pages the user can see; a hidden page hides its whole subtree.
    const pages = await tx.execute<{
      id: string;
      parent_id: string | null;
      kind: PageKind;
      title: string;
      position: number;
      properties: RowProperties;
      is_template: boolean;
      default_template_id: string | null;
      created_by: string | null;
    }>(sql`
      with recursive sub as (
        select id from ${page} where id = ${pageId}
        union all
        select p.id from ${page} p join sub on p.parent_id = sub.id
        where p.archived_at is null and ${pageVisibleTo(userId, "p")}
      )
      select p.id, p.parent_id, p.kind, p.title, p.position, p.properties, p.is_template, p.default_template_id, p.created_by
      from (select id from sub limit ${MAX_DUPLICATE_PAGES + 1}) s
      join ${page} p on p.id = s.id
    `);
    if (pages.length > MAX_DUPLICATE_PAGES) {
      throw new Error(`Can't duplicate more than ${MAX_DUPLICATE_PAGES} pages at once`);
    }

    const databaseIds = pages.filter((p) => p.kind === "database").map((p) => p.id);
    const [stored, storedViews] = databaseIds.length
      ? await Promise.all([
          tx.select().from(databaseProperty).where(inArray(databaseProperty.databaseId, databaseIds)),
          tx.select().from(databaseView).where(and(inArray(databaseView.databaseId, databaseIds), isNull(databaseView.deletedAt))),
        ])
      : [[], []];
    // Deleted properties and views aren't copied, nor are the values and view settings of those
    // properties: the copy has nothing to restore them into.
    const gone = new Set(stored.filter((p) => p.deletedAt).map((p) => p.id));
    const properties = stored.filter((p) => !p.deletedAt);
    const views = gone.size ? storedViews.map((v) => ({ ...v, config: dropPropertyReferences(v.config, (id) => gone.has(id)) })) : storedViews;

    let rootPosition = target.position;
    if (rootPosition === undefined) {
      // Right after the original: halfway to the next sibling, or one past it when it is last.
      const [next] = await tx
        .select({ position: page.position })
        .from(page)
        .where(
          and(
            eq(page.workspaceId, source.workspaceId),
            source.parentId ? eq(page.parentId, source.parentId) : isNull(page.parentId),
            gt(page.position, source.position),
          ),
        )
        .orderBy(asc(page.position))
        .limit(1);
      rootPosition = positionBetween(source.position, next?.position);
    }

    // Property access: the copy carries only what the user may (see lib/duplicate copyAccess).
    const { carried, rules } = await copiedAccess(tx, userId, accessOf, source, target, databaseIds, properties);
    const plan = planDuplicate(
      redactCopy(
        {
          rootId: pageId,
          pages: pages.map(
            (p): SourcePage => ({
              id: p.id,
              parentId: p.parent_id,
              kind: p.kind,
              title: p.title,
              position: Number(p.position),
              properties: gone.size ? Object.fromEntries(Object.entries(p.properties).filter(([id]) => !gone.has(id))) : p.properties,
            }),
          ),
          properties,
          views,
          rootTitle: target.title,
          rootPosition,
        },
        carried,
        new Map(pages.map((p) => [p.id, p.created_by])),
      ),
    );

    // Template flags: the root's is chosen by the caller, the rest keep theirs (row templates of a
    // copied database stay row templates); a page lies in a template when it is one or its parent does.
    const sources = new Map(pages.map((p) => [p.id, p]));
    const planned = new Map(plan.pages.map((p) => [p.id, p]));
    const isTemplate = (copy: PlannedPage) =>
      copy.id === plan.rootId ? (target.rootTemplate ?? source.isTemplate) : Boolean(sources.get(copy.sourceId)?.is_template);
    const inTemplate = new Map<string, boolean>();
    const inTemplateOf = (copy: PlannedPage): boolean => {
      const known = inTemplate.get(copy.id);
      if (known !== undefined) return known;
      const parent = copy.id === plan.rootId ? undefined : planned.get(copy.parentId!);
      const value = isTemplate(copy) || (parent ? inTemplateOf(parent) : target.parentInTemplate);
      inTemplate.set(copy.id, value);
      return value;
    };

    // Every page of the copy belongs to the teamspace it lands in (see page.teamspaceId).
    const [landing] = target.parentId
      ? await tx.select({ teamspaceId: page.teamspaceId }).from(page).where(eq(page.id, target.parentId))
      : [{ teamspaceId: target.teamspaceId }];
    const space = landing?.teamspaceId ?? null;

    // One statement for all pages, so the bodies (ydoc can be large) are copied inside Postgres
    // and foreign keys to parents are checked once every page exists.
    const rows = plan.pages.map((p) => {
      const defaultTemplate = sources.get(p.sourceId)?.default_template_id;
      return {
        id: p.id,
        source_id: p.sourceId,
        parent_id: p.id === plan.rootId ? target.parentId : p.parentId,
        title: p.title,
        position: p.position,
        properties: p.properties,
        is_template: isTemplate(p),
        in_template: inTemplateOf(p),
        // A database's default row template, when it was copied along (the user could see it).
        default_template_id: (defaultTemplate && plan.pageIds.get(defaultTemplate)) || null,
      };
    });
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into ${page} (id, workspace_id, parent_id, kind, title, icon, background, position, properties,
        ydoc, content_text, content_markdown, is_template, in_template, default_template_id, teamspace_id, created_by, updated_by)
      select m.id, src.workspace_id, m.parent_id, src.kind, m.title, src.icon, src.background, m.position, m.properties,
        src.ydoc, src.content_text, src.content_markdown, m.is_template, m.in_template, m.default_template_id,
        ${space}::text, ${userId}, ${userId}
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        as m(id text, source_id text, parent_id text, title text, position double precision, properties jsonb,
          is_template boolean, in_template boolean, default_template_id text)
      join ${page} src on src.id = m.source_id
      returning id
    `);
    // A page deleted since the walk would leave a hole in the copy; start over instead.
    if (inserted.length !== rows.length) throw new Error("The page changed while duplicating it; try again");

    // Entries inherited from above need nothing: the copy sits under the same parent.
    await tx.execute(sql`
      insert into ${pagePermission} (id, page_id, workspace_id, user_id, level, created_by)
      select gen_random_uuid()::text, m.id, pp.workspace_id, pp.user_id, pp.level, ${userId}
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as m(id text, source_id text)
      join ${pagePermission} pp on pp.page_id = m.source_id
      ${target.rootPermissions ? sql`` : sql`where m.id <> ${plan.rootId}`}
    `);
    await tx.execute(sql`
      insert into ${pageGroupPermission} (id, page_id, workspace_id, group_id, level, created_by)
      select gen_random_uuid()::text, m.id, gp.workspace_id, gp.group_id, gp.level, ${userId}
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as m(id text, source_id text)
      join ${pageGroupPermission} gp on gp.page_id = m.source_id
      ${target.rootPermissions ? sql`` : sql`where m.id <> ${plan.rootId}`}
    `);
    if (target.private) await makePagePrivate(tx, source.workspaceId, plan.rootId, userId);
    else if (!target.parentId && target.teamspaceId) await keepFullAccess(tx, source.workspaceId, plan.rootId, userId);
    await pointAtCopiedDatabases(tx, plan);
    if (target.stripComments) await stripCopiedComments(tx, plan);
    await copyReferences(tx, rows);
    await stripCopiedReminders(tx, plan);

    if (plan.properties.length) {
      await tx.insert(databaseProperty).values(
        plan.properties.map(({ id, databaseId, name, type, options, position }) => ({
          id,
          databaseId,
          name,
          type,
          options,
          position,
        })),
      );
    }
    if (plan.views.length) {
      await tx.insert(databaseView).values(
        plan.views.map(({ id, databaseId, name, type, config, position }) => ({ id, databaseId, name, type, config, position })),
      );
    }
    // After the properties: a person property exception points at one.
    const copiedRules = planPropertyRules(rules, plan);
    if (copiedRules.length) {
      await tx.insert(propertyPermission).values(
        copiedRules.map(({ propertyId, databaseId, userId: ruleUser, groupId, personPropertyId, level }) => ({
          propertyId,
          databaseId,
          workspaceId: source.workspaceId,
          userId: ruleUser,
          groupId,
          personPropertyId,
          level,
          createdBy: userId,
        })),
      );
    }
    const root = rows.find((r) => r.id === plan.rootId)!;
    return {
      plan,
      root: { id: root.id, properties: root.properties, isTemplate: root.is_template, inTemplate: root.in_template },
    };
  });

  // The copied doc still carries the original title; the store hook persists the new one.
  await getCollab().setTitle(copied.plan.rootId, target.title, actor);
  return copied;
}

/**
 * What a copy carries of the databases it touches, as the user's property access allows (see
 * lib/duplicate copyAccess), and the rules of the copied databases to carry over.
 *
 * - Databases copied along keep the properties the user may know of, and in each row the values
 *   they may view. Their rules come along too (planPropertyRules): the copy often has the same
 *   audience as the source (a duplicate beside it keeps its permission entries), and without them
 *   others would see there what the source keeps from them. Someone with full access to the source
 *   copies everything, rules included.
 * - A row copied on its own (Duplicate on a row, saving it as a row template, a row made from a
 *   row template) lands in its own database, whose rules still hold: it keeps only the values the
 *   user could set in a row they add. A template's values they may not change are left out, and
 *   the template is still used; values they give themselves are checked as usual (and refused).
 */
async function copiedAccess(
  tx: Tx,
  userId: string,
  accessOf: CopyAccessOf,
  source: { id: string; parentId: string | null },
  target: CopyTarget,
  databaseIds: string[],
  properties: { id: string; databaseId: string }[],
): Promise<{ carried: Map<string, CopyAccess>; rules: SourceRule[] }> {
  const carried = new Map<string, CopyAccess>();
  const propsOf = (databaseId: string) => properties.filter((p) => p.databaseId === databaseId);
  for (const id of databaseIds) {
    const access = accessOf.databases.get(id);
    // A database added under the page since its access was read: never copy it unchecked.
    if (!access) throw new Error("The page changed while duplicating it; try again");
    const kept = copyAccess(access, propsOf(id));
    if (kept) carried.set(id, kept);
  }
  if (accessOf.parent) {
    const parentProps = await tx
      .select({ id: databaseProperty.id })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.databaseId, source.parentId!), isNull(databaseProperty.deletedAt)));
    // Elsewhere (not a case today) the values are keyed by properties of no database there.
    const write = target.parentId === source.parentId ? { createdBy: userId } : undefined;
    const kept = copyAccess(accessOf.parent, parentProps, { write });
    if (kept) carried.set(source.parentId!, kept);
  }
  const databaseOf = new Map(properties.map((p) => [p.id, p.databaseId]));
  const rules = databaseIds.length
    ? (
        await tx
          .select({
            propertyId: propertyPermission.propertyId,
            userId: propertyPermission.userId,
            groupId: propertyPermission.groupId,
            personPropertyId: propertyPermission.personPropertyId,
            level: propertyPermission.level,
          })
          .from(propertyPermission)
          .where(inArray(propertyPermission.databaseId, databaseIds))
      ).flatMap((rule): SourceRule[] => {
        const databaseId = databaseOf.get(rule.propertyId);
        return databaseId ? [{ ...rule, databaseId }] : [];
      })
    : [];
  return { carried, rules };
}

/** The user's property access to the databases a copy may take along, and to the source's database. */
type CopyAccessOf = { databases: Map<string, PropertyAccess>; parent: PropertyAccess | null };

async function accessForCopy(userId: string, source: { id: string; parentId: string | null }): Promise<CopyAccessOf> {
  const [databaseIds, [parent]] = await Promise.all([
    db.execute<{ id: string }>(sql`
      with recursive sub as (
        select id, kind from ${page} where id = ${source.id}
        union all
        select p.id, p.kind from ${page} p join sub on p.parent_id = sub.id
        where p.archived_at is null and ${pageVisibleTo(userId, "p")}
      )
      select id from (select id, kind from sub limit ${MAX_DUPLICATE_PAGES + 1}) s where kind = 'database'
    `),
    source.parentId ? db.select({ kind: page.kind }).from(page).where(eq(page.id, source.parentId)) : [],
  ]);
  const [accesses, parentAccess] = await Promise.all([
    Promise.all([...databaseIds].map(async ({ id }) => [id, await propertyAccessFor(userId, id)] as const)),
    parent?.kind === "database" ? propertyAccessFor(userId, source.parentId!) : null,
  ]);
  return { databases: new Map(accesses), parent: parentAccess };
}

/**
 * Copies a page and everything live under it next to the original (see copyPageTree). Only what
 * the user can see is copied. Each page's own permission entries are copied too, so a copy is
 * never visible to more people than its source; a guest's top-level copy is theirs alone.
 */
export async function duplicatePage(
  actor: WriteActor,
  pageId: string,
  copySuffix: string,
  /** False when the caller tells open views about several copies at once. */
  { notify = true }: { notify?: boolean } = {},
): Promise<{ id: string; workspaceId: string }> {
  const { userId } = actor;
  const source = await requirePageAccess(userId, pageId, "view");
  if (source.archivedAt) throw new Error("Restore the page from the trash before duplicating it");
  // The copy lands beside the original, so the user needs to be allowed to add pages there.
  let parentKind: PageKind | null = null;
  let parentInTemplate = false;
  let placement: { teamspaceId: string | null; private: boolean } = { teamspaceId: null, private: false };
  if (source.parentId) {
    const parent = await requirePageAccess(userId, source.parentId, "edit");
    if (parent.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
    parentKind = parent.kind;
    parentInTemplate = parent.inTemplate;
  } else {
    // Beside the original in its teamspace when they may add pages there, else among their private pages.
    const topLevel = await requireTopLevel(userId, source.workspaceId);
    placement = await placeTopLevel(userId, source.workspaceId, topLevel, source.teamspaceId).catch((error) => {
      if (error instanceof AccessError || error instanceof TeamspaceError) return { teamspaceId: null, private: true };
      throw error;
    });
  }
  const title = `${source.title}${copySuffix}`.trim();

  const { root } = await copyPageTree(actor, source, {
    parentId: source.parentId,
    parentInTemplate,
    title,
    rootPermissions: true,
    teamspaceId: placement.teamspaceId,
    private: placement.private,
    stripComments: false,
  });

  // A row copied into its database links to the same rows; two-way relations mirror that.
  // Templates link one way only: their links would show up on the linked rows.
  if (parentKind === "database" && !root.inTemplate) {
    const properties = await dropCopiedSubItems(root.id, source.parentId!, root.properties);
    await syncPairedRelations(root.id, source.parentId!, {}, properties);
    // A copied row is a new row: "row added" automations run for it.
    await queueAutomations(userId, source.parentId!, [{ rowId: root.id, before: {}, after: properties }], true);
  }
  // Like a new page (see createPage): copied rows and templates are content, left out of the log.
  if (parentKind !== "database" && !root.inTemplate) {
    await recordAudit({
      workspaceId: source.workspaceId,
      actorId: userId,
      action: "page.duplicated",
      target: { type: "page", id: root.id, label: title },
      details: { kind: source.kind, source: source.title },
    });
  }

  if (notify) {
    const collab = getCollab();
    collab.broadcast(`ws:${source.workspaceId}`, "tree");
    if (parentKind === "database") collab.broadcast(`db:${source.parentId}`, "rows");
  }
  return { id: root.id, workspaceId: source.workspaceId };
}

/** Copied page documents without the comments of their source (see stripComments). */
async function stripCopiedComments(tx: Tx, plan: DuplicatePlan) {
  const bodies = await tx
    .select({ id: page.id, ydoc: page.ydoc })
    .from(page)
    .where(and(inArray(page.id, [...plan.pageIds.values()]), isNotNull(page.ydoc)));
  for (const body of bodies) {
    if (!body.ydoc?.byteLength) continue;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, body.ydoc);
      if (stripComments(doc)) await tx.update(page).set({ ydoc: Y.encodeStateAsUpdate(doc) }).where(eq(page.id, body.id));
    } finally {
      doc.destroy();
    }
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Copied page documents without the reminders of their dates: a reminder belongs to the person who
 * set it on the source page (see lib/mentions). Only bodies that mention a date can hold one.
 */
async function stripCopiedReminders(tx: Tx, plan: DuplicatePlan) {
  const copies = plan.pages.filter((p) => p.kind === "page").map((p) => p.id);
  if (!copies.length) return;
  const bodies = await tx
    .select({ id: page.id, ydoc: page.ydoc })
    .from(page)
    .where(and(inArray(page.id, copies), isNotNull(page.ydoc), sql`${page.contentMarkdown} ~ '@[0-9]{4}-[0-9]{2}-[0-9]{2}'`));
  for (const body of bodies) {
    if (!body.ydoc?.byteLength) continue;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, body.ydoc);
      if (stripReminders(doc)) await tx.update(page).set({ ydoc: Y.encodeStateAsUpdate(doc) }).where(eq(page.id, body.id));
    } finally {
      doc.destroy();
    }
  }
}

/**
 * Copied pages showing an inline database that was copied with them show the copy instead (in
 * their document and in their derived Markdown); linked views keep showing their source.
 */
async function pointAtCopiedDatabases(tx: Tx, plan: DuplicatePlan) {
  const copies = plan.pages.filter((p) => p.kind === "page").map((p) => p.id);
  if (!copies.length) return;
  const bodies = await tx
    .select({ id: page.id, ydoc: page.ydoc, markdown: page.contentMarkdown })
    .from(page)
    .where(and(inArray(page.id, copies), like(page.contentMarkdown, "%<!-- leafdesk:database %")));
  for (const body of bodies) {
    if (!body.ydoc?.byteLength) continue;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, body.ydoc);
      if (!remapInlineDatabases(doc, plan.pageIds)) continue;
      const markdown = mapReferenceLines(body.markdown, (ref) =>
        referenceLine(ref.type, ref.type === DATABASE_BLOCK ? (plan.pageIds.get(ref.databaseId) ?? ref.databaseId) : ref.databaseId),
      );
      await tx.update(page).set({ ydoc: Y.encodeStateAsUpdate(doc), contentMarkdown: markdown }).where(eq(page.id, body.id));
    } finally {
      doc.destroy();
    }
  }
}

/**
 * Duplicates several rows of a database, each copy right after its original (see duplicatePage).
 * Needs edit access to the database, like adding a row. Rows the user can't see, rows in the
 * trash and ids of other pages are skipped and returned. Each row is copied in its own
 * transaction, so an error part way keeps the copies made so far; open views hear about all of
 * them once.
 */
export async function duplicateRows(
  actor: WriteActor,
  databaseId: string,
  rowIds: string[],
  copySuffix: string,
): Promise<BulkResult> {
  const ids = bulkRowIds(rowIds);
  const database = await requirePageAccess(actor.userId, databaseId, "edit");
  if (database.kind !== "database") throw withCode(new AccessError("Not a database"), "notADatabase");
  if (database.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
  const { rows, skipped } = await rowsWithAccess(actor.userId, databaseId, ids, "view");
  const done: string[] = [];
  try {
    for (const row of rows) done.push((await duplicatePage(actor, row.id, copySuffix, { notify: false })).id);
  } finally {
    if (done.length) {
      const collab = getCollab();
      collab.broadcast(`ws:${database.workspaceId}`, "tree");
      collab.broadcast(`db:${databaseId}`, "rows");
    }
  }
  return { done, skipped };
}
