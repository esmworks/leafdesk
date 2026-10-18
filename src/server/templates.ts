import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseView, page, type PageKind } from "@/db/schema";
import type { FilterEntry, ViewConfig } from "@/db/schema/app";
import {
  builtinTemplate,
  isBuiltinTemplateKey,
  type BuiltinFilter,
  type BuiltinKitDatabase,
  type BuiltinKitProperty,
  type BuiltinKitTemplate,
  type BuiltinTemplateKey,
  type BuiltinViewConfig,
} from "@/lib/builtin-templates";
import { DASHBOARD_BLOCK, newWidgetId, serializeDashboard, type DashboardWidget } from "@/lib/dashboard";
import { DATABASE_BLOCK } from "@/lib/embed-blocks";
import { holdsOptions } from "@/lib/property-types";
import { AccessError, accessRank, levelFromRank, pageVisibleTo, requireMembership, requirePageAccess, type AccessLevel } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import {
  addProperty,
  addView,
  afterRowWrites,
  authorizeRowFiles,
  dropCopiedSubItems,
  getProperties,
  listRowTemplateSummaries,
  normalizeRowProperties,
  requireDatabase,
  syncPairedRelations,
  updateProperty,
  updateView,
  withCode,
  type DatabaseProperty,
} from "@/server/databases";
import { copyPageTree } from "@/server/duplicate";
import { archivePage, createPage, ENGLISH_SEED_NAMES, removeOrphanFiles } from "@/server/pages";
import { placeTopLevel, TeamspaceError } from "@/server/teamspaces";
import { createWorkspace, requireTopLevel } from "@/server/workspaces";

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
  // A new page like any other (see createPage): rows and pages inside templates are left out.
  if (parentKind !== "database" && !root.inTemplate) {
    await recordAudit({
      workspaceId: template.workspaceId,
      actorId: userId,
      action: "page.created",
      target: { type: "page", id: root.id, label: title },
      details: { kind: template.kind, template: template.title },
    });
  }

  const collab = getCollab();
  if (parentKind === "database") {
    // Values given now go over the template's; then the row is announced like any new row.
    // Property access: the template's values for properties the user may not change in a row
    // they add were already left out by the copy (server/duplicate copiedAccess), so the template
    // still applies, without writing around the rules and without refusing it whole. Values given
    // here are the user's own and are checked like any others: a restricted one is refused.
    let values = root.inTemplate ? root.properties : await dropCopiedSubItems(root.id, parentId!, root.properties);
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
    } else {
      await authorizeRowFiles(userId, [{ rowId: root.id, before: root.properties, after: values }]);
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

type NamedProperty = Pick<DatabaseProperty, "id" | "name" | "type" | "options">;

/**
 * A template's view settings with the new database's property ids in place of their names, and in
 * filters on a select or status its option ids in place of option names.
 */
function builtinViewConfig(config: BuiltinViewConfig, properties: NamedProperty[]): ViewConfig {
  const id = (name: string | undefined) => (name === undefined ? undefined : properties.find((p) => p.name === name)?.id);
  const { groupBy, stackBy, dateBy, chartAggregate, boardAggregate, sorts, filters, calculations, ...rest } = config;
  const out: ViewConfig = { ...rest };
  // A name the database doesn't have leaves the view's own default.
  const group = id(groupBy);
  const stack = id(stackBy);
  const date = id(dateBy);
  if (group) out.groupBy = group;
  if (stack) out.stackBy = stack;
  if (date) out.dateBy = date;
  const measure = chartAggregate && id(chartAggregate.property);
  const header = boardAggregate && id(boardAggregate.property);
  if (measure) out.chartAggregate = { fn: chartAggregate.fn, propertyId: measure };
  if (header) out.boardAggregate = { fn: boardAggregate.fn, propertyId: header };
  const sortRules = (sorts ?? []).flatMap((s) => {
    const propertyId = id(s.property);
    return propertyId ? [{ propertyId, direction: s.direction }] : [];
  });
  if (sortRules.length) out.sorts = sortRules;
  const filterEntries = (filters ?? []).flatMap((f) => builtinFilter(f, properties));
  if (filterEntries.length) out.filters = filterEntries;
  const footers = Object.entries(calculations ?? {}).flatMap(([name, fn]) => {
    const propertyId = id(name);
    return propertyId ? [[propertyId, fn] as const] : [];
  });
  if (footers.length) out.calculations = Object.fromEntries(footers);
  return out;
}

/** A filter of a template as the view stores it; one on a property the database doesn't have is left out. */
function builtinFilter(filter: BuiltinFilter, properties: NamedProperty[]): FilterEntry[] {
  if ("combinator" in filter) {
    const rules = filter.rules.flatMap((rule) => builtinFilter(rule, properties));
    return rules.length ? [{ type: "group", combinator: filter.combinator, rules }] : [];
  }
  const prop = properties.find((p) => p.name === filter.property);
  if (!prop) return [];
  const option = (name: string) => prop.options.options?.find((o) => o.name === name)?.id;
  let value: unknown = filter.value;
  if (holdsOptions(prop.type) && filter.value !== undefined) {
    value = Array.isArray(filter.value) ? filter.value.flatMap((name) => option(name) ?? []) : option(filter.value);
  }
  return [
    {
      propertyId: prop.id,
      op: filter.op,
      ...(value !== undefined ? { value } : {}),
      ...(filter.days !== undefined ? { days: filter.days } : {}),
    },
  ];
}

/** Adds a property of a kit's database, its relation's target given by the kit's key for it. */
async function addKitProperty(userId: string, databaseId: string, property: BuiltinKitProperty, idOf: (key: string) => string) {
  const { name, type } = property;
  if (property.relation) {
    const { database, pairedName } = property.relation;
    return addProperty(userId, databaseId, { name, type, relation: { databaseId: idOf(database), twoWay: true, pairedName } });
  }
  if (property.rollup) {
    // Names the kit doesn't have make an invalid rollup, which addProperty refuses.
    const relation = (await getProperties(databaseId)).find((p) => p.name === property.rollup!.relation && p.type === "relation");
    const related = relation?.options.relation?.databaseId;
    const target = related ? (await getProperties(related)).find((p) => p.name === property.rollup!.target) : undefined;
    return addProperty(userId, databaseId, {
      name,
      type,
      rollup: { relationPropertyId: relation?.id ?? "", targetPropertyId: target?.id ?? "", function: property.rollup.fn },
    });
  }
  if (property.formula !== undefined) {
    return addProperty(userId, databaseId, { name, type, formula: { expression: property.formula }, number: property.number });
  }
  const created = await addProperty(userId, databaseId, {
    name,
    type,
    options: property.options?.map((o) => (type === "status" ? { name: o.name, group: o.group } : o.name)),
    number: property.number,
  });
  // Options the kit gives a color keep it; the others get the usual ones.
  const colors = new Map((property.options ?? []).flatMap((o) => (o.color ? [[o.name, o.color] as const] : [])));
  if (colors.size) {
    const options = (created.options.options ?? []).map((o) => ({ ...o, color: colors.get(o.name) ?? o.color }));
    await updateProperty(userId, created.id, { options });
  }
  return created;
}

export type MadeFromBuiltin = {
  /** The page to open: the template's page or database, or a kit's first part. */
  id: string;
  workspaceId: string;
  /** Everything a kit made, in order (its first part included). */
  parts?: { id: string; title: string; kind: PageKind }[];
};

/**
 * A kit from the gallery: its pages and databases, side by side where a new page would go and in
 * order; then the databases' properties (each relation adds its other side to the database it
 * links to, so rollups come last, through them), their views and default row templates; then the
 * dashboards over them. What was made goes to the trash when a step fails.
 */
async function createKit(
  actor: WriteActor,
  workspaceId: string,
  kit: BuiltinKitTemplate,
  { parentId, teamspaceId }: { parentId: string | null; teamspaceId?: string | null },
): Promise<MadeFromBuiltin> {
  const { userId } = actor;
  if (parentId && (await requirePageAccess(userId, parentId, "edit")).kind === "database") {
    throw withCode(new Error("A database can't contain another database"), "nestedDatabase");
  }
  const made: { key: string; id: string; title: string; kind: PageKind }[] = [];
  const idOf = (key: string) => {
    const part = made.find((m) => m.key === key);
    if (!part) throw new Error(`The kit has no part "${key}"`);
    return part.id;
  };
  try {
    for (const part of kit.parts) {
      const created =
        part.kind === "page"
          ? await createPage(actor, { workspaceId, parentId, teamspaceId, title: part.title, icon: part.icon, markdown: part.markdown })
          : await createPage(actor, {
              workspaceId,
              parentId,
              teamspaceId,
              kind: "database",
              title: part.title,
              icon: part.icon,
              seedNames: { ...ENGLISH_SEED_NAMES, table: part.views[0]?.name ?? ENGLISH_SEED_NAMES.table },
              seedProperties: false,
            });
      made.push({ key: part.key, id: created.id, title: created.title, kind: created.kind });
    }

    const databases = kit.parts.filter((p): p is BuiltinKitDatabase => p.kind === "database");
    for (const rollups of [false, true]) {
      for (const part of databases) {
        for (const property of part.properties) {
          if ((property.type === "rollup") === rollups) await addKitProperty(userId, idOf(part.key), property, idOf);
        }
      }
    }
    const propertiesOf = new Map<string, DatabaseProperty[]>();
    for (const part of databases) {
      const databaseId = idOf(part.key);
      const properties = await getProperties(databaseId);
      propertiesOf.set(part.key, properties);
      // The first view sets up the table the database started with.
      const [first, ...others] = part.views;
      const [table] = await db.select({ id: databaseView.id }).from(databaseView).where(eq(databaseView.databaseId, databaseId));
      if (first && table) await updateView(userId, table.id, { config: builtinViewConfig(first.config, properties) });
      for (const view of others) {
        await addView(userId, databaseId, { name: view.name, type: view.type, config: builtinViewConfig(view.config, properties) });
      }
      if (part.rowTemplate) {
        const template = await createRowTemplate(actor, databaseId, part.rowTemplate);
        await setDefaultRowTemplate(userId, databaseId, template.id);
      }
    }

    const collab = getCollab();
    for (const part of kit.parts) {
      if (part.kind !== "page" || !part.dashboard) continue;
      const widgets: DashboardWidget[] = [];
      for (const widget of part.dashboard) {
        widgets.push({
          id: newWidgetId(widgets),
          databaseId: idOf(widget.database),
          title: widget.title,
          span: widget.span,
          ...(widget.color ? { color: widget.color } : {}),
          view: { type: widget.view.type, config: builtinViewConfig(widget.view.config, propertiesOf.get(widget.database) ?? []) },
        });
      }
      const pageId = idOf(part.key);
      await collab.appendBlocks(pageId, [{ id: crypto.randomUUID(), type: DASHBOARD_BLOCK, props: { widgets: serializeDashboard(widgets) } }], actor);
      // The grid needs the room, as when a dashboard is added in the editor.
      await collab.setPageStyle(pageId, { fullWidth: true }, actor);
    }
    return { id: made[0].id, workspaceId, parts: made.map(({ id, title, kind }) => ({ id, title, kind })) };
  } catch (error) {
    // No half-made kit left behind: what was made goes to the trash, last first.
    for (const part of [...made].reverse()) await archivePage(userId, part.id).catch(() => {});
    throw error;
  }
}

/**
 * A new page from the built-in gallery (see lib/builtin-templates), in the user's language: a
 * page with its Markdown, or a database with its properties, views, default row template and a
 * few example rows. A database with a dashboard comes inside a page of its own, under the
 * dashboard. A kit makes all its pages and databases (see createKit). Goes where a new page would
 * (`parentId`, else the top level).
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
): Promise<MadeFromBuiltin> {
  if (!isBuiltinTemplateKey(key)) throw withCode(new Error(`Unknown built-in template "${String(key)}"`), "notATemplate");
  const builtin = await builtinTemplate(key, locale);
  if (builtin.kind === "kit") return createKit(actor, workspaceId, builtin, { parentId, teamspaceId });
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
  const { dashboard } = builtin;
  const host = dashboard
    ? await createPage(actor, { workspaceId, parentId, teamspaceId, title: builtin.title, icon: builtin.icon, markdown: dashboard.markdown })
    : null;
  let top: string | null = host?.id ?? null;
  try {
    const database = await createPage(actor, {
      workspaceId,
      parentId: host?.id ?? parentId,
      teamspaceId,
      kind: "database",
      title: dashboard?.database ?? builtin.title,
      icon: builtin.icon,
      seedNames: builtin.seedNames,
      seedProperties: builtin.seedProperties,
    });
    top ??= database.id;
    for (const property of builtin.properties) {
      await addProperty(userId, database.id, { name: property.name, type: property.type, options: property.options });
    }
    const properties = await getProperties(database.id);
    for (const view of builtin.views) {
      await addView(userId, database.id, { name: view.name, type: view.type, config: builtinViewConfig(view.config, properties) });
    }
    const template = await createRowTemplate(actor, database.id, builtin.rowTemplate);
    await setDefaultRowTemplate(userId, database.id, template.id);
    for (const row of builtin.rows) {
      await createPage(actor, { workspaceId, parentId: database.id, title: row.title, properties: row.properties });
    }
    if (!host || !dashboard) return { id: database.id, workspaceId: database.workspaceId };

    // The dashboard first, then the database it charts, shown in the page.
    const widgets: DashboardWidget[] = [];
    for (const widget of dashboard.widgets) {
      widgets.push({
        id: newWidgetId(widgets),
        databaseId: database.id,
        title: widget.title,
        span: widget.span,
        view: { type: widget.view.type, config: builtinViewConfig(widget.view.config, properties) },
      });
    }
    const collab = getCollab();
    await collab.appendBlocks(
      host.id,
      [
        { id: crypto.randomUUID(), type: DASHBOARD_BLOCK, props: { widgets: serializeDashboard(widgets) } },
        { id: crypto.randomUUID(), type: DATABASE_BLOCK, props: { databaseId: database.id } },
      ],
      actor,
    );
    // The grid needs the room, as when a dashboard is added in the editor.
    await collab.setPageStyle(host.id, { fullWidth: true }, actor);
    return { id: host.id, workspaceId: host.workspaceId };
  } catch (error) {
    // No half-made copy left behind: what was made goes to the trash (the database with the page).
    if (top) await archivePage(userId, top).catch(() => {});
    throw error;
  }
}

/**
 * A new workspace with a template of the gallery set up in its first teamspace, for the new
 * workspace dialog. The workspace stays when the template can't be set up (what it made goes to
 * the trash): `pageId`, the page to open, is then null.
 */
export async function createWorkspaceWithBuiltin(
  userId: string,
  name: string,
  key: BuiltinTemplateKey,
  { locale }: { locale?: string } = {},
): Promise<{ workspaceId: string; pageId: string | null }> {
  if (!isBuiltinTemplateKey(key)) throw withCode(new Error(`Unknown built-in template "${String(key)}"`), "notATemplate");
  const { id: workspaceId } = await createWorkspace(userId, name);
  try {
    return { workspaceId, pageId: (await createFromBuiltin({ userId }, workspaceId, key, { locale })).id };
  } catch (error) {
    console.error("[new workspace from template]", error);
    return { workspaceId, pageId: null };
  }
}
