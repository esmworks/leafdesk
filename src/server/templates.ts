import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, type PageKind } from "@/db/schema";
import { builtinTemplate, isBuiltinTemplateKey, type BuiltinTemplateKey } from "@/lib/builtin-templates";
import { AccessError, accessRank, levelFromRank, pageVisibleTo, requireMembership, requirePageAccess, type AccessLevel } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import {
  addProperty,
  addView,
  afterRowWrites,
  getProperties,
  listRowTemplateSummaries,
  normalizeRowProperties,
  requireDatabase,
  syncPairedRelations,
  updateView,
  withCode,
} from "@/server/databases";
import { copyPageTree } from "@/server/duplicate";
import { createPage, removeOrphanFiles } from "@/server/pages";
import { placeTopLevel, TeamspaceError } from "@/server/teamspaces";
import { requireTopLevel } from "@/server/workspaces";

/**
 * Templates are pages flagged `isTemplate`:
 *
 * - Workspace templates sit at the top level of the workspace and are listed by the template
 *   picker. "Save as template" copies a page (with its subpages) into one; "New page from template"
 *   copies one back into an ordinary page.
 * - Row templates are children of a database, like rows, but views, queries and exports leave them
 *   out. They carry a title, body and property values; a database may pick one as the default that
 *   "New" (and MCP's create_database_row without values) starts from.
 *
 * Every page in a template's subtree is flagged `inTemplate`, which keeps them out of the sidebar,
 * search, trash, favorites and published sites. Copies never carry the source's comment threads.
 *
 * Access: using a template needs view access on it and edit access where the copy goes (or the
 * right to add top-level pages); saving one needs view access on the source and the right to add
 * pages where the template goes; deleting one needs full access, as deleting a page for good does.
 */

export type TemplateSummary = {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  updatedAt: Date;
  /** The user's access to the template: "edit" may change it, "full" may delete it. */
  level: AccessLevel;
};

/** The workspace's templates the user can see, for the template picker. */
export async function listTemplates(userId: string, workspaceId: string): Promise<TemplateSummary[]> {
  await requireMembership(userId, workspaceId);
  const rows = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      kind: page.kind,
      updatedAt: page.updatedAt,
      level: accessRank(userId, sql`${page.id}`),
    })
    .from(page)
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        isNull(page.parentId),
        eq(page.isTemplate, true),
        isNull(page.archivedAt),
        pageVisibleTo(userId),
      ),
    )
    .orderBy(asc(page.title), asc(page.createdAt));
  return rows.map((r) => ({ ...r, level: levelFromRank(r.level) }));
}

/** A database's row templates and the default one, as far as the user can see them. */
export async function listRowTemplates(userId: string, databaseId: string) {
  const database = await requireDatabase(userId, databaseId, "view");
  const templates = await listRowTemplateSummaries(userId, databaseId);
  const defaultTemplateId = templates.some((t) => t.id === database.defaultTemplateId) ? database.defaultTemplateId : null;
  return { databaseId, defaultTemplateId, templates };
}

async function endPosition(workspaceId: string, parentId: string | null) {
  const [row] = await db
    .select({ max: max(page.position) })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), parentId ? eq(page.parentId, parentId) : isNull(page.parentId)));
  return (Number(row?.max) || 0) + 1;
}

async function requireTemplate(userId: string, templateId: string, needed: "view" | "edit" | "full") {
  const template = await requirePageAccess(userId, templateId, needed);
  if (!template.isTemplate) throw withCode(new AccessError("Not a template"), "notATemplate");
  if (template.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
  return template;
}

export type SavedTemplate = {
  id: string;
  workspaceId: string;
  /** The database for row templates, null for workspace templates. */
  databaseId: string | null;
};

/**
 * Saves a copy of a page, with its subpages, as a template: a row of a database becomes one of
 * that database's row templates, any other page (or database) a workspace template. The page
 * itself stays as it is. The template keeps the page's own permission entries, so it is never
 * visible to more people than the page, and starts without its comments. It carries only what
 * the user's property access lets them copy (server/duplicate copiedAccess): a row template keeps
 * the values they may set in their own rows, databases in the page what they may view.
 */
export async function saveAsTemplate(actor: WriteActor, pageId: string): Promise<SavedTemplate> {
  const { userId } = actor;
  const source = await requirePageAccess(userId, pageId, "view");
  if (source.archivedAt) throw new Error("Restore the page from the trash before saving it as a template");
  if (source.inTemplate) throw withCode(new Error("This page is already part of a template"), "isTemplate");
  const parent = source.parentId ? await requirePageAccess(userId, source.parentId, "view") : null;

  if (parent?.kind === "database") {
    const database = await requireDatabase(userId, parent.id, "edit");
    if (database.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
    const { root } = await copyPageTree(actor, source, {
      parentId: database.id,
      parentInTemplate: database.inTemplate,
      title: source.title,
      position: await endPosition(source.workspaceId, database.id),
      rootTemplate: true,
      rootPermissions: true,
      teamspaceId: null,
      private: false,
      stripComments: true,
    });
    getCollab().broadcast(`db:${database.id}`, "rows");
    return { id: root.id, workspaceId: source.workspaceId, databaseId: database.id };
  }

  // In the page's teamspace, seen by those who see the page there; private when they can't add to it.
  const topLevel = await requireTopLevel(userId, source.workspaceId);
  const placement = await placeTopLevel(userId, source.workspaceId, topLevel, source.teamspaceId).catch((error) => {
    if (error instanceof AccessError || error instanceof TeamspaceError) return { teamspaceId: null, private: true };
    throw error;
  });
  const { root } = await copyPageTree(actor, source, {
    parentId: null,
    parentInTemplate: false,
    title: source.title,
    position: await endPosition(source.workspaceId, null),
    rootTemplate: true,
    rootPermissions: true,
    teamspaceId: placement.teamspaceId,
    private: placement.private,
    stripComments: true,
  });
  getCollab().broadcast(`ws:${source.workspaceId}`, "templates");
  return { id: root.id, workspaceId: source.workspaceId, databaseId: null };
}

export type FromTemplateInput = {
  /**
   * Where the new page goes: a page, a database (the new page becomes a row) or the top level
   * (null or missing). Row templates always make a row of their own database.
   */
  parentId?: string | null;
  /** Replaces the template's title. */
  title?: string;
  /** Row values (by property id or name) set over the template's, when the new page is a row. */
  properties?: Record<string, unknown>;
  /** At the top level: the teamspace, null for a private page, undefined for the default one (see createPage). */
  teamspaceId?: string | null;
};

/**
 * A new page (or row) copied from a template with everything under it, without the template flag
 * and without the template's comments. It gets the access of where it lands, like any new page.
 */
export async function createFromTemplate(
  actor: WriteActor,
  templateId: string,
  input: FromTemplateInput = {},
): Promise<{ id: string; workspaceId: string; parentId: string | null }> {
  const { userId } = actor;
  const template = await requireTemplate(userId, templateId, "view");
  const parentId = template.parentId ?? input.parentId ?? null;
  if (template.parentId && input.parentId && input.parentId !== template.parentId) {
    throw withCode(new Error("A row template makes rows of its own database"), "notATemplate");
  }

  let parentKind: PageKind | null = null;
  let parentInTemplate = false;
  let placement: { teamspaceId: string | null; private: boolean } = { teamspaceId: null, private: false };
  if (parentId) {
    const parent = await requirePageAccess(userId, parentId, "edit");
    if (parent.workspaceId !== template.workspaceId) throw new AccessError("Templates are used in their own workspace");
    if (parent.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
    if (parent.kind === "database" && template.kind === "database") {
      throw withCode(new Error("A database can't contain another database"), "nestedDatabase");
    }
    parentKind = parent.kind;
    parentInTemplate = parent.inTemplate;
  } else {
    const topLevel = await requireTopLevel(userId, template.workspaceId);
    placement = await placeTopLevel(userId, template.workspaceId, topLevel, input.teamspaceId);
  }

  const title = input.title?.trim() || template.title;
  const { root } = await copyPageTree(actor, template, {
    parentId,
    parentInTemplate,
    title,
    position: await endPosition(template.workspaceId, parentId),
    rootTemplate: false,
    rootPermissions: false,
    teamspaceId: placement.teamspaceId,
    private: placement.private,
    stripComments: true,
  });

  const collab = getCollab();
  if (parentKind === "database") {
    // Values given now go over the template's; then the row is announced like any new row.
    // Property access: the template's values for properties the user may not change in a row
    // they add were already left out by the copy (server/duplicate copiedAccess), so the template
    // still applies, without writing around the rules and without refusing it whole. Values given
    // here are the user's own and are checked like any others: a restricted one is refused.
    let values = root.properties;
    if (input.properties && Object.keys(input.properties).length) {
      const normalized = await normalizeRowProperties(userId, parentId!, input.properties, values, { createdBy: userId });
      values = { ...values };
      for (const [id, value] of Object.entries(normalized)) {
        if (value === null) delete values[id];
        else values[id] = value;
      }
      await db.update(page).set({ properties: values }).where(eq(page.id, root.id));
    }
    if (!root.inTemplate) {
      await syncPairedRelations(root.id, parentId!, {}, values);
      await afterRowWrites(userId, parentId!, [{ rowId: root.id, before: {}, after: values }], { created: true });
    }
    collab.broadcast(`db:${parentId}`, "rows");
  }
  collab.broadcast(`ws:${template.workspaceId}`, "tree");
  return { id: root.id, workspaceId: template.workspaceId, parentId };
}

/**
 * A new row: from the database's default row template when it has one the user can see and no
 * values are given (`useDefault`), else blank like any new row.
 */
export async function createRow(
  actor: WriteActor,
  databaseId: string,
  input: { title?: string; properties?: Record<string, unknown>; templateId?: string | null; useDefault?: boolean },
): Promise<{ id: string; position: number; templateId: string | null }> {
  const database = await requireDatabase(actor.userId, databaseId, "edit");
  let templateId = input.templateId ?? null;
  if (!templateId && input.useDefault && database.defaultTemplateId) {
    const { level } = await resolveLevel(actor.userId, database.defaultTemplateId);
    if (level !== "none") templateId = database.defaultTemplateId;
  }
  if (templateId) {
    const template = await requireTemplate(actor.userId, templateId, "view");
    if (template.parentId !== databaseId) throw withCode(new Error("Not a row template of this database"), "notATemplate");
    const created = await createFromTemplate(actor, templateId, { title: input.title, properties: input.properties });
    const [row] = await db.select({ position: page.position }).from(page).where(eq(page.id, created.id));
    return { id: created.id, position: row?.position ?? 0, templateId };
  }
  const created = await createPage(actor, {
    workspaceId: database.workspaceId,
    parentId: databaseId,
    title: input.title,
    properties: input.properties,
  });
  return { id: created.id, position: created.position, templateId: null };
}

async function resolveLevel(userId: string, pageId: string) {
  const [row] = await db
    .select({ level: accessRank(userId, sql`${page.id}`), archivedAt: page.archivedAt })
    .from(page)
    .where(eq(page.id, pageId));
  return { level: row && !row.archivedAt ? levelFromRank(row.level) : ("none" as AccessLevel) };
}

/** A blank row template in a database, to fill in on its own page. */
export async function createRowTemplate(
  actor: WriteActor,
  databaseId: string,
  input: { title?: string; properties?: Record<string, unknown>; markdown?: string } = {},
) {
  const database = await requireDatabase(actor.userId, databaseId, "edit");
  const created = await createPage(actor, {
    workspaceId: database.workspaceId,
    parentId: databaseId,
    title: input.title,
    properties: input.properties,
    markdown: input.markdown,
    template: true,
  });
  return { id: created.id };
}

/** Picks the row template "New" starts from, or none (null) for blank rows. Needs edit access. */
export async function setDefaultRowTemplate(userId: string, databaseId: string, templateId: string | null) {
  await requireDatabase(userId, databaseId, "edit");
  if (templateId) {
    const template = await requireTemplate(userId, templateId, "view");
    if (template.parentId !== databaseId) throw withCode(new Error("Not a row template of this database"), "notATemplate");
  }
  await db.update(page).set({ defaultTemplateId: templateId, updatedBy: userId }).where(eq(page.id, databaseId));
  getCollab().broadcast(`db:${databaseId}`, "rows");
}

/**
 * Deletes a template for good, with everything under it. Templates never go to the trash (they
 * aren't listed there), so this needs full access, like emptying the trash does.
 */
export async function deleteTemplate(userId: string, templateId: string) {
  const template = await requirePageAccess(userId, templateId, "full");
  if (!template.isTemplate) throw withCode(new AccessError("Not a template"), "notATemplate");
  await db.delete(page).where(eq(page.id, templateId));
  await removeOrphanFiles(template.workspaceId);
  const collab = getCollab();
  if (template.parentId) collab.broadcast(`db:${template.parentId}`, "rows");
  else collab.broadcast(`ws:${template.workspaceId}`, "templates");
  return { workspaceId: template.workspaceId, databaseId: template.parentId };
}

/**
 * A new page from the built-in gallery (see lib/builtin-templates), in the user's language: a
 * page with its Markdown, or a database with its properties, board, default row template and a
 * few example rows. Goes where a new page would (`parentId`, else the top level).
 */
export async function createFromBuiltin(
  actor: WriteActor,
  workspaceId: string,
  key: BuiltinTemplateKey,
  {
    locale,
    parentId = null,
    teamspaceId,
  }: { locale?: string; parentId?: string | null; teamspaceId?: string | null } = {},
): Promise<{ id: string; workspaceId: string }> {
  if (!isBuiltinTemplateKey(key)) throw withCode(new Error(`Unknown built-in template "${String(key)}"`), "notATemplate");
  const builtin = await builtinTemplate(key, locale);
  if (builtin.kind === "page") {
    const created = await createPage(actor, {
      workspaceId,
      parentId,
      teamspaceId,
      title: builtin.title,
      icon: builtin.icon,
      markdown: builtin.markdown,
    });
    return { id: created.id, workspaceId: created.workspaceId };
  }

  const { userId } = actor;
  const database = await createPage(actor, {
    workspaceId,
    parentId,
    teamspaceId,
    kind: "database",
    title: builtin.title,
    icon: builtin.icon,
    seedNames: builtin.seedNames,
  });
  for (const property of builtin.properties) {
    await addProperty(userId, database.id, { name: property.name, type: property.type, options: property.options });
  }
  const board = await addView(userId, database.id, { name: builtin.board, type: "board" });
  // The board groups by the status every new database starts with.
  const status = (await getProperties(database.id)).find((p) => p.type === "status");
  if (status) await updateView(userId, board.id, { config: { ...board.config, groupBy: status.id } });
  const template = await createRowTemplate(actor, database.id, builtin.rowTemplate);
  await setDefaultRowTemplate(userId, database.id, template.id);
  for (const row of builtin.rows) {
    await createPage(actor, { workspaceId, parentId: database.id, title: row.title, properties: row.properties });
  }
  return { id: database.id, workspaceId: database.workspaceId };
}

