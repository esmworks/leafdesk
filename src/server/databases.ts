import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { queueAutomations } from "./automations/queue";
import {
  databaseProperty,
  databaseView,
  page,
  PROPERTY_TYPES,
  propertyPermission,
  schedule,
  user,
  type DateOptions,
  type DependencyConfig,
  type DependencyShift,
  type FormulaConfig,
  type NumberFormat,
  type PropertyOptions,
  type PropertyType,
  type RelationConfig,
  type RollupConfig,
  type SelectOption,
  type ViewConfig,
  type ViewType,
} from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { firstImageInYdoc, PG_MARKDOWN_IMAGE_PATTERN } from "@/lib/cover";
import { asFiles, fileIdOf, fileUrl, type FileValue } from "@/lib/files";
import { repeatSummary, type TemplateRepeatSummary } from "@/lib/schedule";
import { isApplicable, isRollupFn, ROLLUP_DISPLAYS, type RollupDisplay } from "@/lib/aggregate";
import { compileFormulas, formulaForStorage, TITLE_FIELD, valueType, withFormulaTypes } from "@/lib/derived";
import { isEmptyValue, lostValues, planConversion, retypeViewConfig, type ConversionContext } from "@/lib/convert-property";
import { dropPropertyReferences } from "@/lib/duplicate";
import { filterConfigError, filterRules } from "@/lib/filters";
import { chartGroupProperty } from "@/lib/chart";
import { defaultFormConfig } from "@/lib/forms";
import { DEFAULT_VIEW_NAMES, galleryCover, isViewType, layoutConfigError } from "@/lib/views";
import { holdsOptions, holdsPeople, isComputed, isDerived, isReadOnlyType, PERSON_ME, type StatusGroup } from "@/lib/property-types";
import { canRestrict, namesPeople } from "@/lib/property-access";
import { moveGroupValue } from "@/lib/grouping";
import { makesLoop, parentProperty, singleParent, storedParent, subItemsProperty } from "@/lib/sub-items";
import {
  blockedByProperty,
  blockingProperty,
  DEPENDENCY_SHIFTS,
  dependencySettings,
  makesDependencyLoop,
  planShifts,
  rowSpan,
  storedBlockers,
  type DependencyInput,
  type Span,
} from "@/lib/dependencies";
import { calculationFormat, checkNumberFormat } from "@/lib/number-format";
import { checkDateOptions, type DateOptionsInput } from "@/lib/date-options";
import { dayValue } from "@/lib/timeline";
import {
  applyView,
  computedValues,
  isGroupable,
  makeStatusOptions,
  normalizeValue,
  positionBetween,
  PropertyValueError,
  SELECT_COLORS,
  sortStatusOptions,
  statusColor,
  type DatabaseErrorCode,
} from "@/lib/properties";
import {
  AccessError,
  accessRank,
  getMembership,
  hasLevel,
  isGuest,
  levelFromRank,
  pageVisibleTo,
  requireMembership,
  requirePageAccess,
  type RequiredLevel,
} from "@/server/access";
import { scheduleAssignmentEmails } from "@/server/assignments";
import { computeDerived, loadProperties } from "@/server/derived";
import { fileForViewer, workspaceFiles } from "@/server/files";
import { recordAssignments } from "@/server/notifications";
import { getCollab } from "@/server/collab/bridge";
import { rowChanged } from "@/server/row-events";
import { workspacePeople, type WorkspacePerson } from "@/server/workspaces";
import { agentMarks, isAgentUser } from "@/server/agents/users";
import {
  assignmentsTheySee,
  propertyAccessFor,
  restoreReferences,
  unknownProperties,
  type PropertyAccess,
  type RedactedFields,
} from "@/server/property-access";

export type DatabaseProperty = typeof databaseProperty.$inferSelect;
export type DatabaseView = typeof databaseView.$inferSelect;
export type DatabaseRow = {
  id: string;
  title: string;
  icon: string | null;
  properties: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
} & RedactedFields;

/**
 * Rows as read from the database, with values Leafdesk fills in (who created and last edited
 * them, and when) merged in.
 */
function withComputed<T extends StoredRow>(
  rows: T[],
  properties: { id: string; type: PropertyType }[],
): (Omit<T, "createdBy" | "updatedBy"> & { properties: Record<string, unknown> })[] {
  if (!properties.some((p) => isComputed(p.type))) return rows.map(({ createdBy: _, updatedBy: __, ...row }) => row);
  return rows.map(({ createdBy, updatedBy, ...row }) => ({
    ...row,
    properties: { ...row.properties, ...computedValues(properties, { createdBy, updatedBy, ...row }) },
  }));
}

type StoredRow = {
  title: string;
  properties: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Rows as `userId` reads them: stored values, system values (withComputed) and derived values
 * (formulas), evaluated once per row, without what property access keeps from them (values of
 * restricted properties are left out before formulas run, so no formula or rollup shows them
 * either). Pass `lookups` when they are loaded anyway, so formulas that show people or related
 * rows don't load them again, and `access` when it is loaded anyway.
 */
async function withValues<T extends StoredRow>(
  userId: string,
  databaseId: string,
  rows: T[],
  properties: DatabaseProperty[],
  lookups?: DatabaseLookups,
  access?: PropertyAccess,
) {
  access ??= await propertyAccessFor(userId, databaseId);
  const derived = await computeDerived(access.strip(withComputed(rows, properties)), properties, {
    viewerId: userId,
    lookups: (props) => (lookups && props === properties ? Promise.resolve(lookups) : getLookups(userId, props)),
    accessFor: (databaseId) => propertyAccessFor(userId, databaseId),
  });
  return access.finish(derived);
}


/** One row's values as `userId` reads them (see withValues), e.g. for MCP output. */
export async function rowValues(
  userId: string,
  row: StoredRow & { parentId: string | null },
  properties: DatabaseProperty[],
): Promise<Record<string, unknown>> {
  if (!row.parentId) return {};
  const [out] = await withValues(userId, row.parentId, [row], properties);
  return out.properties;
}

/** Sorting by a people property orders rows by names, so the view needs to know them. */
async function peopleForSorts(userId: string, properties: DatabaseProperty[], config: ViewConfig) {
  const sorted = (config.sorts ?? []).some((s) => properties.some((p) => p.id === s.propertyId && holdsPeople(p.type)));
  return sorted ? getPeople(userId, properties) : [];
}

/**
 * Tags a guard error with a stable code the UI translates. The class and English message are
 * unchanged, so MCP output and `instanceof` checks behave as before.
 */
export function withCode<E extends Error>(error: E, code: DatabaseErrorCode): E & { code: DatabaseErrorCode } {
  return Object.assign(error, { code });
}

export async function requireDatabase(userId: string, databaseId: string, needed: RequiredLevel) {
  const p = await requirePageAccess(userId, databaseId, needed);
  if (p.kind !== "database") throw withCode(new AccessError("Not a database"), "notADatabase");
  return p;
}

/**
 * A locked database keeps its properties and views: they can't be added, renamed or removed until
 * someone with full access unlocks it. Rows, cell values and view filters stay editable.
 */
function assertUnlocked(database: { lockedAt: Date | null }) {
  if (database.lockedAt) throw withCode(new Error("The database is locked"), "databaseLocked");
}

/** Locks or unlocks a database's schema. Needs full access. */
export async function setDatabaseLocked(userId: string, databaseId: string, locked: boolean) {
  await requireDatabase(userId, databaseId, "full");
  await db
    .update(page)
    .set({ lockedAt: locked ? new Date() : null, updatedBy: userId })
    .where(eq(page.id, databaseId));
  notifySchema(databaseId);
}

function notifyRows(databaseId: string) {
  getCollab().broadcast(`db:${databaseId}`, "rows");
}
function notifySchema(databaseId: string) {
  getCollab().broadcast(`db:${databaseId}`, "schema");
}
/** The sidebar lists database views, so adding, renaming or removing one refreshes the tree. */
function notifyTree(workspaceId: string) {
  getCollab().broadcast(`ws:${workspaceId}`, "tree");
}

/** A database's properties in order, with each formula's result type filled in (see FormulaConfig). */
export async function getProperties(databaseId: string) {
  const properties = await db
    .select()
    .from(databaseProperty)
    .where(eq(databaseProperty.databaseId, databaseId))
    .orderBy(asc(databaseProperty.position), asc(databaseProperty.createdAt));
  return withRollupUnits(withFormulaTypes(properties));
}

/**
 * Rollups that sum, average… a number property get its format (RollupConfig.number), so they show
 * in it and filters compare what they show; read each time, a change of that format shows at once.
 */
async function withRollupUnits(properties: DatabaseProperty[]): Promise<DatabaseProperty[]> {
  const related = new Map(properties.flatMap((p) => (p.type === "relation" && p.options.relation ? [[p.id, p.options.relation.databaseId]] : [])));
  const databaseOf = (p: DatabaseProperty) => (p.type === "rollup" && p.options.rollup ? related.get(p.options.rollup.relationPropertyId) : undefined);
  const databaseIds = [...new Set(properties.flatMap((p) => databaseOf(p) ?? []))];
  if (!databaseIds.length) return properties;
  const targets = await loadProperties(databaseIds);
  return properties.map((p) => {
    const config = p.options.rollup;
    const databaseId = databaseOf(p);
    const target = config && databaseId ? targets.get(databaseId)?.find((t) => t.id === config.targetPropertyId) : undefined;
    const number = config && target?.type === "number" ? calculationFormat(config.function, target.options) : undefined;
    return number ? { ...p, options: { ...p.options, rollup: { ...config!, number } } } : p;
  });
}

/** The properties of a database `userId` may know of (see server/property-access). */
export async function knownProperties(userId: string, databaseId: string) {
  const [all, access] = await Promise.all([getProperties(databaseId), propertyAccessFor(userId, databaseId)]);
  return access.visible(all);
}

/**
 * A database as `userId` sees it: the properties they may know of (see server/property-access)
 * and views without references to the others. `access` redacts rows read with them;
 * `propertyAccess` tells the client which properties are restricted and how.
 */
export async function getDatabase(userId: string, databaseId: string) {
  const database = await requireDatabase(userId, databaseId, "view");
  const [all, stored, access] = await Promise.all([
    getProperties(databaseId),
    db
      .select()
      .from(databaseView)
      .where(eq(databaseView.databaseId, databaseId))
      .orderBy(asc(databaseView.position), asc(databaseView.createdAt)),
    propertyAccessFor(userId, databaseId),
  ]);
  const properties = access.visible(all);
  const views = access.open ? stored : stored.map((v) => ({ ...v, config: access.viewConfig(v.config) }));
  return { database, properties, views, access, propertyAccess: access.info() };
}

export async function listRows(userId: string, databaseId: string, config: ViewConfig = {}) {
  // Rows inherit their database's access; rows restricted on their own are left out.
  await requireDatabase(userId, databaseId, "view");
  return viewedRows(userId, databaseId, config);
}

/**
 * listRows of a database the user is known to see (checked by the caller); `known` is its
 * properties when they're already loaded.
 */
export async function viewedRows(
  userId: string,
  databaseId: string,
  config: ViewConfig = {},
  known?: Awaited<ReturnType<typeof getProperties>>,
) {
  const [rows, all, access] = await Promise.all([
    db
      .select({
        id: page.id,
        title: page.title,
        icon: page.icon,
        properties: page.properties,
        createdBy: page.createdBy,
        updatedBy: page.updatedBy,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      })
      .from(page)
      .where(and(eq(page.parentId, databaseId), eq(page.isTemplate, false), isNull(page.archivedAt), pageVisibleTo(userId)))
      .orderBy(asc(page.position), asc(page.createdAt)),
    known ?? getProperties(databaseId),
    propertyAccessFor(userId, databaseId),
  ]);
  // Filters and sorts on properties the viewer can't know of don't apply; on ones whose values
  // they can't see they run on the redacted values, so the rows they get say nothing about them.
  const properties = access.visible(all);
  config = access.viewConfig(config);
  const people = await peopleForSorts(userId, properties, config);
  return applyView<DatabaseRow>(await withValues(userId, databaseId, rows, all, undefined, access), config, properties, {
    viewerId: userId,
    people,
  });
}

/**
 * Validates row values keyed by property id or (case-insensitive) name and returns them keyed
 * by id. Unknown keys are rejected so agents learn the schema instead of silently losing data;
 * properties the user can't know of count as unknown, and ones whose values they may not change
 * in this row are refused (see server/property-access), unless `check` is false because the
 * caller checks each row itself.
 */
export async function normalizeRowProperties(
  userId: string,
  databaseId: string,
  input: Record<string, unknown>,
  /** The row's stored values, when editing an existing row. */
  existing: Record<string, unknown> = {},
  options: { check?: boolean; createdBy?: string | null } = {},
) {
  const [all, access] = await Promise.all([getProperties(databaseId), propertyAccessFor(userId, databaseId)]);
  const props = access.visible(all);
  const out: Record<string, unknown> = {};
  let people: Promise<WorkspacePerson[]> | undefined;
  let asAgent: Promise<boolean> | undefined;
  let workspace: Promise<string | null> | undefined;
  for (const [key, value] of Object.entries(input)) {
    const prop = props.find((p) => p.id === key) ?? props.find((p) => p.name.toLowerCase() === key.toLowerCase());
    if (!prop) {
      throw new PropertyValueError(
        `Unknown property "${key}". Available: ${props.map((p) => `${p.name} (${p.type})`).join(", ") || "none"}`,
        "unknownProperty",
        { property: key },
      );
    }
    const normalized = normalizeValue(prop, value);
    if (prop.type === "relation" && normalized) {
      const ids = await resolveRelationValue(userId, prop, normalized as string[], asIds(existing[prop.id]));
      // A row has one parent (see lib/sub-items).
      out[prop.id] = isParentProperty(prop) ? singleParent(ids, asIds(existing[prop.id])) : ids;
    } else if (prop.type === "person" && normalized) {
      people ??= workspacePeopleOf(databaseId);
      asAgent ??= isAgentUser(userId);
      out[prop.id] = resolvePersonValue(userId, prop, normalized as string[], asIds(existing[prop.id]), await people, await asAgent);
    } else if (prop.type === "files" && normalized) {
      workspace ??= workspaceOf(databaseId);
      out[prop.id] = await resolveFilesValue(userId, prop, normalized as FileValue[], asFiles(existing[prop.id]), await workspace);
    } else out[prop.id] = normalized;
  }
  if (options.check !== false) access.requireValues({ properties: existing, createdBy: options.createdBy }, Object.keys(out));
  return out;
}

async function workspaceOf(databaseId: string): Promise<string | null> {
  const [database] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, databaseId));
  return database?.workspaceId ?? null;
}

/**
 * Maps files input to stored values: files of the database's workspace that the user may read (see
 * files.fileForViewer), each with the name and type it was uploaded with. Files the value already
 * holds are kept without asking again, and dropped once they no longer exist, so a file removed
 * meanwhile never blocks editing the rest of the cell. Anyone who can see the row can then read
 * its files (the file_reference trigger, drizzle/0016).
 */
async function resolveFilesValue(
  userId: string,
  prop: DatabaseProperty,
  input: FileValue[],
  existing: FileValue[],
  workspaceId: string | null,
): Promise<FileValue[] | null> {
  const ids = input.flatMap((f) => fileIdOf(f.url) ?? []);
  const found = new Map((workspaceId ? await workspaceFiles(workspaceId, ids) : []).map((f) => [f.id, f]));
  const held = new Set(existing.flatMap((f) => fileIdOf(f.url) ?? []));
  const out: FileValue[] = [];
  for (const id of ids) {
    const stored = found.get(id);
    if (!stored && held.has(id)) continue;
    if (!stored || (!held.has(id) && !(await fileForViewer(userId, id)))) {
      throw new PropertyValueError(`"${prop.name}" can only hold files uploaded to this workspace that you can open`, "invalidFile", {
        property: prop.name,
      });
    }
    out.push({ url: fileUrl(id), name: stored.name, type: stored.contentType });
  }
  return out.length ? out : null;
}

/** Everyone in the workspace a database belongs to, guests included (agents' users aren't people). */
async function workspacePeopleOf(databaseId: string): Promise<WorkspacePerson[]> {
  const [database] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, databaseId));
  return database ? workspacePeople(database.workspaceId) : [];
}

/**
 * Maps person input to user ids of people in the workspace. Each entry is a user id, "me", or,
 * for AI clients, an email or the exact name of someone in the workspace. Ids the value already
 * holds are kept after their person left the workspace, so a former assignee never blocks
 * editing the rest of the cell. Guests can't see who is in the workspace, so they can't look
 * people up by email or name either. Agents (`asAgent`, guests of their workspace that work for
 * it) look people up by name, never by email; they aren't people, so "me" names no one.
 */
function resolvePersonValue(
  userId: string,
  prop: DatabaseProperty,
  input: string[],
  existing: string[],
  people: WorkspacePerson[],
  asAgent = false,
) {
  const actor = people.find((p) => p.id === userId);
  const byEmailToo = Boolean(actor && actor.role !== "guest");
  const lookup = byEmailToo || asAgent;
  const out: string[] = [];
  for (const value of input) {
    let id: string | undefined;
    if (value.toLowerCase() === PERSON_ME && actor) id = userId;
    else if (people.some((p) => p.id === value) || existing.includes(value)) id = value;
    else if (lookup) {
      const needle = value.trim().toLowerCase();
      const byEmail = byEmailToo ? people.find((p) => p.email.toLowerCase() === needle) : undefined;
      const byName = people.filter((p) => p.name.trim().toLowerCase() === needle);
      if (!byEmail && byName.length > 1) {
        throw new PropertyValueError(
          `"${value}" matches ${byName.length} people in the workspace; pass ${byEmailToo ? "an email or " : "a "}user id instead`,
          "invalidPerson",
          { property: prop.name },
        );
      }
      id = byEmail?.id ?? byName[0]?.id;
    }
    if (!id) {
      throw new PropertyValueError(`"${value}" is not a person in this workspace`, "invalidPerson", {
        property: prop.name,
      });
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Maps relation input to row ids of the related database. Each entry is a row id (trashed rows
 * included, so existing links survive an edit) or, for agents, the exact title of a live row.
 * Ids the row already links to are kept when the user can't see them, and dropped when they are
 * no longer rows of the related database (deleted for good or moved out), so a stale link never
 * blocks editing the rest of the cell.
 */
async function resolveRelationValue(userId: string, prop: DatabaseProperty, input: string[], existing: string[] = []) {
  const targetId = prop.options.relation?.databaseId;
  const invalid = (value: string) =>
    new PropertyValueError(`"${value}" is not a row of the database related to "${prop.name}"`, "invalidRelation", {
      property: prop.name,
    });
  if (!targetId) throw invalid(input[0]);
  // Only rows the user can see can be linked (or found by title); row templates never.
  const rows = await db
    .select({ id: page.id, title: page.title, archivedAt: page.archivedAt })
    .from(page)
    .where(and(eq(page.parentId, targetId), eq(page.isTemplate, false), pageVisibleTo(userId)));
  const ids = new Set(rows.map((r) => r.id));
  const unseen = existing.filter((id) => !ids.has(id) && input.includes(id));
  const hidden = new Set(
    unseen.length
      ? (
          await db
            .select({ id: page.id })
            .from(page)
            .where(and(eq(page.parentId, targetId), eq(page.isTemplate, false), inArray(page.id, unseen)))
        ).map((r) => r.id)
      : [],
  );
  const out: string[] = [];
  for (const value of input) {
    if (unseen.includes(value)) {
      if (hidden.has(value) && !out.includes(value)) out.push(value);
      continue;
    }
    let id = ids.has(value) ? value : undefined;
    if (!id) {
      const needle = value.trim().toLowerCase();
      const matches = rows.filter((r) => !r.archivedAt && r.title.trim().toLowerCase() === needle);
      if (matches.length > 1) {
        throw new PropertyValueError(
          `"${value}" matches ${matches.length} rows of the related database; pass a row id instead`,
          "invalidRelation",
          { property: prop.name },
        );
      }
      id = matches[0]?.id;
    }
    if (!id) throw invalid(value);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const isParentProperty = (prop: DatabaseProperty) => parentProperty([prop]) === prop;

/**
 * Refuses writes that would put a row under itself: a parent that is the row or one of its
 * sub-items (at any depth), or a sub-item that is the row or one of its parents. `writes` are the
 * normalized values about to be stored, per row.
 */
async function checkSubItemLoops(databaseId: string, writes: { rowId: string; values: Record<string, unknown> }[]) {
  const properties = await getProperties(databaseId);
  const parentProp = parentProperty(properties);
  if (!parentProp) return;
  const childrenProp = subItemsProperty(properties);
  const touched = writes.filter(
    ({ values }) => values[parentProp.id] != null || (childrenProp && values[childrenProp.id] != null),
  );
  if (!touched.length) return;
  const rows = await db
    .select({ id: page.id, properties: page.properties })
    .from(page)
    .where(eq(page.parentId, databaseId));
  const parents = new Map(rows.map((r) => [r.id, storedParent(r, parentProp.id)] as const));
  const loop = (name: string) =>
    new PropertyValueError(`"${name}" can't put a row under itself or under one of its own sub-items`, "subItemLoop", {
      property: name,
    });
  for (const { rowId, values } of touched) {
    const parent = asIds(values[parentProp.id])[0];
    if (parent && makesLoop(parents, rowId, parent)) throw loop(parentProp.name);
    if (!childrenProp) continue;
    for (const child of asIds(values[childrenProp.id])) {
      if (makesLoop(parents, child, rowId)) throw loop(childrenProp.name);
    }
  }
}

/**
 * Refuses writes that would make a row wait for itself: a blocker that is the row or waits for it
 * (through any number of rows), from either side of the relation. `writes` as in checkSubItemLoops.
 */
async function checkDependencyLoops(databaseId: string, writes: { rowId: string; values: Record<string, unknown> }[]) {
  const properties = await getProperties(databaseId);
  const by = blockedByProperty(properties);
  if (!by) return;
  const blocking = blockingProperty(properties);
  const touched = writes.filter(({ values }) => values[by.id] != null || (blocking && values[blocking.id] != null));
  if (!touched.length) return;
  const rows = await db
    .select({ id: page.id, properties: page.properties })
    .from(page)
    .where(eq(page.parentId, databaseId));
  const blockers = new Map(rows.map((r) => [r.id, storedBlockers(r, by.id)] as const));
  const loop = (name: string) =>
    new PropertyValueError(`"${name}" can't make a row wait for itself or for a row waiting for it`, "dependencyLoop", {
      property: name,
    });
  for (const { rowId, values } of touched) {
    for (const blocker of asIds(values[by.id])) {
      if (makesDependencyLoop(blockers, rowId, blocker)) throw loop(by.name);
    }
    if (!blocking) continue;
    for (const waiting of asIds(values[blocking.id])) {
      if (makesDependencyLoop(blockers, waiting, rowId)) throw loop(blocking.name);
    }
  }
}

/** Refuses writes that close a loop of sub-items or of dependencies. */
async function checkLoops(databaseId: string, writes: { rowId: string; values: Record<string, unknown> }[]) {
  await checkSubItemLoops(databaseId, writes);
  await checkDependencyLoops(databaseId, writes);
}

/**
 * Mirrors changes of two-way relations onto the paired property of the linked rows. Uses atomic
 * JSONB updates so concurrent edits of the same target row don't overwrite each other.
 */
export async function syncPairedRelations(
  rowId: string,
  databaseId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  await syncPairedRelationsMany(databaseId, [{ rowId, before, after }]);
}

/** `syncPairedRelations` for several rows of one database; each related database is notified once. */
export async function syncPairedRelationsMany(
  databaseId: string,
  changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[],
) {
  const all = await getProperties(databaseId);
  const props = all.filter((p) => p.type === "relation" && p.options.relation?.pairedPropertyId);
  if (!props.length) return;
  const parentKey = parentProperty(all)?.id;
  const touched = new Set<string>();
  for (const { rowId, before, after } of changes) {
    for (const prop of props) {
      const relation = prop.options.relation!;
      const was = asIds(before[prop.id]);
      const now = asIds(after[prop.id]);
      const added = now.filter((id) => !was.includes(id));
      const removed = was.filter((id) => !now.includes(id));
      if (!added.length && !removed.length) continue;
      const key = relation.pairedPropertyId!;
      const path = `{${key}}`;
      const current = sql`coalesce(${page.properties} -> ${key}, '[]'::jsonb)`;
      // Rows added as sub-items get this row as their only parent: they leave their old parent's list.
      if (added.length && parentKey === key) {
        await moveSubItems(databaseId, rowId, added, key, prop.id);
        touched.add(databaseId);
      } else if (added.length) {
        await db
          .update(page)
          .set({
            properties: sql`jsonb_set(${page.properties}, ${path}::text[], ${current} || to_jsonb(${rowId}::text))`,
          })
          .where(
            and(
              inArray(page.id, added),
              eq(page.parentId, relation.databaseId),
              sql`not (${current} ? ${rowId})`,
            ),
          );
      }
      if (removed.length) {
        await db
          .update(page)
          .set({
            properties: sql`case when (${current} - ${rowId}::text) = '[]'::jsonb then ${page.properties} - ${key}
              else jsonb_set(${page.properties}, ${path}::text[], ${current} - ${rowId}::text) end`,
          })
          .where(and(inArray(page.id, removed), eq(page.parentId, relation.databaseId)));
      }
      touched.add(relation.databaseId);
    }
  }
  for (const id of touched) notifyRows(id);
}

/**
 * Makes `parentId` the parent of the rows `childIds` (through the parent property `parentKey`) and
 * takes them off the sub-items list (`childrenKey`) of the rows that were their parent.
 */
async function moveSubItems(databaseId: string, parentId: string, childIds: string[], parentKey: string, childrenKey: string) {
  const children = await db
    .select({ id: page.id, properties: page.properties })
    .from(page)
    .where(and(inArray(page.id, childIds), eq(page.parentId, databaseId)));
  if (!children.length) return;
  await db
    .update(page)
    .set({ properties: sql`jsonb_set(${page.properties}, ${`{${parentKey}}`}::text[], jsonb_build_array(${parentId}::text))` })
    .where(inArray(page.id, children.map((c) => c.id)));
  const current = sql`coalesce(${page.properties} -> ${childrenKey}, '[]'::jsonb)`;
  for (const child of children) {
    const old = asIds(child.properties[parentKey]).filter((id) => id !== parentId);
    if (!old.length) continue;
    await db
      .update(page)
      .set({
        properties: sql`case when (${current} - ${child.id}::text) = '[]'::jsonb then ${page.properties} - ${childrenKey}
          else jsonb_set(${page.properties}, ${`{${childrenKey}}`}::text[], ${current} - ${child.id}::text) end`,
      })
      .where(and(inArray(page.id, old), eq(page.parentId, databaseId)));
  }
}

/**
 * A copy of a row, or a row made from a template, has no sub-items: they stay with the row they
 * belong to (listing them would move them to the copy). Drops the copy's list and returns the rest.
 */
export async function dropCopiedSubItems(rowId: string, databaseId: string, properties: Record<string, unknown>) {
  const children = subItemsProperty(await getProperties(databaseId));
  if (!children || !(children.id in properties)) return properties;
  const { [children.id]: _dropped, ...rest } = properties;
  await db
    .update(page)
    .set({ properties: sql`${page.properties} - ${children.id}::text` })
    .where(eq(page.id, rowId));
  return rest;
}

export async function updateRowProperties(userId: string, rowId: string, patch: Record<string, unknown>) {
  const row = await requirePageAccess(userId, rowId, "edit");
  if (!row.parentId) throw withCode(new Error("Page is not a database row"), "notADatabaseRow");
  await requireDatabase(userId, row.parentId, "view");
  const normalized = await normalizeRowProperties(userId, row.parentId, patch, row.properties, { createdBy: row.createdBy });
  await checkLoops(row.parentId, [{ rowId, values: normalized }]);
  const next = { ...row.properties };
  for (const [id, value] of Object.entries(normalized)) {
    if (value === null) delete next[id];
    else next[id] = value;
  }
  await db.update(page).set({ properties: next, updatedBy: userId }).where(eq(page.id, rowId));
  // Templates link one way and assign nobody: their values only seed the rows made from them.
  if (!row.inTemplate) {
    await syncPairedRelations(rowId, row.parentId, row.properties, next);
    await afterRowWrites(userId, row.parentId, [{ rowId, before: row.properties, after: next }]);
  }
  notifyRows(row.parentId);
  rowChanged({ rowId, databaseId: row.parentId, userId });
  return next;
}

/** Bulk row actions take at most this many rows per call. */
export const MAX_BULK_ROWS = 1000;

/** Guards a bulk call's size and drops repeated ids, keeping the given order. */
export function bulkRowIds(rowIds: string[]) {
  const unique = [...new Set(rowIds)];
  if (unique.length > MAX_BULK_ROWS) {
    throw new PropertyValueError(`At most ${MAX_BULK_ROWS} rows can be changed at once`, "tooManyRows", {
      max: String(MAX_BULK_ROWS),
    });
  }
  return unique;
}

/**
 * Which of `rowIds` are rows of the database the user may act on at `needed` level, in one query.
 * Everything else (rows they can't see or may only view, rows in the trash, ids of other pages or
 * of nothing) comes back as `skipped`, without saying why, so the call never reveals what exists.
 */
export async function rowsWithAccess(userId: string, databaseId: string, rowIds: string[], needed: RequiredLevel) {
  const found = rowIds.length
    ? await db
        .select({
          id: page.id,
          properties: page.properties,
          createdBy: page.createdBy,
          archivedAt: page.archivedAt,
          inTemplate: page.inTemplate,
          level: accessRank(userId, sql`${page.id}`),
        })
        .from(page)
        // Row templates aren't rows: views never show them, so bulk actions skip them.
        .where(and(inArray(page.id, rowIds), eq(page.parentId, databaseId), eq(page.isTemplate, false)))
    : [];
  const allowed = new Map(
    found.filter((r) => !r.archivedAt && hasLevel(levelFromRank(r.level), needed)).map((r) => [r.id, r] as const),
  );
  return {
    rows: rowIds.flatMap((id) => (allowed.has(id) ? [allowed.get(id)!] : [])),
    skipped: rowIds.filter((id) => !allowed.has(id)),
  };
}

/** What a bulk row action did: the rows it changed and the ones it left alone (see rowsWithAccess). */
export type BulkResult = { done: string[]; skipped: string[] };

/**
 * Sets the same property values on several rows of a database ("edit property" on a selection).
 * Values are checked once, before anything is written, so a bad value changes nothing. Access is
 * checked per row: rows the user may edit are updated in one statement, the rest are skipped and
 * returned so the caller can say so (nothing is skipped silently). Links to rows the user can't
 * see can't be set in bulk. Other properties of the rows are left as they are.
 */
export async function updateRowsProperties(
  userId: string,
  databaseId: string,
  rowIds: string[],
  patch: Record<string, unknown>,
): Promise<BulkResult> {
  const ids = bulkRowIds(rowIds);
  await requireDatabase(userId, databaseId, "view");
  const normalized = await normalizeRowProperties(userId, databaseId, patch, {}, { check: false });
  const found = await rowsWithAccess(userId, databaseId, ids, "edit");
  // Rows where property access keeps the user from these values are skipped like rows they can't edit.
  const access = await propertyAccessFor(userId, databaseId);
  const rows = found.rows.filter((row) => {
    try {
      access.requireValues(row, Object.keys(normalized));
      return true;
    } catch {
      return false;
    }
  });
  const kept = new Set(rows.map((r) => r.id));
  const skipped = [...found.skipped, ...found.rows.filter((r) => !kept.has(r.id)).map((r) => r.id)];
  if (!rows.length || !Object.keys(normalized).length) return { done: [], skipped };
  await checkLoops(databaseId, rows.map((row) => ({ rowId: row.id, values: normalized })));

  const set = Object.fromEntries(Object.entries(normalized).filter(([, v]) => v !== null));
  const cleared = Object.keys(normalized).filter((k) => normalized[k] === null);
  // Merged in SQL, so a concurrent edit of another property of the same row isn't overwritten.
  const minus = cleared.length
    ? sql` - ARRAY[${sql.join(
        cleared.map((k) => sql`${k}::text`),
        sql`, `,
      )}]::text[]`
    : sql``;
  await db.execute(sql`
    update ${page} set
      properties = (properties || ${JSON.stringify(set)}::jsonb)${minus},
      updated_by = ${userId},
      updated_at = now()
    where ${inArray(page.id, rows.map((r) => r.id))}
  `);

  // Rows of a database kept as a template link one way and assign nobody (see updateRowProperties).
  const changes = rows
    .filter((row) => !row.inTemplate)
    .map((row) => {
      const after: Record<string, unknown> = { ...row.properties, ...set };
      for (const k of cleared) delete after[k];
      return { rowId: row.id, before: row.properties, after };
    });
  await syncPairedRelationsMany(databaseId, changes);
  await afterRowWrites(userId, databaseId, changes);
  notifyRows(databaseId);
  for (const row of rows) rowChanged({ rowId: row.id, databaseId, userId });
  return { done: rows.map((r) => r.id), skipped };
}

/**
 * Tells the people these row writes newly assign: an inbox notification right away and an email
 * after a short delay (see server/notifications and server/assignments).
 */
export async function announceAssignments(
  /** Null for anonymous form answers: nobody to name, and nobody left out as the one who did it. */
  actorId: string | null,
  databaseId: string,
  changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[],
) {
  const personProps = (await getProperties(databaseId)).filter((p) => p.type === "person");
  if (!personProps.length) return;
  const [database] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, databaseId));
  const seen = await assignmentsTheySee(databaseId, personProps.map((p) => p.id), changes);
  if (database) await recordAssignments(actorId, database.workspaceId, personProps, seen);
  await scheduleAssignmentEmails(actorId, personProps, seen);
}

/**
 * What every saved row write sets off: assignment notices, the database's automations
 * (server/automations/queue) and moving the rows waiting for rows whose dates moved. `created` for
 * new rows, whose `before` is empty; `shifted` for the moves themselves, which don't move more.
 */
export async function afterRowWrites(
  actorId: string | null,
  databaseId: string,
  changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[],
  { created = false, shifted = false }: { created?: boolean; shifted?: boolean } = {},
) {
  await announceAssignments(actorId, databaseId, changes);
  await queueAutomations(actorId, databaseId, changes, created);
  if (!shifted && actorId) await shiftWaitingRows(actorId, databaseId, changes);
}

/**
 * Moves the rows waiting for rows these writes moved (or newly linked) by the database's rule (see
 * lib/dependencies `planShifts`). The rows the writes dated themselves keep their dates. Moves are
 * made as the one who wrote: rows they can't edit, or whose dates they may not change, stay where
 * they are (their link then shows the conflict). Each move is a row write of its own, so
 * automations see it.
 */
async function shiftWaitingRows(
  actorId: string,
  databaseId: string,
  changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[],
) {
  const properties = await getProperties(databaseId);
  const by = blockedByProperty(properties);
  if (!by) return;
  const settings = dependencySettings(by, properties);
  const { start, end } = settings;
  if (settings.shift === "none" || !start) return;
  const blocking = blockingProperty(properties);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const gained = (before: unknown, after: unknown) => asIds(after).filter((id) => !asIds(before).includes(id));
  const moved = new Map<string, Span | null>();
  const linked = new Set<string>();
  for (const { rowId, before, after } of changes) {
    if (!same(before[start], after[start]) || (end && !same(before[end], after[end]))) {
      moved.set(rowId, rowSpan(before[start], end ? before[end] : null));
    }
    if (gained(before[by.id], after[by.id]).length) linked.add(rowId);
    if (blocking) for (const id of gained(before[blocking.id], after[blocking.id])) linked.add(id);
  }
  if (!moved.size && !linked.size) return;

  const rows = await db
    .select({ id: page.id, properties: page.properties })
    .from(page)
    .where(
      and(eq(page.parentId, databaseId), isNull(page.archivedAt), eq(page.isTemplate, false), eq(page.inTemplate, false)),
    );
  const plan = planShifts({
    rows: rows.map((r) => ({
      id: r.id,
      span: rowSpan(r.properties[start], end ? r.properties[end] : null),
      blockedBy: storedBlockers(r, by.id),
    })),
    moved,
    linked,
    fixed: new Set(moved.keys()),
    shift: settings.shift,
    skipWeekends: settings.skipWeekends,
  });
  if (!plan.length) return;

  const found = await rowsWithAccess(actorId, databaseId, plan.map((s) => s.id), "edit");
  const access = await propertyAccessFor(actorId, databaseId);
  const shifts: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[] = [];
  for (const row of found.rows) {
    const s = plan.find((p) => p.id === row.id)!;
    const values: Record<string, string> = { [start]: dayValue(s.after.start) };
    // A one-day row without an end keeps having none.
    if (end && row.properties[end] != null) values[end] = dayValue(s.after.end);
    try {
      access.requireValues(row, Object.keys(values));
    } catch {
      continue;
    }
    // Merged in SQL, so a concurrent edit of another property of the row isn't overwritten.
    await db.execute(sql`
      update ${page} set properties = properties || ${JSON.stringify(values)}::jsonb, updated_by = ${actorId}, updated_at = now()
      where ${page.id} = ${row.id}
    `);
    shifts.push({ rowId: row.id, before: row.properties, after: { ...row.properties, ...values } });
  }
  if (!shifts.length) return;
  notifyRows(databaseId);
  for (const { rowId } of shifts) rowChanged({ rowId, databaseId, userId: actorId });
  await afterRowWrites(actorId, databaseId, shifts, { shifted: true });
}

export type NewRow = { title: string; properties?: Record<string, unknown> };

/**
 * Adds several rows to a database at once, in the given order after the existing rows. Every
 * row's values are checked before anything is written and the rows go in with one insert, so a
 * bad value leaves the database unchanged and a retried import doesn't leave duplicates behind.
 */
export async function createRows(userId: string, databaseId: string, rows: NewRow[]) {
  const database = await requireDatabase(userId, databaseId, "edit");
  if (database.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
  if (!rows.length) return [];

  const values: Record<string, unknown>[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      values.push(await normalizeRowProperties(userId, databaseId, row.properties ?? {}));
    } catch (error) {
      if (error instanceof PropertyValueError) error.message = `Row ${i + 1} ("${row.title.trim()}"): ${error.message}`;
      throw error;
    }
  }
  return insertRows(database, userId, rows.map((row, i) => ({ title: row.title, properties: values[i] })));
}

/**
 * Writes rows whose values are already checked (see normalizeRowProperties) at the end of a
 * database, then does what every new row needs: two-way relations, assignment notices and live
 * updates. `actorId` becomes the rows' creator; null (an anonymous form answer) leaves it empty.
 */
export async function insertRows(
  database: { id: string; workspaceId: string },
  actorId: string | null,
  rows: { title: string; properties: Record<string, unknown> }[],
) {
  const databaseId = database.id;
  const [{ max }] = await db
    .select({ max: sql<number | null>`max(${page.position})` })
    .from(page)
    .where(eq(page.parentId, databaseId));
  const start = (Number(max) || 0) + 1;
  const created = rows.map((row, i) => ({
    id: crypto.randomUUID(),
    workspaceId: database.workspaceId,
    parentId: databaseId,
    kind: "page" as const,
    title: row.title.trim(),
    properties: row.properties,
    position: start + i,
    createdBy: actorId,
    updatedBy: actorId,
  }));
  await db.insert(page).values(created);

  for (const row of created) await syncPairedRelations(row.id, databaseId, {}, row.properties);
  await afterRowWrites(
    actorId,
    databaseId,
    created.map((row) => ({ rowId: row.id, before: {}, after: row.properties })),
    { created: true },
  );
  notifyTree(database.workspaceId);
  notifyRows(databaseId);
  return created.map(({ id, title }) => ({ id, title }));
}

export type RelationInput = {
  /** The database whose rows this property links to (same workspace; may be this database). */
  databaseId: string;
  /** Also add a property on the related database that shows the links back. */
  twoWay?: boolean;
  /** Name of that paired property; defaults to this database's title. */
  pairedName?: string;
};

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Take the transaction when called inside one: the outer pool can't see its uncommitted inserts.
async function nextPropertyPosition(databaseId: string, exec: Executor = db) {
  const [{ max }] = await exec
    .select({ max: sql<number | null>`max(${databaseProperty.position})` })
    .from(databaseProperty)
    .where(eq(databaseProperty.databaseId, databaseId));
  return (Number(max) || 0) + 1;
}

/** `name`, or `name 2`, `name 3`… so it doesn't clash with a property of the database. */
async function uniquePropertyName(databaseId: string, name: string, exec: Executor = db) {
  const names = await exec
    .select({ name: databaseProperty.name })
    .from(databaseProperty)
    .where(eq(databaseProperty.databaseId, databaseId));
  const taken = new Set(names.map((p) => p.name.trim().toLowerCase()));
  taken.add("title");
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${name} ${i}`;
  return candidate;
}

/**
 * Calendar entries show only the properties the user picked (a new calendar view hides every
 * property), so a property added later starts hidden there too.
 */
async function hideInCalendars(exec: Executor, databaseId: string, propertyId: string) {
  // Explicit casts: inside set() drizzle would send the parameters as jsonb, like the column.
  const hidden = sql`coalesce(${databaseView.config} -> 'hidden', '[]'::jsonb)`;
  await exec
    .update(databaseView)
    .set({ config: sql`jsonb_set(${databaseView.config}, '{hidden}', ${hidden} || to_jsonb(${propertyId}::text))` })
    .where(and(eq(databaseView.databaseId, databaseId), eq(databaseView.type, "calendar")));
}

/**
 * A formula as stored: names in `prop("…")` replaced by property ids, checked against the
 * database's properties (`self` is the formula property itself, new or edited). A formula that
 * can't run (a syntax or type error, an unknown property, a cycle) is refused with the reason.
 */
function formulaConfig(expression: string, properties: DatabaseProperty[], self: { id: string; name: string }): FormulaConfig {
  const others = properties.filter((p) => p.id !== self.id);
  const stored = formulaForStorage(expression.trim(), [...others, self]);
  const props = [...others, { ...self, type: "formula" as const, options: { formula: { expression: stored } } }];
  const error = compileFormulas(props).get(self.id)?.error;
  if (error) {
    throw new PropertyValueError(`Invalid formula for "${self.name}": ${error.message}`, "invalidFormula", {
      property: self.name,
      message: error.message,
    });
  }
  return { expression: stored };
}

/** A rollup's settings as given: property ids (or "title" for the related rows' titles). */
export type RollupInput = {
  relationPropertyId: string;
  targetPropertyId: string;
  function: string;
  display?: string;
};

/**
 * A rollup as stored, checked against the database's properties (`self` is the rollup itself):
 * the relation must be one of them, the target a property of the related database (which the
 * user must see) or its titles, and the function one a column of the target offers.
 */
async function rollupConfig(
  userId: string,
  input: Partial<RollupInput> | undefined,
  properties: DatabaseProperty[],
  self: { id: string; name: string },
): Promise<RollupConfig> {
  const invalid = (message: string) =>
    new PropertyValueError(`Invalid rollup for "${self.name}": ${message}`, "invalidRollup", { property: self.name, message });
  const relation = properties.find((p) => p.id === input?.relationPropertyId && p.type === "relation");
  const databaseId = relation?.options.relation?.databaseId;
  if (!input || !databaseId) throw invalid("choose one of the database's relation properties");
  const visible = await requireDatabase(userId, databaseId, "view").then(
    (d) => !d.archivedAt,
    () => false,
  );
  if (!visible) throw invalid("the related database can't be read");
  // Only properties the user may know of there (see server/property-access).
  const [loaded, access] = await Promise.all([loadProperties([databaseId]), propertyAccessFor(userId, databaseId)]);
  const targetProps = access.visible(loaded.get(databaseId) ?? []);
  const target =
    input.targetPropertyId === TITLE_FIELD ? TITLE_FIELD : targetProps.find((p) => p.id === input.targetPropertyId);
  if (!target) throw invalid("choose a property of the related database");
  if (target !== TITLE_FIELD && target.id === self.id) throw invalid("a rollup can't roll up itself");
  const fn = input.function;
  if (!isRollupFn(fn)) throw invalid(`unknown function "${String(fn)}"`);
  if (fn !== "show_original" && !isApplicable(fn, target === TITLE_FIELD ? TITLE_FIELD : valueType(target))) {
    throw invalid(`"${fn}" doesn't apply to ${target === TITLE_FIELD ? "titles" : `"${target.name}"`}`);
  }
  if (input.display !== undefined && !ROLLUP_DISPLAYS.includes(input.display as RollupDisplay)) {
    throw invalid(`unknown display "${input.display}"`);
  }
  const display = input.display as RollupDisplay | undefined;
  return {
    relationPropertyId: relation!.id,
    targetPropertyId: target === TITLE_FIELD ? TITLE_FIELD : target.id,
    function: fn,
    ...(display && display !== "number" ? { display } : {}),
  };
}

/**
 * The database a relation (a new one, or a property turned into one) points to, checked: in the
 * same workspace, not in the trash, and editable when the relation is two-way.
 */
async function relationTarget(
  userId: string,
  database: Awaited<ReturnType<typeof requireDatabase>>,
  relation: RelationInput | undefined,
) {
  const invalidTarget = () =>
    new PropertyValueError("A relation must point to a database in the same workspace", "invalidRelationTarget");
  if (!relation?.databaseId) throw invalidTarget();
  const target =
    relation.databaseId === database.id ? database : await requireDatabase(userId, relation.databaseId, "view").catch(() => null);
  if (!target || target.workspaceId !== database.workspaceId || target.archivedAt) throw invalidTarget();
  // A two-way relation also adds a property to the target, so it needs edit access there.
  if (relation.twoWay && target.id !== database.id) {
    const editable = await requireDatabase(userId, target.id, "edit").then(
      () => true,
      () => false,
    );
    if (!editable) {
      throw new PropertyValueError("Two-way relations need edit access to the related database", "relationTargetReadOnly");
    }
  }
  return target;
}

/** A number format given for a property of `type`, checked (see lib/number-format); null for plain numbers. */
function numberFormat(type: PropertyType, input: unknown): NumberFormat | null {
  if (input !== null && type !== "number") {
    throw new PropertyValueError(`Only number properties have a number format`, "invalidNumberFormat");
  }
  const checked = checkNumberFormat(input);
  if (!checked.ok) throw new PropertyValueError(checked.message, "invalidNumberFormat");
  return checked.format;
}

/** Date options given for a property of `type`, checked against its current ones (see lib/date-options). */
function dateOptions(type: PropertyType, input: DateOptionsInput, current: DateOptions | undefined): DateOptions | null {
  if (type !== "date") throw new PropertyValueError(`Only date properties have date options`, "invalidDateOptions");
  const checked = checkDateOptions(input, current, new Date());
  if (!checked.ok) throw new PropertyValueError(checked.message, "invalidDateOptions");
  return checked.options;
}

export async function addProperty(
  userId: string,
  databaseId: string,
  input: {
    name: string;
    type: PropertyType;
    options?: OptionInput[];
    relation?: RelationInput;
    /** Formulas: the expression, with property names or ids in `prop("…")`. */
    formula?: { expression: string };
    /** Rollups: what to calculate over which relation. */
    rollup?: RollupInput;
    /** Numbers: how values show (see lib/number-format). */
    number?: NumberFormat | null;
    /** Dates: relative display and a reminder (see lib/date-options). */
    date?: DateOptionsInput;
  },
) {
  const database = await requireDatabase(userId, databaseId, "edit");
  assertUnlocked(database);
  if (!PROPERTY_TYPES.includes(input.type)) {
    throw new PropertyValueError(`Unsupported type "${input.type}"`, "unsupportedType", { type: String(input.type) });
  }
  const name = input.name.trim() || "Property";
  const formula =
    input.type === "formula"
      ? formulaConfig(input.formula?.expression ?? "", await knownProperties(userId, databaseId), { id: "\u0000new", name })
      : undefined;
  const rollup =
    input.type === "rollup"
      ? await rollupConfig(userId, input.rollup, await knownProperties(userId, databaseId), { id: "\u0000new", name })
      : undefined;
  const target = input.type === "relation" ? await relationTarget(userId, database, input.relation) : null;
  const number = input.number !== undefined ? numberFormat(input.type, input.number) : null;
  const date = input.date !== undefined ? dateOptions(input.type, input.date, undefined) : null;
  const options: PropertyOptions =
    number
      ? { number }
      : date
      ? { date }
      : input.type === "select" || input.type === "multi_select"
      ? { options: (input.options ?? []).map((o, i) => makeOption(typeof o === "string" ? o : o.name, i)) }
      : input.type === "status"
        ? { options: makeStatusOptions(input.options) }
        : target
          ? { relation: { databaseId: target.id } }
          : formula
            ? { formula }
            : rollup
              ? { rollup }
              : {};
  const created = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(databaseProperty)
      .values({
        databaseId,
        name,
        type: input.type,
        options,
        position: await nextPropertyPosition(databaseId, tx),
      })
      .returning();
    await hideInCalendars(tx, databaseId, created.id);
    if (!target || !input.relation?.twoWay) return created;
    const pairedName = await uniquePropertyName(
      target.id,
      input.relation.pairedName?.trim() || database.title.trim() || "Related",
      tx,
    );
    const [paired] = await tx
      .insert(databaseProperty)
      .values({
        databaseId: target.id,
        name: pairedName,
        type: "relation",
        options: { relation: { databaseId, pairedPropertyId: created.id } },
        position: await nextPropertyPosition(target.id, tx),
      })
      .returning();
    await hideInCalendars(tx, target.id, paired.id);
    const relation: RelationConfig = { databaseId: target.id, pairedPropertyId: paired.id };
    const [linked] = await tx
      .update(databaseProperty)
      .set({ options: { relation } })
      .where(eq(databaseProperty.id, created.id))
      .returning();
    return linked;
  });
  notifySchema(databaseId);
  if (target && target.id !== databaseId) notifySchema(target.id);
  return created;
}

/**
 * Turns sub-items on or off (see lib/sub-items). On, the given relation of the database with itself
 * holds each row's parent; without one, a two-way relation named `names` is added for it (its
 * other side lists each row's sub-items). Off keeps the properties and their values, as plain
 * relations. Returns the parent property, or null when turned off.
 */
export async function setSubItems(
  userId: string,
  databaseId: string,
  input: { on: false } | { on: true; propertyId?: string; names?: { parent: string; subItems: string } },
) {
  const database = await requireDatabase(userId, databaseId, "edit");
  assertUnlocked(database);
  const properties = await getProperties(databaseId);
  const current = parentProperty(properties);
  const setRole = async (prop: DatabaseProperty, role: RelationConfig["role"]) => {
    const { role: _old, ...relation } = prop.options.relation!;
    await db
      .update(databaseProperty)
      .set({ options: { ...prop.options, relation: role ? { ...relation, role } : relation } })
      .where(eq(databaseProperty.id, prop.id));
  };
  if (!input.on) {
    if (current) await setRole(current, undefined);
    notifySchema(databaseId);
    return null;
  }
  let prop: DatabaseProperty | undefined;
  if (input.propertyId) {
    prop = properties.find((p) => p.id === input.propertyId);
    const dependencies = [blockedByProperty(properties)?.id, blockingProperty(properties)?.id];
    if (
      !prop ||
      prop.type !== "relation" ||
      prop.options.relation?.databaseId !== databaseId ||
      dependencies.includes(prop.id)
    ) {
      throw new PropertyValueError("Sub-items need a relation of this database with itself", "notSubItemsRelation");
    }
    (await propertyAccessFor(userId, databaseId)).requireSchema(prop.id);
  } else if (current) {
    return current;
  } else {
    prop = await addProperty(userId, databaseId, {
      name: input.names?.parent.trim() || "Parent item",
      type: "relation",
      relation: { databaseId, twoWay: true, pairedName: input.names?.subItems.trim() || "Sub-items" },
    });
  }
  if (current && current.id !== prop.id) await setRole(current, undefined);
  await setRole(prop, "parent");
  notifySchema(databaseId);
  return { ...prop, options: { ...prop.options, relation: { ...prop.options.relation!, role: "parent" as const } } };
}

/**
 * Turns dependencies on or off, or changes their settings. On, a relation of the database with
 * itself holds the rows each row waits for: `propertyId` (one the database has), the one already
 * used, or a new two-way relation (Blocked by / Blocking). Off keeps the properties and their links.
 */
export async function setDependencies(
  userId: string,
  databaseId: string,
  input:
    | { on: false }
    | { on: true; propertyId?: string; names?: { blockedBy: string; blocking: string }; settings?: DependencyInput },
) {
  const database = await requireDatabase(userId, databaseId, "edit");
  assertUnlocked(database);
  const properties = await getProperties(databaseId);
  const current = blockedByProperty(properties);
  const setRelation = async (prop: DatabaseProperty, relation: RelationConfig) => {
    await db
      .update(databaseProperty)
      .set({ options: { ...prop.options, relation } })
      .where(eq(databaseProperty.id, prop.id));
  };
  const plain = (prop: DatabaseProperty) => {
    const { role: _role, dependencies: _dependencies, ...relation } = prop.options.relation!;
    return relation;
  };
  if (!input.on) {
    if (current) await setRelation(current, plain(current));
    notifySchema(databaseId);
    return null;
  }

  const settings: DependencyConfig = { ...(current?.options.relation?.dependencies ?? {}) };
  for (const [key, value] of Object.entries(input.settings ?? {}) as [keyof DependencyInput, unknown][]) {
    if (value === undefined) continue;
    if (key === "shift") {
      if (!DEPENDENCY_SHIFTS.includes(value as DependencyShift)) {
        throw new PropertyValueError(`"${value}" is not a dependency rule`, "invalidDependencySettings");
      }
      settings.shift = value as DependencyShift;
    } else if (key === "skipWeekends") {
      settings.skipWeekends = value === true;
    } else if (value === null) {
      delete settings[key];
    } else if (properties.some((p) => p.id === value && p.type === "date")) {
      settings[key] = value as string;
    } else {
      throw new PropertyValueError("Dependencies move rows by date properties of their database", "invalidDependencySettings");
    }
  }
  // Without dates chosen: those of the first timeline that uses date properties, else the first date property.
  if (!settings.startPropertyId) {
    const isDate = (id: string | undefined) => !!id && properties.some((p) => p.id === id && p.type === "date");
    const timelines = await db
      .select({ config: databaseView.config })
      .from(databaseView)
      .where(and(eq(databaseView.databaseId, databaseId), eq(databaseView.type, "timeline")))
      .orderBy(asc(databaseView.position), asc(databaseView.createdAt));
    const timeline = timelines.find((v) => isDate(v.config.dateBy));
    const start = timeline?.config.dateBy ?? properties.find((p) => p.type === "date")?.id;
    if (start) settings.startPropertyId = start;
    const end = timeline?.config.endDateBy;
    if (timeline && isDate(end) && end !== start) settings.endPropertyId = end;
  }

  let prop: DatabaseProperty;
  if (input.propertyId && input.propertyId !== current?.id) {
    const found = properties.find((p) => p.id === input.propertyId);
    const subItems = [parentProperty(properties)?.id, subItemsProperty(properties)?.id];
    if (
      !found ||
      found.type !== "relation" ||
      found.options.relation?.databaseId !== databaseId ||
      subItems.includes(found.id) ||
      found.id === blockingProperty(properties)?.id
    ) {
      throw new PropertyValueError("Dependencies need a relation of this database with itself", "notDependencyRelation");
    }
    (await propertyAccessFor(userId, databaseId)).requireSchema(found.id);
    prop = found;
  } else if (current) {
    prop = current;
  } else {
    prop = await addProperty(userId, databaseId, {
      name: input.names?.blockedBy.trim() || "Blocked by",
      type: "relation",
      relation: { databaseId, twoWay: true, pairedName: input.names?.blocking.trim() || "Blocking" },
    });
  }
  if (current && current.id !== prop.id) await setRelation(current, plain(current));
  const relation: RelationConfig = { ...plain(prop), role: "blocked_by", dependencies: settings };
  await setRelation(prop, relation);
  notifySchema(databaseId);
  return { ...prop, options: { ...prop.options, relation } };
}

/**
 * An option to create: its name, or for status properties its name and group (options given by
 * name only are spread over the groups, see makeStatusOptions).
 */
export type OptionInput = string | { name: string; group?: StatusGroup };

/**
 * For row writes that follow a schema change (a deleted property or option): the rows weren't
 * edited, so their "last edited" time stays.
 */
const KEEP_EDIT_TIME = { updatedAt: sql<Date>`${page.updatedAt}` };

export function makeOption(name: string, index = 0): SelectOption {
  return { id: crypto.randomUUID(), name: name.trim(), color: SELECT_COLORS[index % SELECT_COLORS.length] };
}

/**
 * A property the user may change. Every caller edits the schema, which a lock forbids, except
 * adding an option while typing a new tag into a cell (`cellEdit`).
 */
async function requireProperty(userId: string, propertyId: string, { cellEdit = false } = {}) {
  const [prop] = await db.select().from(databaseProperty).where(eq(databaseProperty.id, propertyId));
  if (!prop) throw new AccessError();
  const database = await requireDatabase(userId, prop.databaseId, "edit");
  // Property access: changing the property needs "edit"; a new option typed into a cell, its values.
  // One the user can't know of is refused like one that doesn't exist, before anything else is said.
  const access = await propertyAccessFor(userId, prop.databaseId);
  if (!access.visible([prop]).length) throw new AccessError();
  if (!cellEdit) assertUnlocked(database);
  if (cellEdit) access.requireValues(null, [prop.id]);
  else access.requireSchema(prop.id);
  return prop;
}

export async function updateProperty(
  userId: string,
  propertyId: string,
  patch: {
    name?: string;
    options?: SelectOption[];
    position?: number;
    formula?: { expression: string };
    /** Rollups: settings to change; the others stay. */
    rollup?: Partial<RollupInput>;
    /** Numbers: how values show; null for plain numbers. */
    number?: NumberFormat | null;
    /** Dates: the display and reminder to change; what is left out stays. */
    date?: DateOptionsInput;
  },
) {
  const prop = await requireProperty(userId, propertyId);
  const number = patch.number !== undefined ? numberFormat(prop.type, patch.number) : undefined;
  const { number: _number, ...rest } = prop.options;
  const date = patch.date !== undefined ? dateOptions(prop.type, patch.date, prop.options.date) : undefined;
  const { date: _date, ...withoutDate } = prop.options;
  const formula =
    patch.formula && prop.type === "formula"
      ? formulaConfig(patch.formula.expression, await knownProperties(userId, prop.databaseId), {
          id: prop.id,
          name: patch.name?.trim() || prop.name,
        })
      : undefined;
  const rollup =
    patch.rollup && prop.type === "rollup"
      ? await rollupConfig(userId, { ...prop.options.rollup, ...patch.rollup }, await knownProperties(userId, prop.databaseId), {
          id: prop.id,
          name: patch.name?.trim() || prop.name,
        })
      : undefined;
  // Status options are kept in group order with a valid group each.
  if (patch.options && prop.type === "status") patch = { ...patch, options: sortStatusOptions(patch.options) };
  // Rows must not keep ids of deleted options: they'd show as empty yet fail validation on the next edit.
  const removed = patch.options
    ? (prop.options.options ?? []).filter((o) => !patch.options!.some((n) => n.id === o.id)).map((o) => o.id)
    : [];
  await db.transaction(async (tx) => {
    await tx
      .update(databaseProperty)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() || prop.name } : {}),
        ...(patch.options !== undefined ? { options: { ...prop.options, options: patch.options } } : {}),
        ...(formula ? { options: { ...prop.options, formula } } : {}),
        ...(rollup ? { options: { ...prop.options, rollup } } : {}),
        ...(number !== undefined ? { options: number ? { ...rest, number } : rest } : {}),
        ...(date !== undefined ? { options: date ? { ...withoutDate, date } : withoutDate } : {}),
        ...(patch.position !== undefined ? { position: patch.position } : {}),
      })
      .where(eq(databaseProperty.id, propertyId));
    if (!removed.length) return;
    const ids = sql`${sql.raw("ARRAY[")}${sql.join(
      removed.map((id) => sql`${id}::text`),
      sql`, `,
    )}${sql.raw("]::text[]")}`;
    // Explicit casts: inside set() drizzle would send the parameters as jsonb, like the column.
    const current = sql`(${page.properties} -> ${propertyId}::text)`;
    if (prop.type === "select" || prop.type === "status") {
      await tx
        .update(page)
        .set({ properties: sql`${page.properties} - ${propertyId}::text`, ...KEEP_EDIT_TIME })
        .where(and(eq(page.parentId, prop.databaseId), sql`${page.properties} ->> ${propertyId}::text = any(${ids})`));
    } else if (prop.type === "multi_select") {
      await tx
        .update(page)
        .set({
          properties: sql`case when (${current} - ${ids}) = '[]'::jsonb then ${page.properties} - ${propertyId}::text
            else jsonb_set(${page.properties}, ${`{${propertyId}}`}::text[], ${current} - ${ids}) end`,
          ...KEEP_EDIT_TIME,
        })
        .where(and(eq(page.parentId, prop.databaseId), sql`${current} ?| ${ids}`));
    }
  });
  notifySchema(prop.databaseId);
  if (removed.length) notifyRows(prop.databaseId);
  // Date options as stored (a reminder's zone and start are decided here): undefined when unchanged.
  return { date };
}

/** Adds a select option by name if missing and returns it (used when typing a new tag). */
export async function ensureOption(userId: string, propertyId: string, name: string) {
  const prop = await requireProperty(userId, propertyId, { cellEdit: true });
  if (!holdsOptions(prop.type)) {
    throw withCode(new Error("Not a select property"), "notASelectProperty");
  }
  const options = prop.options.options ?? [];
  const existing = options.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
  if (existing) return existing;
  // A status option added by name (a new board column) starts out as to do.
  const option: SelectOption =
    prop.type === "status"
      ? { ...makeOption(name), color: statusColor("todo"), group: "todo" }
      : makeOption(name, options.length);
  const next = [...options, option];
  await db
    .update(databaseProperty)
    .set({ options: { ...prop.options, options: prop.type === "status" ? sortStatusOptions(next) : next } })
    .where(eq(databaseProperty.id, propertyId));
  notifySchema(prop.databaseId);
  return option;
}

export async function deleteProperty(userId: string, propertyId: string) {
  const prop = await requireProperty(userId, propertyId);
  const pairedId = prop.type === "relation" ? prop.options.relation?.pairedPropertyId : null;
  const [paired] = pairedId ? await db.select().from(databaseProperty).where(eq(databaseProperty.id, pairedId)) : [];
  await db.transaction(async (tx) => {
    await tx.delete(databaseProperty).where(eq(databaseProperty.id, propertyId));
    // The other side of a two-way relation stays, as a one-way relation with its values intact.
    if (paired?.options.relation) {
      await tx
        .update(databaseProperty)
        .set({ options: { ...paired.options, relation: { ...paired.options.relation, pairedPropertyId: null } } })
        .where(eq(databaseProperty.id, paired.id));
    }
    await tx
      .update(page)
      .set({ properties: sql`${page.properties} - ${propertyId}`, ...KEEP_EDIT_TIME })
      .where(eq(page.parentId, prop.databaseId));
    // Drop references from view configs.
    const views = await tx.select().from(databaseView).where(eq(databaseView.databaseId, prop.databaseId));
    for (const view of views) {
      await tx
        .update(databaseView)
        .set({ config: dropPropertyReferences(view.config, (id) => id === propertyId) })
        .where(eq(databaseView.id, view.id));
    }
  });
  notifySchema(prop.databaseId);
  if (paired && paired.databaseId !== prop.databaseId) notifySchema(paired.databaseId);
}

/**
 * A copy of a property right after it, named `name` (made unique): its settings, its value in every
 * row (rows keep their "last edited" time) and who may see and change it, so a copy never shows
 * values the original keeps from someone. A two-way relation is copied one way: the related
 * database gets no second property.
 */
export async function duplicateProperty(userId: string, propertyId: string, name: string) {
  const prop = await requireProperty(userId, propertyId);
  const [next] = await db
    .select({ position: databaseProperty.position })
    .from(databaseProperty)
    .where(and(eq(databaseProperty.databaseId, prop.databaseId), sql`${databaseProperty.position} > ${prop.position}`))
    .orderBy(asc(databaseProperty.position))
    .limit(1);
  const options: PropertyOptions = structuredClone(prop.options);
  // The copy links one way and stands for nothing: sub-items keep their one parent property.
  if (options.relation) options.relation = { databaseId: options.relation.databaseId, pairedPropertyId: null };
  const copied = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(databaseProperty)
      .values({
        databaseId: prop.databaseId,
        name: await uniquePropertyName(prop.databaseId, name.trim() || prop.name, tx),
        type: prop.type,
        options,
        position: positionBetween(prop.position, next?.position),
      })
      .returning();
    await hideInCalendars(tx, prop.databaseId, created.id);
    const rows = await tx
      .update(page)
      .set({
        properties: sql`jsonb_set(${page.properties}, ${`{${created.id}}`}::text[], ${page.properties} -> ${propertyId}::text)`,
        ...KEEP_EDIT_TIME,
      })
      .where(and(eq(page.parentId, prop.databaseId), sql`${page.properties} ? ${propertyId}::text`))
      .returning({ id: page.id });
    const rules = await tx.select().from(propertyPermission).where(eq(propertyPermission.propertyId, propertyId));
    if (rules.length) {
      await tx.insert(propertyPermission).values(
        // A rule naming the people of the property itself names those of the copy.
        rules.map(({ id: _id, createdAt: _createdAt, ...rule }) => ({
          ...rule,
          propertyId: created.id,
          personPropertyId: rule.personPropertyId === propertyId ? created.id : rule.personPropertyId,
        })),
      );
    }
    return { created, rows: rows.length };
  });
  notifySchema(prop.databaseId);
  if (copied.rows) notifyRows(prop.databaseId);
  return copied.created;
}

export type TypeChange = {
  type: PropertyType;
  /** Settings the new type needs: a relation's database, a formula's expression, a rollup's settings. */
  relation?: RelationInput;
  formula?: { expression: string };
  rollup?: RollupInput;
  /** A ticked checkbox as text, in the user's language (see lib/convert-property). */
  yes: string;
};

/**
 * Changes a property's type and converts its value in every row, the trashed ones and row
 * templates included (rows keep their "last edited" time; see lib/convert-property for what each
 * value becomes). Formulas and rollups freeze what the user sees of them: rows hidden from them
 * keep no value. Views drop what they had set up for the old type. A two-way relation leaves its
 * other side one-way; a new two-way relation links back. Restricted properties can't become a type
 * access rules don't apply to, nor can a person property other rules name people by.
 *
 * Returns the property and, of the rows the user sees, how many hold a value of the new type
 * (`converted`) and how many lose theirs (`cleared`). `dryRun` checks and counts without changing
 * anything.
 */
export async function changePropertyType(
  userId: string,
  propertyId: string,
  input: TypeChange,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<{ property: DatabaseProperty; converted: number; cleared: number }> {
  const prop = await requireProperty(userId, propertyId);
  if (!PROPERTY_TYPES.includes(input.type)) {
    throw new PropertyValueError(`Unsupported type "${input.type}"`, "unsupportedType", { type: String(input.type) });
  }
  if (input.type === prop.type) return { property: prop, converted: 0, cleared: 0 };
  const database = await requireDatabase(userId, prop.databaseId, "edit");
  const rules = await db
    .select({ propertyId: propertyPermission.propertyId, personPropertyId: propertyPermission.personPropertyId })
    .from(propertyPermission)
    .where(eq(propertyPermission.databaseId, prop.databaseId));
  if (!canRestrict(input.type) && rules.some((r) => r.propertyId === propertyId)) {
    throw new PropertyValueError(`"${prop.name}" has access rules, which a ${input.type} property can't have`, "typeChangeRestricted", {
      property: prop.name,
    });
  }
  if (!namesPeople(input.type) && rules.some((r) => r.personPropertyId === propertyId)) {
    throw new PropertyValueError(`Access rules give the people of "${prop.name}" access`, "typeChangeNamesPeople", {
      property: prop.name,
    });
  }

  const known = await knownProperties(userId, prop.databaseId);
  const self = { id: prop.id, name: prop.name };
  const formula = input.type === "formula" ? formulaConfig(input.formula?.expression ?? "", known, self) : undefined;
  const rollup = input.type === "rollup" ? await rollupConfig(userId, input.rollup, known, self) : undefined;
  const target = input.type === "relation" ? await relationTarget(userId, database, input.relation) : null;

  // What the values are now: stored, filled in by Leafdesk, or (formulas, rollups) worked out.
  const rows = await db
    .select({
      id: page.id,
      title: page.title,
      properties: page.properties,
      createdBy: page.createdBy,
      updatedBy: page.updatedBy,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    })
    .from(page)
    .where(eq(page.parentId, prop.databaseId))
    // In the table's order, so options made from the values come in the order they appear.
    .orderBy(asc(page.position), asc(page.createdAt));
  const visible = new Set(
    (await db.select({ id: page.id }).from(page).where(and(eq(page.parentId, prop.databaseId), pageVisibleTo(userId)))).map((r) => r.id),
  );
  let derived = new Map<string, unknown>();
  if (isDerived(prop.type)) {
    const read = await withValues(userId, prop.databaseId, rows.filter((r) => visible.has(r.id)), await getProperties(prop.databaseId));
    derived = new Map(read.map((r) => [r.id, r.properties[propertyId]]));
  }
  const current = (row: (typeof rows)[number]) =>
    isComputed(prop.type)
      ? computedValues([prop], row)[propertyId]
      : isDerived(prop.type)
        ? (derived.get(row.id) ?? null)
        : row.properties[propertyId];
  const values = rows.map(current);

  // People and related rows, as far as the user may see them.
  const members = await workspacePeopleOf(prop.databaseId);
  const actor = members.find((m) => m.id === userId);
  const people: ConversionContext["people"] = [
    ...(holdsPeople(prop.type) ? await getPeople(userId, [prop]) : []),
    // Only members look people up, as when they type a name into a cell.
    ...(input.type === "person" && actor && !isGuest(actor.role) ? members : []),
  ];
  const sourceTitles =
    prop.type === "relation"
      ? new Map(((await getRelationTargets(userId, [prop]))[propertyId]?.rows ?? []).map((r) => [r.id, r.title]))
      : undefined;
  const targetRows = target
    ? await db
        .select({ id: page.id, title: page.title })
        .from(page)
        .where(and(eq(page.parentId, target.id), eq(page.isTemplate, false), isNull(page.archivedAt), pageVisibleTo(userId)))
    : undefined;
  const conversion = planConversion(prop, { type: input.type }, values, { people, sourceTitles, targetRows, yes: input.yes });

  const options: PropertyOptions = conversion.options
    ? { options: conversion.options }
    : target
      ? { relation: { databaseId: target.id } }
      : formula
      ? { formula }
      : rollup
        ? { rollup }
        : {};
  // New values by row id; null removes one. Unticked boxes and types Leafdesk works out store none.
  const next: Record<string, unknown> = {};
  rows.forEach((row, i) => {
    const value = isReadOnlyType(input.type) ? null : conversion.convert(values[i]);
    const stored = value === false ? null : value;
    if (stored !== null || propertyId in row.properties) next[row.id] = stored;
  });
  // Counted on the rows the user sees: the others aren't theirs to know about.
  const seen = values.filter((_, i) => visible.has(rows[i].id));
  const cleared = lostValues(seen, conversion);
  const converted = isReadOnlyType(input.type) ? 0 : seen.filter((v) => !isEmptyValue(conversion.convert(v))).length;
  if (dryRun) return { property: { ...prop, type: input.type, options }, converted, cleared };

  const pairedId = prop.type === "relation" ? prop.options.relation?.pairedPropertyId : null;
  const [paired] = pairedId ? await db.select().from(databaseProperty).where(eq(databaseProperty.id, pairedId)) : [];
  const changed = await db.transaction(async (tx) => {
    let relation: RelationConfig | undefined = target ? { databaseId: target.id } : undefined;
    // The other side of a two-way relation stays, as a one-way relation with its values intact.
    if (paired?.options.relation) {
      await tx
        .update(databaseProperty)
        .set({ options: { ...paired.options, relation: { ...paired.options.relation, pairedPropertyId: null } } })
        .where(eq(databaseProperty.id, paired.id));
    }
    if (target && input.relation?.twoWay) {
      const [created] = await tx
        .insert(databaseProperty)
        .values({
          databaseId: target.id,
          name: await uniquePropertyName(target.id, input.relation.pairedName?.trim() || database.title.trim() || "Related", tx),
          type: "relation",
          options: { relation: { databaseId: prop.databaseId, pairedPropertyId: propertyId } },
          position: await nextPropertyPosition(target.id, tx),
        })
        .returning();
      await hideInCalendars(tx, target.id, created.id);
      relation = { databaseId: target.id, pairedPropertyId: created.id };
    }
    const [updated] = await tx
      .update(databaseProperty)
      .set({ type: input.type, options: relation ? { relation } : options })
      .where(eq(databaseProperty.id, propertyId))
      .returning();
    if (Object.keys(next).length) {
      await tx.execute(sql`
        update ${page} set
          properties = case when c.value = 'null'::jsonb then ${page.properties} - ${propertyId}::text
            else jsonb_set(${page.properties}, ${`{${propertyId}}`}::text[], c.value) end,
          updated_at = ${page.updatedAt}
        from jsonb_each(${JSON.stringify(next)}::jsonb) as c(key, value)
        where ${page.id} = c.key and ${page.parentId} = ${prop.databaseId}`);
    }
    const views = await tx.select().from(databaseView).where(eq(databaseView.databaseId, prop.databaseId));
    for (const view of views) {
      await tx
        .update(databaseView)
        .set({ config: retypeViewConfig(view.config, propertyId, prop.type, updated) })
        .where(eq(databaseView.id, view.id));
    }
    return updated;
  });
  // A new two-way relation links the rows back.
  if (target && input.relation?.twoWay) {
    await syncPairedRelationsMany(
      prop.databaseId,
      Object.entries(next).flatMap(([rowId, value]) => (value ? [{ rowId, before: {}, after: { [propertyId]: value } }] : [])),
    );
  }
  notifySchema(prop.databaseId);
  notifyRows(prop.databaseId);
  if (paired && paired.databaseId !== prop.databaseId) notifySchema(paired.databaseId);
  if (target && target.id !== prop.databaseId) notifySchema(target.id);
  return { property: changed, converted, cleared };
}

export async function addView(userId: string, databaseId: string, input: { name: string; type: ViewType }) {
  if (!isViewType(input.type)) {
    throw new PropertyValueError(`Unsupported view type "${String(input.type)}"`, "unsupportedViewType", {
      type: String(input.type),
    });
  }
  const database = await requireDatabase(userId, databaseId, "edit");
  assertUnlocked(database);
  // Defaults come from properties the user may know of (see server/property-access).
  const [all, access] = await Promise.all([getProperties(databaseId), propertyAccessFor(userId, databaseId)]);
  const props = access.visible(all);
  const config: ViewConfig = {};
  if (input.type === "board") config.groupBy = props.find((p) => p.type === "select" || p.type === "status")?.id;
  if (input.type === "calendar") {
    config.dateBy = props.find((p) => p.type === "date")?.id;
    // Calendar entries are small: show only titles until the user picks properties to show.
    config.hidden = all.map((p) => p.id);
  }
  // Timelines start without swimlanes and with a week per column; list rows and timeline bars show
  // only titles until the user picks properties (see hiddenByDefault).
  if (input.type === "timeline") config.dateBy = props.find((p) => p.type === "date")?.id;
  // Charts count rows per option of the property a board would group by, in columns.
  if (input.type === "chart") config.groupBy = chartGroupProperty(props, {})?.id;
  // Forms start out asking for the name and every property a form can ask for.
  if (input.type === "form") config.form = defaultFormConfig(props);
  const [{ max }] = await db
    .select({ max: sql<number | null>`max(${databaseView.position})` })
    .from(databaseView)
    .where(eq(databaseView.databaseId, databaseId));
  const [created] = await db
    .insert(databaseView)
    .values({
      databaseId,
      name: input.name.trim() || DEFAULT_VIEW_NAMES[input.type],
      type: input.type,
      config,
      position: (Number(max) || 0) + 1,
    })
    .returning();
  notifySchema(databaseId);
  notifyTree(database.workspaceId);
  return created;
}

/** A view the user may change (every caller edits it). */
async function requireView(userId: string, viewId: string) {
  const [view] = await db.select().from(databaseView).where(eq(databaseView.id, viewId));
  if (!view) throw new AccessError();
  const database = await requireDatabase(userId, view.databaseId, "edit");
  return { ...view, workspaceId: database.workspaceId, lockedAt: database.lockedAt };
}

/** Returns the view's config as stored (a form's defaults normalized to ids). */
export async function updateView(userId: string, viewId: string, patch: { name?: string; config?: ViewConfig }) {
  // Configs come from the client and from MCP; a malformed filter tree would break every viewer.
  const filterError = patch.config && filterConfigError(patch.config);
  if (filterError) throw new PropertyValueError(filterError, "invalidFilter");
  const layoutError = patch.config && layoutConfigError(patch.config);
  if (layoutError) throw new PropertyValueError(layoutError, "invalidViewConfig");
  const view = await requireView(userId, viewId);
  // Filters, sorts and layout stay adjustable on a locked database; renaming doesn't.
  if (patch.name !== undefined) assertUnlocked(view);
  const access = await propertyAccessFor(userId, view.databaseId);
  // A form's default values are stored like row values: checked, with option names, "me" and
  // emails turned into ids, and links the editor can't see kept as they were. Only defaults the
  // editor changes need them to be allowed to change the property's values.
  const defaults = patch.config?.form?.defaults;
  if (patch.config?.form && defaults) {
    const before = view.config.form?.defaults ?? {};
    const normalized = await normalizeRowProperties(userId, view.databaseId, defaults, before, { check: false });
    access.requireValues(
      null,
      Object.keys(normalized).filter((id) => JSON.stringify(normalized[id] ?? null) !== JSON.stringify(before[id] ?? null)),
    );
    const kept = Object.fromEntries(Object.entries(normalized).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length)));
    patch = { ...patch, config: { ...patch.config, form: { ...patch.config.form, defaults: kept } } };
  }
  // What the stored settings say about properties the editor can't know of stays as it was, and
  // so do form defaults they can't see.
  if (patch.config && !access.open) {
    const gone = unknownProperties(access, await getProperties(view.databaseId));
    let config = restoreReferences(view.config, patch.config, gone);
    const hidden = Object.entries(view.config.form?.defaults ?? {}).filter(([id]) => access.valuesHidden().has(id));
    if (hidden.length && config.form) {
      config = { ...config, form: { ...config.form, defaults: { ...config.form.defaults, ...Object.fromEntries(hidden) } } };
    }
    patch = { ...patch, config };
  }
  await db
    .update(databaseView)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() || view.name } : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
    })
    .where(eq(databaseView.id, viewId));
  notifySchema(view.databaseId);
  if (patch.name !== undefined) notifyTree(view.workspaceId);
  return { config: access.viewConfig(patch.config ?? view.config) };
}

export async function deleteView(userId: string, viewId: string) {
  const view = await requireView(userId, viewId);
  assertUnlocked(view);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(databaseView)
    .where(eq(databaseView.databaseId, view.databaseId));
  if (count <= 1) throw withCode(new Error("A database needs at least one view"), "lastView");
  await db.delete(databaseView).where(eq(databaseView.id, viewId));
  notifySchema(view.databaseId);
  notifyTree(view.workspaceId);
}

/**
 * Moves a view's tab before or after another view of the same database. The views are numbered
 * again from the order the server has, so a tab added meanwhile keeps its place and views that
 * share a position (older databases start them all at 0) still move.
 */
export async function moveView(userId: string, viewId: string, targetId: string, side: "before" | "after") {
  const view = await requireView(userId, viewId);
  assertUnlocked(view);
  if (targetId === viewId) return;
  await db.transaction(async (tx) => {
    const views = await tx
      .select({ id: databaseView.id, position: databaseView.position })
      .from(databaseView)
      .where(eq(databaseView.databaseId, view.databaseId))
      .orderBy(asc(databaseView.position), asc(databaseView.createdAt))
      .for("update");
    const order = views.filter((v) => v.id !== viewId);
    const at = order.findIndex((v) => v.id === targetId);
    if (at < 0) throw new AccessError();
    order.splice(side === "before" ? at : at + 1, 0, { id: viewId, position: 0 });
    for (const [i, v] of order.entries()) {
      if (v.position !== i + 1) await tx.update(databaseView).set({ position: i + 1 }).where(eq(databaseView.id, v.id));
    }
  });
  notifySchema(view.databaseId);
  notifyTree(view.workspaceId);
}

/**
 * Reorders a row (board drag) and optionally moves it to another group in one step. `groupValue`
 * is the target group (see groupTarget in lib/grouping): an option, person or related row id,
 * "true" / "false" for checkboxes, a day for dates, null for no value. For list values
 * (multi-select, people, relations) `groupFrom` is the group the card left: `groupValue` takes
 * its place and the rest stays (see moveGroupValue). The result is validated like any edit.
 */
export async function moveRow(
  userId: string,
  rowId: string,
  {
    position,
    groupBy,
    groupValue,
    groupFrom,
  }: { position?: number; groupBy?: string; groupValue?: string | null; groupFrom?: string | null },
) {
  const row = await requirePageAccess(userId, rowId, "edit");
  if (!row.parentId) throw withCode(new Error("Page is not a database row"), "notADatabaseRow");
  await requireDatabase(userId, row.parentId, "view");
  const properties = { ...row.properties };
  let type: PropertyType | undefined;
  if (groupBy) {
    const prop = (await getProperties(row.parentId)).find((p) => p.id === groupBy);
    // Unknown properties and who created or last edited a row (and when) are refused here.
    if (!prop || isComputed(prop.type)) await normalizeRowProperties(userId, row.parentId, { [groupBy]: groupValue });
    if (!prop || !isGroupable(prop.type)) {
      throw new PropertyValueError(`Rows can't be grouped by a ${prop?.type} property`, "unsupportedType", {
        type: String(prop?.type),
      });
    }
    type = prop.type;
    const next = moveGroupValue(prop, properties[groupBy], groupFrom, groupValue);
    const normalized = await normalizeRowProperties(userId, row.parentId, { [groupBy]: next }, row.properties, {
      createdBy: row.createdBy,
    });
    await checkLoops(row.parentId, [{ rowId, values: normalized }]);
    const value = normalized[groupBy];
    if (value === null || value === undefined || (Array.isArray(value) && !value.length)) delete properties[groupBy];
    else properties[groupBy] = value;
  }
  await db
    .update(page)
    .set({ properties, ...(position !== undefined ? { position } : {}), updatedBy: userId })
    .where(eq(page.id, rowId));
  if (type === "relation" && !row.inTemplate) await syncPairedRelations(rowId, row.parentId, row.properties, properties);
  if (type && !row.inTemplate) {
    await afterRowWrites(userId, row.parentId, [{ rowId, before: row.properties, after: properties }]);
  }
  notifyRows(row.parentId);
}

export type DatabaseRowWithPosition = DatabaseRow & {
  position: number;
  /** Gallery cover: the first image in the row's body. Only sent while a gallery view shows covers. */
  cover?: string | null;
};

/** First images of row bodies by row id, valid while the row's `updatedAt` stays the same. */
const coverCache = new Map<string, { at: number; url: string | null }>();
const MAX_CACHED_COVERS = 5000;

/**
 * The first image in each row's body, for gallery covers. Only rows whose Markdown mentions an
 * image are read, and from their Yjs state rather than the Markdown, so text that merely looks
 * like image Markdown (in a code block, say) never becomes a cover.
 */
export async function rowCovers(rows: { id: string; updatedAt: Date; hasImage?: boolean }[]) {
  const covers = new Map<string, string | null>();
  const missing: string[] = [];
  for (const row of rows) {
    if (!row.hasImage) continue;
    const cached = coverCache.get(row.id);
    if (cached && cached.at === row.updatedAt.getTime()) covers.set(row.id, cached.url);
    else missing.push(row.id);
  }
  if (!missing.length) return covers;
  const docs = await db
    .select({ id: page.id, ydoc: page.ydoc, updatedAt: page.updatedAt })
    .from(page)
    .where(inArray(page.id, missing));
  for (const doc of docs) {
    const url = firstImageInYdoc(doc.ydoc, COLLAB_FRAGMENT);
    covers.set(doc.id, url);
    coverCache.delete(doc.id);
    coverCache.set(doc.id, { at: doc.updatedAt.getTime(), url });
  }
  // Oldest entries first: Maps iterate in insertion order.
  for (const id of coverCache.keys()) {
    if (coverCache.size <= MAX_CACHED_COVERS) break;
    coverCache.delete(id);
  }
  return covers;
}

export type RowTemplateSummary = { id: string; title: string; icon: string | null; repeat: TemplateRepeatSummary | null };

/**
 * A database's row templates the user can see, in order (see server/templates.ts). Access to the
 * database has been checked.
 */
export async function listRowTemplateSummaries(userId: string, databaseId: string): Promise<RowTemplateSummary[]> {
  const rows = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      enabled: schedule.enabled,
      nextRunAt: schedule.nextRunAt,
      lastError: schedule.lastError,
    })
    .from(page)
    .leftJoin(schedule, eq(schedule.templateId, page.id))
    .where(and(eq(page.parentId, databaseId), eq(page.isTemplate, true), isNull(page.archivedAt), pageVisibleTo(userId)))
    .orderBy(asc(page.position), asc(page.createdAt));
  return rows.map(({ enabled, nextRunAt, lastError, ...template }) => ({
    ...template,
    repeat: enabled === null ? null : repeatSummary({ enabled, nextRunAt, lastError }),
  }));
}

/**
 * Everything the database UI needs in one round trip. Rows are unfiltered and in manual order
 * (views are applied client-side so switching views and optimistic edits are instant).
 */
export async function getDatabaseSnapshot(
  userId: string,
  databaseId: string,
  /** `covers`: a gallery that isn't one of the database's views (a linked view) shows row images. */
  { covers: coversWanted = false }: { covers?: boolean } = {},
) {
  const { database, properties, views, access, propertyAccess } = await getDatabase(userId, databaseId);
  const withCovers = coversWanted || views.some((v) => v.type === "gallery" && galleryCover(v.config) === "first_image");
  const stored = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      properties: page.properties,
      createdBy: page.createdBy,
      updatedBy: page.updatedBy,
      position: page.position,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      ...(withCovers ? { hasImage: sql<boolean>`${page.contentMarkdown} ~ ${PG_MARKDOWN_IMAGE_PATTERN}` } : {}),
    })
    .from(page)
    .where(
      and(
        eq(page.parentId, databaseId),
        eq(page.isTemplate, false),
        // A trashed database still shows (and exports) the rows that went to the trash with it.
        database.archivedAt ? eq(page.archivedAt, database.archivedAt) : isNull(page.archivedAt),
        pageVisibleTo(userId),
      ),
    )
    .orderBy(asc(page.position), asc(page.createdAt));
  const [relations, people, covers, templates] = await Promise.all([
    getRelationTargets(userId, properties),
    getPeople(userId, properties),
    withCovers ? rowCovers(stored) : null,
    listRowTemplateSummaries(userId, databaseId),
  ]);
  const rows: DatabaseRowWithPosition[] = (await withValues(userId, databaseId, stored, properties, { relations, people }, access)).map(
    ({ hasImage: _, ...row }) => (covers ? { ...row, cover: covers.get(row.id) ?? null } : row),
  );
  return {
    database: {
      id: database.id,
      workspaceId: database.workspaceId,
      title: database.title,
      icon: database.icon,
      archived: Boolean(database.archivedAt),
      locked: Boolean(database.lockedAt),
      /** The row template "New" starts from, when the user can see it. */
      defaultTemplateId: templates.some((t) => t.id === database.defaultTemplateId) ? database.defaultTemplateId : null,
    },
    properties,
    /** The viewer's level on each restricted property; missing when none is. */
    propertyAccess,
    views,
    rows,
    /** Row templates, for the menu next to "New". */
    templates,
    relations,
    people,
    viewerId: userId,
  };
}

export type RelationTargetRow = { id: string; title: string; icon: string | null };
export type RelationTarget = {
  /** Null when the related database was deleted or is in the trash. */
  database: { id: string; title: string; icon: string | null } | null;
  /** Name of the paired property on the related database, for two-way relations; null when hidden. */
  pairedName: string | null;
  /** Live rows of the related database, in manual order: link candidates and display titles. */
  rows: RelationTargetRow[];
  /** Properties of the related database, for choosing what a rollup reads; empty when hidden. */
  properties: RelationTargetProperty[];
};
export type RelationTargetProperty = Pick<DatabaseProperty, "id" | "name" | "type" | "options">;

/**
 * The related database and its rows for every relation property, keyed by property id, limited
 * to what the user can see: access to the source database doesn't cover the related one.
 */
export async function getRelationTargets(
  userId: string,
  properties: DatabaseProperty[],
): Promise<Record<string, RelationTarget>> {
  const targetIds = [
    ...new Set(properties.flatMap((p) => (p.type === "relation" && p.options.relation ? [p.options.relation.databaseId] : []))),
  ];
  if (!targetIds.length) return {};
  const pairedIds = properties.flatMap((p) => (p.options.relation?.pairedPropertyId ? [p.options.relation.pairedPropertyId] : []));
  const [databases, rows, paired, targetProperties] = await Promise.all([
    db
      .select({ id: page.id, title: page.title, icon: page.icon })
      .from(page)
      .where(and(inArray(page.id, targetIds), eq(page.kind, "database"), isNull(page.archivedAt), pageVisibleTo(userId))),
    db
      .select({ id: page.id, title: page.title, icon: page.icon, parentId: page.parentId })
      .from(page)
      .where(and(inArray(page.parentId, targetIds), eq(page.isTemplate, false), isNull(page.archivedAt), pageVisibleTo(userId)))
      .orderBy(asc(page.position), asc(page.createdAt)),
    pairedIds.length
      ? db
          .select({ id: databaseProperty.id, name: databaseProperty.name })
          .from(databaseProperty)
          .where(inArray(databaseProperty.id, pairedIds))
      : Promise.resolve([]),
    loadProperties(targetIds),
  ]);
  // A related database's properties as the viewer may know them (see server/property-access).
  const accessByTarget = new Map(
    await Promise.all(databases.map(async (d) => [d.id, await propertyAccessFor(userId, d.id)] as const)),
  );
  const out: Record<string, RelationTarget> = {};
  for (const prop of properties) {
    const targetId = prop.type === "relation" ? prop.options.relation?.databaseId : undefined;
    if (!targetId) continue;
    const database = databases.find((d) => d.id === targetId) ?? null;
    const pairedId = prop.options.relation?.pairedPropertyId;
    out[prop.id] = {
      database,
      // The paired property lives on the related database: named only for those who can see it.
      pairedName: (database && pairedId && paired.find((p) => p.id === pairedId)?.name) || null,
      rows: database
        ? rows.filter((r) => r.parentId === targetId).map(({ id, title, icon }) => ({ id, title, icon }))
        : [],
      properties: database
        ? accessByTarget
            .get(targetId)!
            .visible(targetProperties.get(targetId) ?? [])
            .map(({ id, name, type, options }) => ({ id, name, type, options }))
        : [],
    };
  }
  return out;
}

/** Someone a person property can show or hold. */
export type PersonRef = {
  id: string;
  name: string;
  /** Null when the viewer may not see it (guests only see names). */
  email: string | null;
  /** False once they left the workspace: still shown where assigned, no longer offered. */
  active: boolean;
  /** Their profile picture (see lib/avatar.ts), if any. */
  image?: string | null;
  /**
   * An agent (see server/agents), named as created by or last edited by: shown as an agent, never
   * offered (`active` is false). Absent for people.
   */
  isAgent?: true;
  /** The agent's icon, an emoji. */
  agentIcon?: string | null;
};

/**
 * The people person properties of these properties' database can show and offer, sorted by name.
 * Owners and members get everyone in the workspace; guests, who can't see who is in the
 * workspace, get themselves and the people already assigned in rows or views they can see.
 * Agents, guests that work for the workspace, get everyone's names, but no emails. Former members
 * still assigned somewhere come along as inactive, so their name keeps showing; so do agents that
 * created or last edited a row, marked as agents.
 */
export async function getPeople(userId: string, properties: DatabaseProperty[]): Promise<PersonRef[]> {
  const personProps = properties.filter((p) => holdsPeople(p.type));
  if (!personProps.length) return [];
  const databaseId = personProps[0].databaseId;
  const [database] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, databaseId));
  const membership = database && (await getMembership(userId, database.workspaceId));
  if (!membership) return [];
  const [members, stored, views, access] = await Promise.all([
    workspacePeopleOf(databaseId),
    db
      .select({ properties: page.properties, createdBy: page.createdBy, updatedBy: page.updatedBy })
      .from(page)
      .where(and(eq(page.parentId, databaseId), pageVisibleTo(userId))),
    db.select({ config: databaseView.config }).from(databaseView).where(eq(databaseView.databaseId, databaseId)),
    propertyAccessFor(userId, databaseId),
  ]);
  // People named only in values the viewer may not see don't count as seen.
  const rows = access.strip(stored);
  const referenced = new Set<string>();
  for (const { properties: stored, createdBy, updatedBy } of rows) {
    const values = { ...stored, ...computedValues(personProps, { createdBy, updatedBy }) };
    for (const prop of personProps) for (const id of asIds(values[prop.id])) referenced.add(id);
  }
  for (const view of views) {
    for (const rule of filterRules(access.viewConfig(view.config).filters)) {
      const person = personProps.some((p) => p.id === rule.propertyId);
      if (person && typeof rule.value === "string" && rule.value !== PERSON_ME) referenced.add(rule.value);
    }
  }
  const guest = isGuest(membership.role);
  const agent = guest && (await isAgentUser(userId));
  const out: PersonRef[] = members
    .filter((m) => !guest || agent || m.id === userId || referenced.has(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name,
      email: guest && m.id !== userId ? null : m.email,
      active: true,
      image: avatarSrc(m.image),
    }));
  const former = [...referenced].filter((id) => !members.some((m) => m.id === id));
  if (former.length) {
    const [users, agents] = await Promise.all([
      db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, former)),
      agentMarks(former),
    ]);
    out.push(
      ...users.map((u) => {
        const mark = agents.get(u.id);
        return { id: u.id, name: u.name, email: null, active: false, ...(mark ? { isAgent: true as const, agentIcon: mark.agentIcon } : {}) };
      }),
    );
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** What MCP output needs to name linked rows and people instead of printing ids. */
export type DatabaseLookups = { relations: Record<string, RelationTarget>; people: PersonRef[] };

export async function getLookups(userId: string, properties: DatabaseProperty[]): Promise<DatabaseLookups> {
  const [relations, people] = await Promise.all([getRelationTargets(userId, properties), getPeople(userId, properties)]);
  return { relations, people };
}

/** Live databases of a workspace, for choosing the target of a relation. Templates aren't offered. */
export async function listWorkspaceDatabases(userId: string, workspaceId: string) {
  await requireMembership(userId, workspaceId);
  return db
    .select({ id: page.id, title: page.title, icon: page.icon })
    .from(page)
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        eq(page.kind, "database"),
        eq(page.inTemplate, false),
        isNull(page.archivedAt),
        pageVisibleTo(userId),
      ),
    )
    .orderBy(asc(page.title));
}

/** A single row with its database schema, for the property panel on a row page. */
export async function getRow(userId: string, rowId: string) {
  const row = await requirePageAccess(userId, rowId, "view");
  if (!row.parentId) throw withCode(new Error("Page is not a database row"), "notADatabaseRow");
  const database = await requireDatabase(userId, row.parentId, "view");
  const [all, access] = await Promise.all([getProperties(row.parentId), propertyAccessFor(userId, row.parentId)]);
  const properties = access.visible(all);
  const [relations, people] = await Promise.all([getRelationTargets(userId, properties), getPeople(userId, properties)]);
  const [withDerived] = await withValues(userId, row.parentId, [row], properties, { relations, people }, access);
  return {
    databaseId: row.parentId,
    databaseTitle: database.title,
    databaseLocked: Boolean(database.lockedAt),
    row: {
      id: row.id,
      title: row.title,
      properties: withDerived.properties,
      hidden: withDerived.hidden,
      readOnly: withDerived.readOnly,
    },
    properties,
    /** The viewer's level on each restricted property; missing when none is. */
    propertyAccess: access.info(),
    relations,
    people,
    viewerId: userId,
  };
}
