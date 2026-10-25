import { ICON_RULE, parseIcon } from "@/lib/icon";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { queueAutomations } from "./automations/queue";
import {
  databaseProperty,
  databaseSync,
  databaseView,
  page,
  PROPERTY_TYPES,
  propertyPermission,
  schedule,
  user,
  type DateOptions,
  type DependencyConfig,
  type DependencyShift,
  type FilterRule,
  type FormulaConfig,
  type NumberDisplay,
  type NumberFormat,
  type PropertyOptions,
  type PropertyType,
  type RelationConfig,
  type RollupConfig,
  type RowProperties,
  type SelectOption,
  type SortRule,
  type ViewConfig,
  type ViewType,
} from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import type { DatabaseSyncSummary } from "@/lib/jira-sync";
import { firstImageInYdoc, PG_MARKDOWN_IMAGE_PATTERN } from "@/lib/cover";
import { asFiles, fileIdOf, fileIdsInProperties, fileUrl, type FileValue } from "@/lib/files";
import { assertNotInTrash } from "@/lib/page-lock";
import { repeatSummary, type TemplateRepeatSummary } from "@/lib/schedule";
import { isApplicable, isRollupFn, ROLLUP_DISPLAYS, type RollupDisplay } from "@/lib/aggregate";
import { compileFormulas, formulaForStorage, relatedDatabases, TITLE_FIELD, valueType, type RelatedSchemas } from "@/lib/derived";
import type { FormulaError, FormulaResultType, FormulaStyle } from "@/lib/formula";
import { isEmptyValue, lostValues, planConversion, retypeViewConfig, type ConversionContext } from "@/lib/convert-property";
import { dropPropertyReferences } from "@/lib/duplicate";
import { keepDeleted, livePropertyValues, uniqueName, withoutDeleted, type DeletedProperty, type DeletedView } from "@/lib/deleted-schema";
import { colorRuleFilters } from "@/lib/color-rules";
import { filterConfigError, filterRules, mapFilterRules } from "@/lib/filters";
import { chartGroupProperty } from "@/lib/chart";
import { defaultDashboardWidgets } from "@/lib/dashboard";
import { defaultFormConfig, formSchemaError } from "@/lib/forms";
import { readPlaceInput } from "@/lib/place";
import { GeocoderError, geocodeAddress } from "./geocoder";
import { configsOf, DEFAULT_VIEW_NAMES, galleryCover, isViewType, layoutConfigError } from "@/lib/views";
import {
  holdsOptions,
  holdsPeople,
  isComputed,
  isDerived,
  isNumbered,
  isReadOnlyType,
  PERSON_ME,
  type StatusGroup,
} from "@/lib/property-types";
import { dateMarker } from "@/lib/template-values";
import { checkedPrefix, claimPrefix, refuseSecondUniqueId } from "@/server/unique-ids";
import { formatUniqueId, uniqueIdPrefix } from "@/lib/unique-id";
import { canRestrict, namesPeople } from "@/lib/property-access";
import { moveGroupValue } from "@/lib/grouping";
import {
  canBeParent,
  canDepend,
  cleanParentOptions,
  dependencyProblem,
  dependentsOf,
  followDependencies,
  parentOf,
  withoutParentOptions,
} from "@/lib/dependent-options";
import { cleanDescription, MAX_PROPERTY_DESCRIPTION } from "@/lib/property-description";
import { searchFold } from "@/lib/search-fold";
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
import { calculationFormat, checkNumberFormat, takesNumberFormat, valueFormat } from "@/lib/number-format";
import { checkNumberDisplay } from "@/lib/number-display";
import { checkRelationOptions, shownPropertyIds, showableType, type RelationOptionsInput } from "@/lib/relation-options";
import { isPageVisibility, type PageVisibility } from "@/lib/page-visibility";
import { canPin, isPinned, MAX_PINNED } from "@/lib/row-layout";
import { checkDateOptions, type DateOptionsInput } from "@/lib/date-options";
import { shiftDateValue } from "@/lib/date-value";
import { dayValue } from "@/lib/timeline";
import {
  applyView,
  compareSortKeys,
  computedValues,
  isGroupable,
  makeStatusOptions,
  normalizeValue,
  positionBetween,
  PropertyValueError,
  SELECT_COLORS,
  sortKeyReader,
  sortStatusOptions,
  statusColor,
  type DatabaseErrorCode,
} from "@/lib/properties";
import {
  AccessError,
  accessRank,
  childVisibleTo,
  getMembership,
  hasLevel,
  isGuest,
  levelFromRank,
  pageAccessOf,
  pageVisibleTo,
  requireMembership,
  requirePageAccess,
  type RequiredLevel,
} from "@/server/access";
import { scheduleAssignmentEmails } from "@/server/assignments";
import { assertNestable } from "@/server/page-depth";
import { computeDerived, loadProperties, withAllFormulaTypes } from "@/server/derived";
import { authorizeFileReferences, fileForViewer, workspaceFiles } from "@/server/files";
import { recordAssignments } from "@/server/notifications";
import { getCollab } from "@/server/collab/bridge";
import { loadRowAccess } from "@/server/row-access";
import { rowChanged } from "@/server/row-events";
import { recordRowWrites } from "@/server/row-activity";
import { queueRowWrites } from "@/server/row-follow";
import { workspacePeople, workspaceSettings, type WorkspacePerson } from "@/server/workspaces";
import { agentMarks, isAgentUser } from "@/server/agents/users";
import { recordAudit } from "@/server/audit";
import { heldPageIds, refuseHeldPages } from "@/server/legal-hold";
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
  /** How styled formula results show (see lib/formula style()); their values stay plain. */
  styles?: Record<string, FormulaStyle>;
  /** Archived on its own (server/page-outdated.ts): views leave it out unless they show archived rows (applyView). */
  outdated?: boolean;
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
  // Values of deleted properties stay stored for a restore; nobody reads them meanwhile. Taken out
  // last: property access may name people by values of properties the viewer doesn't know of.
  return access.finish(derived).map((row) => ({ ...row, properties: livePropertyValues(row.properties, properties) }));
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
export function assertUnlocked(database: { lockedAt: Date | null }) {
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

export function notifyRows(databaseId: string) {
  getCollab().broadcast(`db:${databaseId}`, "rows");
}
export function notifySchema(databaseId: string) {
  getCollab().broadcast(`db:${databaseId}`, "schema");
}
/** The sidebar lists database views, so adding, renaming or removing one refreshes the tree. */
export function notifyTree(workspaceId: string) {
  getCollab().broadcast(`ws:${workspaceId}`, "tree");
}

/**
 * A database's properties in order, with each formula's result type filled in (see FormulaConfig).
 * Deleted properties are left out (see deleteProperty).
 */
export async function getProperties(databaseId: string) {
  const properties = await db
    .select()
    .from(databaseProperty)
    .where(and(eq(databaseProperty.databaseId, databaseId), isNull(databaseProperty.deletedAt)))
    .orderBy(asc(databaseProperty.position), asc(databaseProperty.createdAt));
  return withRollupUnits(await withAllFormulaTypes(properties));
}

/**
 * The properties of the databases formulas of `props` read related rows of, as `userId` may know
 * them (none of a database they can't open): what formulas they write are checked against.
 */
export async function knownRelatedSchemas(userId: string, props: Pick<DatabaseProperty, "id" | "name" | "type" | "options">[]): Promise<RelatedSchemas> {
  const ids = relatedDatabases(props);
  const known = new Map(
    await Promise.all(
      ids.map(async (id) => {
        const open = await requireDatabase(userId, id, "view").then(
          () => true,
          () => false,
        );
        return [id, open ? await knownProperties(userId, id) : undefined] as const;
      }),
    ),
  );
  return (id) => known.get(id);
}

/**
 * Rollups that sum, average… a number property (or a formula giving a number) get its format
 * (RollupConfig.number), so they show in it and filters compare what they show; read each time, a
 * change of that format shows at once.
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
    const number = config && target ? calculationFormat(config.function, { number: valueFormat(target) }) : undefined;
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
  const [all, stored, deleted, access] = await Promise.all([
    getProperties(databaseId),
    db
      .select()
      .from(databaseView)
      .where(and(eq(databaseView.databaseId, databaseId), isNull(databaseView.deletedAt)))
      .orderBy(asc(databaseView.position), asc(databaseView.createdAt)),
    deletedPropertyIds(databaseId),
    propertyAccessFor(userId, databaseId),
  ]);
  const properties = access.visible(all);
  // What views say about deleted properties stays stored for a restore (updateView puts it back).
  const views = stored.map((v) => ({ ...v, config: access.viewConfig(withoutDeleted(v.config, deleted)) }));
  return { database, properties, views, access, propertyAccess: access.info() };
}

/** The ids of a database's deleted properties. */
export async function deletedPropertyIds(databaseId: string, exec: Executor = db): Promise<Set<string>> {
  const rows = await exec
    .select({ id: databaseProperty.id })
    .from(databaseProperty)
    .where(and(eq(databaseProperty.databaseId, databaseId), isNotNull(databaseProperty.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

/**
 * A row is archived on its own when it is itself (server/page-outdated.ts); one in an archived
 * database shows in the database's views like the others.
 */
const rowOutdated = sql<boolean>`${page.outdatedAt} is not null`;

export async function listRows(userId: string, databaseId: string, config: ViewConfig = {}) {
  // Rows inherit their database's access; rows restricted on their own are left out.
  await requireDatabase(userId, databaseId, "view");
  return viewedRows(userId, databaseId, config);
}

/**
 * listRows of a database the user is known to see (checked by the caller); `known` is its
 * properties when they're already loaded. Relative date filters ("today") and times count in
 * `timeZone`, the server's when left out.
 */
export async function viewedRows(
  userId: string,
  databaseId: string,
  config: ViewConfig = {},
  known?: Awaited<ReturnType<typeof getProperties>>,
  { now, timeZone }: { now?: Date; timeZone?: string } = {},
) {
  return (await readRows(userId, databaseId, config, known, { now, timeZone })).rows;
}

/** A row's place in listRowsInOrder: its sort values, then its position, created time and id. */
export type RowOrderKey = { sort: unknown[]; position: number; created: number; id: string };

/** Orders two RowOrderKeys under the same sorts. */
export function compareRowOrder(a: RowOrderKey, b: RowOrderKey, sorts: SortRule[]) {
  return (
    compareSortKeys(a.sort, b.sort, sorts) ||
    a.position - b.position ||
    a.created - b.created ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * listRows in one total order, for reading a page at a time: the sorts as listRows applies them,
 * then the rows' own order (position, then created time), then id, each row with the key that
 * places it. Without ties, a key stored from one call says where the next page starts even after
 * rows were added, removed or moved in between.
 */
export async function listRowsInOrder(userId: string, databaseId: string, config: ViewConfig = {}) {
  await requireDatabase(userId, databaseId, "view");
  const { rows, sorts, properties, people, positions } = await readRows(userId, databaseId, config);
  const sortKeyOf = sortKeyReader<DatabaseRow>(sorts, properties, people);
  const keyed = rows.map((row) => ({
    row,
    key: { sort: sortKeyOf(row), position: positions.get(row.id) ?? 0, created: row.createdAt.getTime(), id: row.id },
  }));
  keyed.sort((a, b) => compareRowOrder(a.key, b.key, sorts));
  return { rows: keyed, sorts };
}

async function readRows(
  userId: string,
  databaseId: string,
  config: ViewConfig,
  known?: Awaited<ReturnType<typeof getProperties>>,
  { now, timeZone }: { now?: Date; timeZone?: string } = {},
) {
  const [stored, all, access, deleted] = await Promise.all([
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
        position: page.position,
        outdated: rowOutdated,
      })
      .from(page)
      .where(and(eq(page.parentId, databaseId), eq(page.isTemplate, false), isNull(page.archivedAt), childVisibleTo(userId, databaseId)))
      // The id settles ties, so rows sharing a position and created time keep one order (moveRowBeside uses it).
      .orderBy(asc(page.position), asc(page.createdAt), asc(page.id)),
    known ?? getProperties(databaseId),
    propertyAccessFor(userId, databaseId),
    deletedPropertyIds(databaseId),
  ]);
  // Filters and sorts on properties the viewer can't know of, or on deleted ones, don't apply; on
  // ones whose values they can't see they run on the redacted values, so the rows they get say
  // nothing about them.
  const properties = access.visible(all);
  config = access.viewConfig(withoutDeleted(config, deleted));
  const people = await peopleForSorts(userId, properties, config);
  const positions = new Map(stored.map((r) => [r.id, r.position]));
  const rows = stored.map(({ position: _, ...row }) => row);
  return {
    rows: applyView<DatabaseRow>(await withValues(userId, databaseId, rows, all, undefined, access), config, properties, {
      viewerId: userId,
      people,
      now,
      timeZone,
    }),
    sorts: config.sorts ?? [],
    properties,
    people,
    positions,
  };
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
  options: {
    check?: boolean;
    createdBy?: string | null;
    /**
     * false: values checked on their own, not as one row's (a bulk edit, an automation's settings),
     * so dependent selects (lib/dependent-options) are left to the writes that know the row.
     */
    dependencies?: boolean;
    /**
     * The values are a row template's: "me" in a person property and "today" or "now" in a date
     * stay as they are, worked out when a row is made from it (lib/template-values).
     */
    template?: boolean;
  } = {},
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
    const marker = options.template && prop.type === "date" ? dateMarker(value) : null;
    if (marker) {
      out[prop.id] = marker;
      continue;
    }
    const normalized = normalizeValue(prop, prop.type === "place" ? await resolvePlaceInput(userId, prop, value) : value);
    if (prop.type === "relation" && normalized) {
      const ids = await resolveRelationValue(userId, prop, normalized as string[], asIds(existing[prop.id]));
      // A relation limited to one row takes one, as a person property limited to one person does
      // (lib/properties); a value that already holds more stays as it is until it is written.
      if (prop.options.relation?.single && !isParentProperty(prop) && ids.length > 1) {
        throw new PropertyValueError(`"${prop.name}" links one row; give one (${ids.length} given)`, "oneRow", {
          property: prop.name,
        });
      }
      // A row has one parent (see lib/sub-items).
      out[prop.id] = isParentProperty(prop) ? singleParent(ids, asIds(existing[prop.id])) : ids;
    } else if (prop.type === "person" && normalized) {
      people ??= workspacePeopleOf(databaseId);
      asAgent ??= isAgentUser(userId);
      out[prop.id] = resolvePersonValue(userId, prop, normalized as string[], asIds(existing[prop.id]), await people, await asAgent, options.template);
    } else if (prop.type === "files" && normalized) {
      workspace ??= workspaceOf(databaseId);
      out[prop.id] = await resolveFilesValue(userId, prop, normalized as FileValue[], asFiles(existing[prop.id]), await workspace);
    } else out[prop.id] = normalized;
  }
  if (options.check !== false) access.requireValues({ properties: existing, createdBy: options.createdBy }, Object.keys(out));
  // Dependent selects (lib/dependent-options): what the write sets must fit, and what depends on
  // a value it changes follows, even a property the writer can't see (it follows the schema).
  return options.dependencies === false ? out : { ...out, ...followOrRefuse(all, props, existing, out) };
}

/**
 * The values a row write clears or narrows because they depend on a value it changes (see
 * lib/dependent-options followDependencies); throws when the write itself sets an option that
 * doesn't fit. `visible`: the properties the writer may know of, the only ones an error names.
 */
export function followOrRefuse(
  all: DatabaseProperty[],
  visible: DatabaseProperty[],
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const outcome = followDependencies(all, before, patch);
  if (outcome.ok) return outcome.follow;
  const parent = visible.some((p) => p.id === outcome.parent.id) ? outcome.parent.name : "";
  const parentValue = outcome.parentValue?.name ?? "";
  throw new PropertyValueError(
    parent
      ? `"${outcome.option.name}" is not available in "${outcome.prop.name}" while "${parent}" is ${parentValue ? `"${parentValue}"` : "empty"}; choose one of its options that goes with it`
      : `"${outcome.option.name}" is not available in "${outcome.prop.name}" for this row`,
    "optionUnavailable",
    { value: outcome.option.name, property: outcome.prop.name, parent },
  );
}

/**
 * A place written as an address (text, or an object without coordinates) looked up through the
 * geocoder, counted against the writer: its best match, with the name it was given kept. Other
 * input is left for normalizeValue to check.
 */
async function resolvePlaceInput(userId: string, prop: DatabaseProperty, value: unknown): Promise<unknown> {
  if (value === null || value === undefined || value === "") return value;
  const input = readPlaceInput(value);
  if (input.kind !== "address") return value;
  let found;
  try {
    found = await geocodeAddress(input.address, { userId });
  } catch (error) {
    if (error instanceof GeocoderError && error.code === "off") {
      throw new PropertyValueError(
        `Address search is off on this server: give "${prop.name}" coordinates ("41.04, 29.01" or {lat, lng, address})`,
        "geocodingOff",
        { property: prop.name },
      );
    }
    if (error instanceof GeocoderError) {
      throw new PropertyValueError(`${error.message}; "${prop.name}" was not changed`, "geocoderBusy", { property: prop.name });
    }
    throw error;
  }
  if (!found) {
    throw new PropertyValueError(`No place found for "${input.address}" in "${prop.name}"; give coordinates instead`, "placeNotFound", {
      value: input.address,
      property: prop.name,
    });
  }
  return { ...found, ...(input.name ? { name: input.name } : {}) };
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
 * it) look people up by name, never by email; they aren't people, so "me" names no one. In a row
 * template (`template`), "me" stays "me": whoever adds a row from it (lib/template-values).
 */
function resolvePersonValue(
  userId: string,
  prop: DatabaseProperty,
  input: string[],
  existing: string[],
  people: WorkspacePerson[],
  asAgent = false,
  template = false,
) {
  const actor = people.find((p) => p.id === userId);
  const byEmailToo = Boolean(actor && actor.role !== "guest");
  const lookup = byEmailToo || asAgent;
  const out: string[] = [];
  for (const value of input) {
    let id: string | undefined;
    if (template && value.toLowerCase() === PERSON_ME) id = PERSON_ME;
    else if (value.toLowerCase() === PERSON_ME && actor) id = userId;
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
    .where(and(eq(page.parentId, targetId), eq(page.isTemplate, false), childVisibleTo(userId, targetId)));
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
export async function checkLoops(databaseId: string, writes: { rowId: string; values: Record<string, unknown> }[]) {
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
  // Paired properties that link to one row (RelationConfig `single`): a row linked
  // from here leaves the row it linked to before, as sub-items leave their old parent.
  const paired = await db
    .select({ id: databaseProperty.id, options: databaseProperty.options })
    .from(databaseProperty)
    .where(inArray(databaseProperty.id, props.map((p) => p.options.relation!.pairedPropertyId!)));
  const single = new Set(paired.filter((p) => p.options.relation?.single).map((p) => p.id));
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
      } else if (added.length && single.has(key)) {
        await moveSubItems(databaseId, rowId, added, key, prop.id, relation.databaseId);
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
 * takes them off the sub-items list (`childrenKey`) of the rows that were their parent. Also for a
 * two-way relation whose other side links to one row: then the rows `childIds` are in their own
 * database (`childDatabaseId`) and `parentKey` is that side.
 */
async function moveSubItems(
  databaseId: string,
  parentId: string,
  childIds: string[],
  parentKey: string,
  childrenKey: string,
  childDatabaseId = databaseId,
) {
  const children = await db
    .select({ id: page.id, properties: page.properties })
    .from(page)
    .where(and(inArray(page.id, childIds), eq(page.parentId, childDatabaseId)));
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
  const row = await requirePageAccess(userId, rowId, "content");
  if (!row.parentId) throw withCode(new Error("Page is not a database row"), "notADatabaseRow");
  assertNotInTrash(row);
  await requireDatabase(userId, row.parentId, "view");
  const normalized = await normalizeRowProperties(userId, row.parentId, patch, row.properties, { createdBy: row.createdBy, template: row.isTemplate });
  await checkLoops(row.parentId, [{ rowId, values: normalized }]);
  const { set, cleared } = splitPatch(normalized);
  const next = { ...row.properties, ...set };
  for (const k of cleared) delete next[k];
  // Merged in SQL, so a write to another property of this row since it was read here (another
  // person, an agent or an automation) is kept rather than overwritten with what was read.
  const [written] = await db
    .update(page)
    .set({ properties: mergedProperties(set, cleared), updatedBy: userId })
    .where(eq(page.id, rowId))
    .returning({ properties: page.properties });
  // Templates link one way and assign nobody: their values only seed the rows made from them.
  if (!row.inTemplate) {
    await syncPairedRelations(rowId, row.parentId, row.properties, next);
    await afterRowWrites(userId, row.parentId, [{ rowId, before: row.properties, after: next }]);
  } else {
    await authorizeRowFiles(userId, [{ rowId, before: row.properties, after: next }]);
  }
  notifyRows(row.parentId);
  rowChanged({ rowId, databaseId: row.parentId, userId });
  return written?.properties ?? next;
}

/** Normalized row values split into the ones to store and the ids to clear (null values). */
function splitPatch(normalized: Record<string, unknown>) {
  const set = Object.fromEntries(Object.entries(normalized).filter(([, v]) => v !== null));
  const cleared = Object.keys(normalized).filter((k) => normalized[k] === null);
  return { set, cleared };
}

/**
 * A row's stored properties with `set` written over them and `cleared` removed, worked out by the
 * database at write time: values other writes left in properties this call doesn't touch stay.
 */
export function mergedProperties(set: Record<string, unknown>, cleared: string[]) {
  const minus = cleared.length
    ? sql` - ARRAY[${sql.join(
        cleared.map((k) => sql`${k}::text`),
        sql`, `,
      )}]::text[]`
    : sql``;
  return sql<RowProperties>`(${page.properties} || ${JSON.stringify(set)}::jsonb)${minus}`;
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
 * see can't be set in bulk. Other properties of the rows are left as they are. `guard` sees what
 * the call would do before anything is written and may throw to stop it; `dryRun` stops there
 * and returns that instead.
 */
export async function updateRowsProperties(
  userId: string,
  databaseId: string,
  rowIds: string[],
  patch: Record<string, unknown>,
  { guard, dryRun = false }: { guard?: (plan: BulkResult) => void; dryRun?: boolean } = {},
): Promise<BulkResult> {
  const ids = bulkRowIds(rowIds);
  await requireDatabase(userId, databaseId, "view");
  const normalized = await normalizeRowProperties(userId, databaseId, patch, {}, { check: false, dependencies: false });
  const found = await rowsWithAccess(userId, databaseId, ids, "content");
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
  // Dependent selects (lib/dependent-options): checked against each row's own values, before anything is written.
  const all = await getProperties(databaseId);
  const visible = access.visible(all);
  const perRow = new Map(rows.map((row) => [row.id, { ...normalized, ...followOrRefuse(all, visible, row.properties, normalized) }]));
  const plan = { done: Object.keys(normalized).length ? rows.map((r) => r.id) : [], skipped };
  guard?.(plan);
  if (!plan.done.length) return plan;
  await checkLoops(databaseId, rows.map((row) => ({ rowId: row.id, values: normalized })));
  if (dryRun) return plan;

  // Rows are written in groups that end up with the same values: one group, unless the call
  // changes a property others depend on.
  const groups = new Map<string, { values: Record<string, unknown>; ids: string[] }>();
  for (const row of rows) {
    const values = perRow.get(row.id)!;
    const key = JSON.stringify(values);
    const group = groups.get(key) ?? { values, ids: [] };
    group.ids.push(row.id);
    groups.set(key, group);
  }
  // Merged in SQL, so a concurrent edit of another property of the same row isn't overwritten.
  await db.transaction(async (tx) => {
    for (const { values, ids: groupIds } of groups.values()) {
      const { set, cleared } = splitPatch(values);
      await tx
        .update(page)
        .set({ properties: mergedProperties(set, cleared), updatedBy: userId })
        .where(inArray(page.id, groupIds));
    }
  });

  // Rows of a database kept as a template link one way and assign nobody (see updateRowProperties).
  const changeOf = (row: (typeof rows)[number]) => {
    const { set, cleared } = splitPatch(perRow.get(row.id)!);
    const after: Record<string, unknown> = { ...row.properties, ...set };
    for (const k of cleared) delete after[k];
    return { rowId: row.id, before: row.properties, after };
  };
  const changes = rows.filter((row) => !row.inTemplate).map(changeOf);
  await authorizeRowFiles(userId, rows.filter((row) => row.inTemplate).map(changeOf));
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
 * What every saved row write sets off: the rows' activity (server/row-activity), authorizing the
 * files its values gained, assignment notices, the database's automations
 * (server/automations/queue), telling the rows' followers (server/row-follow) and moving the rows
 * waiting for rows whose dates moved. `created` for
 * new rows, whose `before` is empty; `shifted` for the moves themselves, which don't move more;
 * `ai` for AI values written for the actor, which read as the AI's in the activity.
 */
export async function afterRowWrites(
  actorId: string | null,
  databaseId: string,
  changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[],
  {
    created = false,
    shifted = false,
    boundTo = null,
    ai = false,
  }: { created?: boolean; shifted?: boolean; boundTo?: string | null; ai?: boolean } = {},
) {
  // Alongside the rest: recording never throws and nothing below waits for it.
  const recording = recordRowWrites(actorId, databaseId, changes, { created, anonymousForm: !actorId && boundTo !== null, ai });
  await authorizeRowFiles(actorId, changes);
  await announceAssignments(actorId, databaseId, changes);
  await queueAutomations(actorId, databaseId, changes, created, boundTo);
  if (!created && !ai) await queueRowWrites(actorId, databaseId, changes);
  if (!shifted && actorId) await shiftWaitingRows(actorId, databaseId, changes);
  await recording;
}

/**
 * The files row values gained count for the rows' viewers (see files.authorizeFileReferences) when
 * the writer could read them: resolveFilesValue let only such files in, and this holds for any
 * other way values get there too. Anonymous form answers (no actor) hold only uploads to the row
 * itself, which count anyway (forms.adoptFormFiles).
 */
export async function authorizeRowFiles(
  actorId: string | null,
  changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[],
) {
  if (!actorId) return;
  for (const { rowId, before, after } of changes) {
    const held = new Set(fileIdsInProperties(before));
    const gained = fileIdsInProperties(after).filter((id) => !held.has(id));
    if (gained.length) await authorizeFileReferences([actorId], rowId, gained);
  }
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

  const found = await rowsWithAccess(actorId, databaseId, plan.map((s) => s.id), "content");
  const access = await propertyAccessFor(actorId, databaseId);
  const shifts: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[] = [];
  for (const row of found.rows) {
    const s = plan.find((p) => p.id === row.id)!;
    // Dates move as a whole by whole days: a range keeps its length, a time its time of day.
    const values: Record<string, string> = {
      [start]: shiftDateValue(row.properties[start], s.after.start - s.before.start) ?? dayValue(s.after.start),
    };
    // A one-day row without an end keeps having none.
    if (end && row.properties[end] != null) {
      values[end] = shiftDateValue(row.properties[end], s.after.end - s.before.end) ?? dayValue(s.after.end);
    }
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
  const database = await requireDatabase(userId, databaseId, "content");
  if (database.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
  if (!rows.length) return [];

  const values: Record<string, unknown>[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      values.push(await normalizeRowProperties(userId, databaseId, row.properties ?? {}));
    } catch (error) {
      if (error instanceof PropertyValueError) {
        error.message = `Row ${i + 1} ("${row.title.trim()}"): ${error.message}`;
        // Counted from 0, as the REST API names it (rows.<index>.properties.<name>).
        error.params = { ...error.params, row: String(i) };
      }
      throw error;
    }
  }
  return insertRows(database, userId, rows.map((row, i) => ({ title: row.title, properties: values[i] })));
}

/**
 * Writes rows whose values are already checked (see normalizeRowProperties) at the end of a
 * database, then does what every new row needs: two-way relations, assignment notices and live
 * updates. `actorId` becomes the rows' creator; null (an anonymous form answer) leaves it empty.
 * `boundTo`: for an answer to a public form, who published it (see queueAutomations).
 */
export async function insertRows(
  database: { id: string; workspaceId: string },
  actorId: string | null,
  rows: { title: string; properties: Record<string, unknown> }[],
  { boundTo = null }: { boundTo?: string | null } = {},
) {
  const databaseId = database.id;
  await assertNestable(databaseId);
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
    { created: true, boundTo },
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

/**
 * `name`, or `name 2`, `name 3`… so it doesn't clash with a property of the database. Deleted
 * properties don't count: their names are free, and one restored later is renamed if need be.
 */
async function uniquePropertyName(databaseId: string, name: string, exec: Executor = db, except?: string) {
  const names = await exec
    .select({ id: databaseProperty.id, name: databaseProperty.name })
    .from(databaseProperty)
    .where(and(eq(databaseProperty.databaseId, databaseId), isNull(databaseProperty.deletedAt)));
  return uniqueName(name, names.filter((p) => p.id !== except).map((p) => p.name));
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
 * A formula as `userId` would save it for property `self` (a new one's id may be made up), checked
 * against the properties they may know of (`properties`), related rows' included: the expression
 * as stored, its result type, or its first error. `titleNames`: names that mean the row's title
 * besides "title" (the Name column's label, as the editor shows it).
 */
export async function checkFormula(
  userId: string,
  expression: string,
  properties: DatabaseProperty[],
  self: { id: string; name: string },
  titleNames: string[] = [],
): Promise<{ stored: string; type: FormulaResultType; error: FormulaError | null }> {
  const others = properties.filter((p) => p.id !== self.id);
  const draft = { ...self, type: "formula" as const, options: { formula: { expression: expression.trim() } } };
  // Properties read on related rows are checked against what the user may know of there too.
  const related = await knownRelatedSchemas(userId, [...others, draft]);
  const stored = formulaForStorage(expression.trim(), [...others, self], titleNames, related);
  const props = [...others, { ...self, type: "formula" as const, options: { formula: { expression: stored } } }];
  const compiled = compileFormulas(props, related).get(self.id);
  return { stored, type: compiled?.type ?? "text", error: compiled?.error ?? null };
}

/** One row of a formula's preview: its title and what the formula gives there (see previewFormula). */
export type FormulaPreviewRow = { id: string; title: string; value: unknown; hidden: boolean };

/**
 * What a checked formula (`stored`, from checkFormula) would give on the first `limit` rows of the
 * database `userId` sees, in the database's own order, before it is saved: the database's
 * properties with `self` holding it. Values read from properties the person may not see show as
 * hidden, as they would in the table.
 */
export async function previewFormula(
  userId: string,
  databaseId: string,
  self: { id: string; name: string },
  stored: string,
  type: FormulaResultType,
  limit = 3,
): Promise<FormulaPreviewRow[]> {
  const [rows, all, access] = await Promise.all([
    db
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
      .where(and(eq(page.parentId, databaseId), eq(page.isTemplate, false), isNull(page.archivedAt), childVisibleTo(userId, databaseId)))
      .orderBy(asc(page.position), asc(page.createdAt), asc(page.id))
      .limit(limit),
    getProperties(databaseId),
    propertyAccessFor(userId, databaseId),
  ]);
  const existing = all.find((p) => p.id === self.id);
  const now = new Date();
  const draft: DatabaseProperty = {
    ...(existing ?? { id: self.id, databaseId, position: all.length, lastNumber: 0, deletedAt: null, deletedBy: null, createdAt: now, updatedAt: now }),
    name: self.name,
    type: "formula",
    // A formula's own options (its number format…) stay; another type's don't apply.
    options: { ...(existing?.type === "formula" ? existing.options : {}), formula: { expression: stored, type } },
  };
  const props = [...all.filter((p) => p.id !== self.id), draft];
  const computed = await withValues(userId, databaseId, rows, props, undefined, access);
  return computed.map((row, i) => ({
    id: rows[i].id,
    title: rows[i].title,
    value: row.properties[self.id] ?? null,
    hidden: Boolean((row as { hidden?: string[] }).hidden?.includes(self.id)),
  }));
}

/**
 * A formula as stored: names in `prop("…")` replaced by property ids, checked against the
 * database's properties (`self` is the formula property itself, new or edited). A formula that
 * can't run (a syntax or type error, an unknown property, a cycle) is refused with the reason.
 */
async function formulaConfig(
  userId: string,
  expression: string,
  properties: DatabaseProperty[],
  self: { id: string; name: string },
): Promise<{ config: FormulaConfig; type: FormulaResultType }> {
  const { stored, type, error } = await checkFormula(userId, expression, properties, self);
  if (error) {
    throw new PropertyValueError(`Invalid formula for "${self.name}": ${error.message}`, "invalidFormula", {
      property: self.name,
      message: error.message,
    });
  }
  return { config: { expression: stored }, type };
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

/**
 * A number format given for a property of `type` (a formula's: giving `formulaType`), checked
 * (see lib/number-format); null for plain numbers. Formulas giving text, a date or a checkbox
 * are refused one, as other types are.
 */
function numberFormat(type: PropertyType, input: unknown, formulaType?: FormulaResultType): NumberFormat | null {
  if (input !== null && !takesNumberFormat(type, formulaType)) {
    throw new PropertyValueError(
      type === "formula"
        ? `Only formulas that give a number have a number format (this one gives ${formulaType === "checkbox" ? "a checkbox" : formulaType === "date" ? "a date" : "text"})`
        : `Only number properties and formulas that give a number have a number format`,
      "invalidNumberFormat",
    );
  }
  const checked = checkNumberFormat(input);
  if (!checked.ok) throw new PropertyValueError(checked.message, "invalidNumberFormat");
  return checked.format;
}

/**
 * A bar or ring display given for a property of `type` (a formula's: giving `formulaType`), checked
 * (see lib/number-display); null for the number. Numbers, formulas giving a number and rollups take
 * one (a rollup's that doesn't give a number shows as it would without).
 */
function numberDisplay(type: PropertyType, input: unknown, formulaType?: FormulaResultType): NumberDisplay | null {
  if (input !== null && type !== "number" && type !== "rollup" && !(type === "formula" && formulaType === "number")) {
    throw new PropertyValueError(
      `Only number properties, formulas that give a number and rollups show as a bar or a ring`,
      "invalidNumberFormat",
    );
  }
  const checked = checkNumberDisplay(input);
  if (!checked.ok) throw new PropertyValueError(checked.message, "invalidNumberFormat");
  return checked.display;
}

/**
 * Relation options given for a relation property, checked (see lib/relation-options): what linked
 * rows show must be properties of the related database the user may know of.
 */
async function relationOptions(userId: string, prop: DatabaseProperty, input: RelationOptionsInput): Promise<RelationConfig> {
  const current = prop.type === "relation" ? prop.options.relation : undefined;
  if (!current) throw new PropertyValueError(`"${prop.name}" is a ${prop.type} property; only relations have relation options`, "unsupportedType", { type: prop.type });
  const targetId = current.databaseId;
  const targetProps =
    input?.show?.length && targetId
      ? (await propertyAccessFor(userId, targetId)).visible((await loadProperties([targetId])).get(targetId) ?? [])
      : [];
  const checked = checkRelationOptions(input, current, targetProps);
  if (!checked.ok) throw new PropertyValueError(checked.message, "invalidRelationOptions");
  return checked.relation;
}

/**
 * Date options given for a property of `type`, checked against its current ones (see
 * lib/date-options). Created and last edited times take all but a reminder.
 */
function dateOptions(type: PropertyType, input: DateOptionsInput, current: DateOptions | undefined): DateOptions | null {
  const stamp = type === "created_time" || type === "last_edited_time";
  if (type !== "date" && !stamp) {
    throw new PropertyValueError(`Only date properties and created or last edited times have date options`, "invalidDateOptions");
  }
  if (stamp && input.reminderDays !== undefined && input.reminderDays !== null) {
    throw new PropertyValueError(`Only date properties remind people`, "invalidDateOptions");
  }
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
    /** Numbers and formulas giving a number: how values show (see lib/number-format). */
    number?: NumberFormat | null;
    /** Dates: relative display and a reminder (see lib/date-options). */
    date?: DateOptionsInput;
    /** What it holds and how to fill it (see lib/property-description). */
    description?: string | null;
    /** Unique IDs: the prefix they show with ("TASK" for TASK-12); none when left out. */
    prefix?: string | null;
  },
) {
  const database = await requireDatabase(userId, databaseId, "edit");
  const description = input.description !== undefined ? checkedDescription(input.description) : null;
  const prefix = input.type === "unique_id" ? checkedPrefix(input.prefix) : null;
  assertUnlocked(database);
  if (!PROPERTY_TYPES.includes(input.type)) {
    throw new PropertyValueError(`Unsupported type "${input.type}"`, "unsupportedType", { type: String(input.type) });
  }
  const name = input.name.trim() || "Property";
  const formula =
    input.type === "formula"
      ? await formulaConfig(userId, input.formula?.expression ?? "", await knownProperties(userId, databaseId), { id: "\u0000new", name })
      : undefined;
  const rollup =
    input.type === "rollup"
      ? await rollupConfig(userId, input.rollup, await knownProperties(userId, databaseId), { id: "\u0000new", name })
      : undefined;
  const target = input.type === "relation" ? await relationTarget(userId, database, input.relation) : null;
  const number = input.number !== undefined ? numberFormat(input.type, input.number, formula?.type) : null;
  const date = input.date !== undefined ? dateOptions(input.type, input.date, undefined) : null;
  const typeOptions: PropertyOptions =
    date
      ? { date }
      : input.type === "select" || input.type === "multi_select"
      ? { options: (input.options ?? []).map((o, i) => makeOption(typeof o === "string" ? o : o.name, i, typeof o === "string" ? undefined : o.color)) }
      : input.type === "status"
        ? { options: makeStatusOptions(input.options) }
        : target
          ? { relation: { databaseId: target.id } }
          : formula
            ? { formula: formula.config }
            : rollup
              ? { rollup }
              : prefix
                ? { uniqueId: { prefix } }
                : {};
  // A formula keeps its expression beside its format.
  const formatted: PropertyOptions = number ? { ...typeOptions, number } : typeOptions;
  const options: PropertyOptions = description ? { description, ...formatted } : formatted;
  const created = await db.transaction(async (tx) => {
    // The rows are numbered as it goes in (drizzle/*_unique_id.sql).
    if (input.type === "unique_id") {
      await refuseSecondUniqueId(tx, databaseId);
      await claimPrefix(tx, database.workspaceId, prefix);
    }
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
  if (isNumbered(input.type)) notifyRows(databaseId);
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
/** An option to add: its name, or its name with a status group and one of the select colors. */
export type OptionInput = string | { name: string; group?: StatusGroup; color?: string };

/**
 * For row writes that follow a schema change (a deleted property or option): the rows weren't
 * edited, so their "last edited" time stays.
 */
const KEEP_EDIT_TIME = { updatedAt: sql<Date>`${page.updatedAt}` };

/** A new option, colored `color` when it is one of the select colors, else by its place. */
export function makeOption(name: string, index = 0, color?: string): SelectOption {
  const picked = color && (SELECT_COLORS as readonly string[]).includes(color) ? color : SELECT_COLORS[index % SELECT_COLORS.length];
  return { id: crypto.randomUUID(), name: name.trim(), color: picked };
}

/**
 * A property the user may change. Every caller edits the schema, which a lock forbids, except
 * adding an option while typing a new tag into a cell (`cellEdit`).
 */
async function requireProperty(userId: string, propertyId: string, { cellEdit = false } = {}) {
  // A deleted property can only be restored or deleted for good (see requireDeletedProperty).
  const [prop] = await db
    .select()
    .from(databaseProperty)
    .where(and(eq(databaseProperty.id, propertyId), isNull(databaseProperty.deletedAt)));
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

/** A description as stored (see lib/property-description), or null for none; refused when too long. */
function checkedDescription(input: string | null): string | null {
  if (input === null) return null;
  const checked = cleanDescription(String(input));
  if (!checked.ok) {
    throw new PropertyValueError(`A property's description can have at most ${MAX_PROPERTY_DESCRIPTION} characters`, "invalidDescription", {
      max: String(MAX_PROPERTY_DESCRIPTION),
    });
  }
  return checked.description;
}

/**
 * The property `prop` is to depend on, by id or (MCP) name, checked (see lib/dependent-options
 * dependencyProblem); null for none.
 */
function checkedDependsOn(prop: DatabaseProperty, ref: string | null, properties: DatabaseProperty[]): string | null {
  if (ref === null || ref === "") return null;
  const needle = ref.trim().toLowerCase();
  const parent = properties.find((p) => p.id === ref) ?? properties.find((p) => p.name.trim().toLowerCase() === needle);
  const problem = dependencyProblem(prop, parent?.id ?? "", properties);
  if (problem) {
    const message =
      problem === "notDependent"
        ? `Only select and multi-select properties can depend on another property; "${prop.name}" is a ${prop.type} property`
        : problem === "loop"
          ? `"${parent!.name}" already depends on "${prop.name}"`
          : `"${prop.name}" can only depend on another select property of the same database`;
    throw new PropertyValueError(message, "invalidDependency", { property: prop.name, parent: parent?.name ?? ref });
  }
  return parent!.id;
}

/**
 * A rollup listing a select's options shows their names, not their ids, so a view filtering on it
 * ("Sprint state contains Current") names the option. When options are renamed, such filters on
 * rollups over the property follow, in every database: `renamed` maps the old name (searchFold) to
 * the new one. Returns the databases whose views changed.
 */
async function followRenamedOptions(tx: Executor, propertyId: string, renamed: Map<string, string>): Promise<string[]> {
  const rollups = await tx
    .select({ id: databaseProperty.id, databaseId: databaseProperty.databaseId })
    .from(databaseProperty)
    .where(
      and(
        eq(databaseProperty.type, "rollup"),
        sql`${databaseProperty.options} -> 'rollup' ->> 'targetPropertyId' = ${propertyId}::text`,
        sql`${databaseProperty.options} -> 'rollup' ->> 'function' = 'show_original'`,
      ),
    );
  if (!rollups.length) return [];
  const rollupIds = new Set(rollups.map((r) => r.id));
  const views = await tx
    .select({ id: databaseView.id, databaseId: databaseView.databaseId, config: databaseView.config })
    .from(databaseView)
    .where(inArray(databaseView.databaseId, [...new Set(rollups.map((r) => r.databaseId))]));
  const rename = (value: unknown) => (typeof value === "string" ? (renamed.get(searchFold(value)) ?? value) : value);
  const changed = new Set<string>();
  for (const view of views) {
    let touched = false;
    const filters = mapFilterRules(view.config.filters ?? [], (rule) => {
      if (!rollupIds.has(rule.propertyId)) return rule;
      const value = Array.isArray(rule.value) ? rule.value.map(rename) : rename(rule.value);
      if (JSON.stringify(value) === JSON.stringify(rule.value)) return rule;
      touched = true;
      return { ...rule, value } as FilterRule;
    });
    if (!touched) continue;
    // Raw SQL: the view's edit time stays, as a rename elsewhere isn't an edit of the view.
    await tx.execute(sql`update database_view set config = ${JSON.stringify({ ...view.config, filters })}::jsonb where id = ${view.id}`);
    changed.add(view.databaseId);
  }
  return [...changed];
}

/** The ids of a select's options that mark sprint states, while it is a sprints database's State (server/sprints). */
async function sprintStateOptions(propertyId: string): Promise<string[]> {
  const relations = await db
    .select({ options: databaseProperty.options })
    .from(databaseProperty)
    .where(
      and(
        eq(databaseProperty.type, "relation"),
        isNull(databaseProperty.deletedAt),
        sql`${databaseProperty.options} -> 'relation' ->> 'role' = 'sprint'`,
        sql`${databaseProperty.options} -> 'relation' -> 'sprints' ->> 'statePropertyId' = ${propertyId}::text`,
      ),
    );
  return relations.flatMap((r) => Object.values(r.options.relation?.sprints?.states ?? {}));
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
    /** Numbers and formulas giving a number: how values show; null for plain numbers. */
    number?: NumberFormat | null;
    /** Dates: the display and reminder to change; what is left out stays. */
    date?: DateOptionsInput;
    /** Row pages: whether the property shows there (see lib/page-visibility). */
    pageVisibility?: PageVisibility;
    /** Numbers: a bar or a ring instead of the number; null for the number. */
    numberDisplay?: NumberDisplay | null;
    /** What the property holds and how to fill it (see lib/property-description); null or "" for none. */
    description?: string | null;
    /**
     * Selects and multi-selects: the select property of the database this one depends on (see
     * lib/dependent-options); null for none. Changing it forgets which options went under which.
     */
    dependsOn?: string | null;
    /** Unique IDs: the prefix they show with; null for none. Only how IDs show changes, not their numbers. */
    prefix?: string | null;
    /** URLs: whether row pages show a preview of the linked page (server/url-preview.ts). */
    urlPreview?: boolean;
    /** An icon shown instead of the type's (lib/icon); null or "" for the type's. */
    icon?: string | null;
    /** Relations: how many rows a row links to, where row pages show them, what linked rows show. */
    relation?: RelationOptionsInput;
    /** People: whether a row names one person at most (rows naming more keep them until changed). */
    onePerson?: boolean;
    /** Relations: whether a row links one row at most (rows linking more keep them until changed). */
    oneRow?: boolean;
    /** Statuses: shown as a checkbox ticked for done options, or as the option. */
    statusDisplay?: "checkbox" | "option";
  },
) {
  const prop = await requireProperty(userId, propertyId);
  const icon = patch.icon === undefined ? undefined : patch.icon === null || patch.icon === "" ? null : parseIcon(patch.icon);
  if (icon === null && patch.icon) throw new PropertyValueError(`A property's icon is ${ICON_RULE}`, "invalidIcon");
  if (patch.statusDisplay !== undefined && prop.type !== "status") {
    throw new PropertyValueError(`"${prop.name}" is a ${prop.type} property; only statuses show as a checkbox`, "unsupportedType", {
      type: prop.type,
    });
  }
  if (patch.onePerson !== undefined && prop.type !== "person") {
    throw new PropertyValueError(`"${prop.name}" is a ${prop.type} property; only people can be limited to one`, "unsupportedType", {
      type: prop.type,
    });
  }
  if (patch.oneRow !== undefined && (prop.type !== "relation" || isParentProperty(prop))) {
    throw new PropertyValueError(`"${prop.name}" is a ${prop.type} property; only relations can be limited to one row`, "unsupportedType", {
      type: prop.type,
    });
  }
  if (patch.urlPreview !== undefined && prop.type !== "url") {
    throw new PropertyValueError(`"${prop.name}" is a ${prop.type} property; only URLs show link previews`, "unsupportedType", {
      type: prop.type,
    });
  }
  const description = patch.description !== undefined ? checkedDescription(patch.description) : undefined;
  if (patch.prefix !== undefined && prop.type !== "unique_id") {
    throw new PropertyValueError(`"${prop.name}" is a ${prop.type} property; only unique IDs have a prefix`, "unsupportedType", {
      type: prop.type,
    });
  }
  const prefix = patch.prefix !== undefined ? checkedPrefix(patch.prefix) : undefined;
  if (patch.pageVisibility !== undefined && !isPageVisibility(patch.pageVisibility)) {
    throw new PropertyValueError(`Unknown page visibility "${String(patch.pageVisibility)}"`, "invalidPageVisibility");
  }
  // A formula shows as a bar or a ring while it gives a number.
  const displayFormulaType =
    patch.numberDisplay && prop.type === "formula" ? (await getProperties(prop.databaseId)).find((p) => p.id === prop.id)?.options.formula?.type : undefined;
  const relation = patch.relation !== undefined ? await relationOptions(userId, prop, patch.relation) : undefined;
  const date = patch.date !== undefined ? dateOptions(prop.type, patch.date, prop.options.date) : undefined;
  const formula =
    patch.formula && prop.type === "formula"
      ? await formulaConfig(userId, patch.formula.expression, await knownProperties(userId, prop.databaseId), {
          id: prop.id,
          name: patch.name?.trim() || prop.name,
        })
      : undefined;
  // A formula takes a number format while it gives a number: the new expression's, else the current one's.
  const formulaType =
    prop.type !== "formula"
      ? undefined
      : formula
        ? formula.type
        : patch.number
          ? (await getProperties(prop.databaseId)).find((p) => p.id === prop.id)?.options.formula?.type
          : undefined;
  const number = patch.number !== undefined ? numberFormat(prop.type, patch.number, formulaType) : undefined;
  const display =
    patch.numberDisplay !== undefined ? numberDisplay(prop.type, patch.numberDisplay, formula ? formula.type : displayFormulaType) : undefined;
  const rollup =
    patch.rollup && prop.type === "rollup"
      ? await rollupConfig(userId, { ...prop.options.rollup, ...patch.rollup }, await knownProperties(userId, prop.databaseId), {
          id: prop.id,
          name: patch.name?.trim() || prop.name,
        })
      : undefined;
  // Status options are kept in group order with a valid group each.
  if (patch.options && prop.type === "status") patch = { ...patch, options: sortStatusOptions(patch.options) };
  // Dependent selects: the property it depends on, checked, and options that name only its options.
  const siblings = patch.dependsOn !== undefined || patch.options || prop.options.dependsOn || canBeParent(prop.type) ? await getProperties(prop.databaseId) : [];
  const dependsOn = patch.dependsOn !== undefined ? checkedDependsOn(prop, patch.dependsOn, siblings) : undefined;
  const parent = parentOf({ ...prop, options: { ...prop.options, dependsOn: dependsOn === undefined ? prop.options.dependsOn : (dependsOn ?? undefined) } }, siblings);
  if (patch.options && canDepend(prop.type)) patch = { ...patch, options: cleanParentOptions(patch.options, parent) };
  else if (dependsOn !== undefined && dependsOn !== (prop.options.dependsOn ?? null) && prop.options.options) {
    patch = { ...patch, options: withoutParentOptions(prop.options.options) };
  }
  // Rows must not keep ids of deleted options: they'd show as empty yet fail validation on the next edit.
  const removed = patch.options
    ? (prop.options.options ?? []).filter((o) => !patch.options!.some((n) => n.id === o.id)).map((o) => o.id)
    : [];
  // The options that mark sprints current, next, future or completed (server/sprints) stay while
  // sprints are on: the sprint views and Complete sprint go by them.
  if (removed.length && prop.type === "select" && (await sprintStateOptions(prop.id)).some((id) => removed.includes(id))) {
    throw new PropertyValueError("This option marks a sprint state: rename it, or turn sprints off first", "sprintStateOption");
  }
  // Options renamed, by their old name (folded) to the new one: filters naming them follow.
  const renamed = new Map(
    (patch.options ?? []).flatMap((n) => {
      const before = (prop.options.options ?? []).find((o) => o.id === n.id);
      return before && before.name !== n.name ? [[searchFold(before.name), n.name] as const] : [];
    }),
  );
  // The options as they'll be stored, each change made on top of the others (unchanged: undefined).
  let options: PropertyOptions | undefined;
  const change = (next: (current: PropertyOptions) => PropertyOptions) => {
    options = next(options ?? prop.options);
  };
  const without = (current: PropertyOptions, key: keyof PropertyOptions) => {
    const { [key]: _removed, ...rest } = current;
    return rest;
  };
  if (patch.options !== undefined) change((o) => ({ ...o, options: patch.options }));
  if (formula) change((o) => ({ ...o, formula: formula.config }));
  if (rollup) change((o) => ({ ...o, rollup }));
  if (number !== undefined) change((o) => (number ? { ...o, number } : without(o, "number")));
  // An expression that no longer gives a number drops the format it had.
  else if (formula && formula.type !== "number" && prop.options.number) change((o) => without(o, "number"));
  if (date !== undefined) change((o) => (date ? { ...o, date } : without(o, "date")));
  if (display !== undefined) change((o) => (display ? { ...o, numberDisplay: display } : without(o, "numberDisplay")));
  // An expression that no longer gives a number drops its bar or ring.
  else if (formula && formula.type !== "number" && prop.options.numberDisplay) change((o) => without(o, "numberDisplay"));
  if (relation) change((o) => ({ ...o, relation }));
  if (patch.oneRow !== undefined && prop.options.relation) {
    const on = patch.oneRow === true;
    change((o) => {
      const { single: _single, ...rest } = o.relation ?? prop.options.relation!;
      return { ...o, relation: on ? { ...rest, single: true } : rest };
    });
  }
  if (patch.pageVisibility !== undefined) {
    const visibility = patch.pageVisibility;
    change((o) => (visibility === "show" ? without(o, "pageVisibility") : { ...o, pageVisibility: visibility }));
  }
  if (description !== undefined) change((o) => (description ? { ...o, description } : without(o, "description")));
  if (dependsOn !== undefined) change((o) => (dependsOn ? { ...o, dependsOn } : without(o, "dependsOn")));
  if (prefix !== undefined) change((o) => (prefix ? { ...o, uniqueId: { prefix } } : without(o, "uniqueId")));
  if (patch.urlPreview !== undefined) change((o) => (patch.urlPreview === true ? { ...o, url: { preview: true } } : without(o, "url")));
  if (patch.statusDisplay !== undefined) {
    change((o) => (patch.statusDisplay === "checkbox" ? { ...o, statusDisplay: "checkbox" } : without(o, "statusDisplay")));
  }
  if (patch.onePerson !== undefined) change((o) => (patch.onePerson === true ? { ...o, person: { single: true } } : without(o, "person")));
  if (icon !== undefined) change((o) => (icon ? { ...o, icon } : without(o, "icon")));
  // Options of this property others depend on that go away leave their lists (lib/dependent-options).
  const dependents = removed.length ? dependentsOf(prop.id, siblings) : [];
  const workspaceId = prefix ? await workspaceOf(prop.databaseId) : null;
  let followed: string[] = [];
  await db.transaction(async (tx) => {
    if (prefix && workspaceId) await claimPrefix(tx, workspaceId, prefix, prop.id);
    if (renamed.size) followed = await followRenamedOptions(tx, prop.id, renamed);
    for (const child of dependents) {
      const pruned = cleanParentOptions(child.options.options ?? [], { options: { options: patch.options } });
      await tx
        .update(databaseProperty)
        .set({ options: { ...child.options, options: pruned } })
        .where(eq(databaseProperty.id, child.id));
    }
    await tx
      .update(databaseProperty)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() || prop.name } : {}),
        ...(options ? { options } : {}),
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
  for (const databaseId of followed) if (databaseId !== prop.databaseId) notifySchema(databaseId);
  // A new prefix changes how every row's ID shows.
  if (removed.length || prefix !== undefined) notifyRows(prop.databaseId);
  // Date options as stored (a reminder's zone and start are decided here): undefined when unchanged.
  return { date };
}

/**
 * Pins a property to the strip under its rows' titles, or takes it out (lib/row-layout). How row
 * pages look is the database's, for everyone: full access, as for who sees each property.
 */
export async function setPropertyPinned(userId: string, propertyId: string, pinned: boolean) {
  const prop = await requireProperty(userId, propertyId);
  await requireDatabase(userId, prop.databaseId, "full");
  if (pinned === isPinned(prop)) return;
  if (pinned && !canPin(await getProperties(prop.databaseId), prop.id)) {
    throw Object.assign(withCode(new Error("Too many pinned properties"), "tooManyPinned"), { params: { max: String(MAX_PINNED) } });
  }
  const { pinned: _was, ...rest } = prop.options;
  await db
    .update(databaseProperty)
    .set({ options: pinned ? { ...rest, pinned: true } : rest })
    .where(eq(databaseProperty.id, propertyId));
  notifySchema(prop.databaseId);
}

/**
 * Makes a one-way relation two-way: adds the paired property to the related database (named
 * `pairedName`, or after this database) and links every row back from the rows it links to. Like
 * making a two-way relation, it takes edit access to both databases. Relations with a role (sub-items,
 * dependencies, sprints) are set up by their feature and are left alone.
 */
export async function makeRelationTwoWay(userId: string, propertyId: string, pairedName?: string) {
  const prop = await requireProperty(userId, propertyId);
  const relation = prop.type === "relation" ? prop.options.relation : undefined;
  if (!relation || relation.role) throw withCode(new Error("Not a plain relation property"), "unsupportedType");
  if (relation.pairedPropertyId) return prop;
  const database = await requireDatabase(userId, prop.databaseId, "edit");
  const target = await relationTarget(userId, database, { databaseId: relation.databaseId, twoWay: true });
  const linked = await db.transaction(async (tx) => {
    // Held until the pair is written, so making it two-way twice at once adds one paired property.
    const [locked] = await tx.select().from(databaseProperty).where(eq(databaseProperty.id, propertyId)).for("update");
    if (!locked || locked.deletedAt || locked.options.relation?.pairedPropertyId) return null;
    const [paired] = await tx
      .insert(databaseProperty)
      .values({
        databaseId: target.id,
        name: await uniquePropertyName(target.id, pairedName?.trim() || database.title.trim() || "Related", tx),
        type: "relation",
        options: { relation: { databaseId: prop.databaseId, pairedPropertyId: propertyId } },
        position: await nextPropertyPosition(target.id, tx),
      })
      .returning();
    await hideInCalendars(tx, target.id, paired.id);
    const [updated] = await tx
      .update(databaseProperty)
      .set({ options: { ...locked.options, relation: { ...locked.options.relation!, pairedPropertyId: paired.id } } })
      .where(eq(databaseProperty.id, propertyId))
      .returning();
    return updated;
  });
  if (!linked) return (await db.select().from(databaseProperty).where(eq(databaseProperty.id, propertyId)))[0];
  // Every row linking somewhere is linked back from there, as a new two-way relation's rows are.
  const rows = await db
    .select({ id: page.id, value: sql<unknown>`${page.properties} -> ${propertyId}::text` })
    .from(page)
    .where(and(eq(page.parentId, prop.databaseId), sql`${page.properties} ? ${propertyId}::text`));
  await syncPairedRelationsMany(
    prop.databaseId,
    rows.flatMap((r) => (Array.isArray(r.value) && r.value.length ? [{ rowId: r.id, before: {}, after: { [propertyId]: r.value } }] : [])),
  );
  notifySchema(prop.databaseId);
  notifyRows(prop.databaseId);
  if (target.id !== prop.databaseId) {
    notifySchema(target.id);
    notifyRows(target.id);
  }
  return linked;
}

/** Shows a database's row properties beside the row's body on wide pages, or above it (lib/row-layout); full access. */
export async function setPropertiesBeside(userId: string, databaseId: string, beside: boolean) {
  const database = await requireDatabase(userId, databaseId, "full");
  assertUnlocked(database);
  // How its rows look isn't an edit of the database: its edit time stays.
  await db.update(page).set({ propertiesBeside: beside, ...KEEP_EDIT_TIME }).where(eq(page.id, databaseId));
  notifySchema(databaseId);
}

/** Adds a select option by name if missing and returns it (used when typing a new tag). */
export async function ensureOption(userId: string, propertyId: string, name: string) {
  const prop = await requireProperty(userId, propertyId, { cellEdit: true });
  if (!holdsOptions(prop.type)) {
    throw withCode(new Error("Not a select property"), "notASelectProperty");
  }
  const options = prop.options.options ?? [];
  const existing = options.find((o) => searchFold(o.name) === searchFold(name.trim()));
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

/**
 * Deletes a property: it is left out everywhere (views, row pages, filters, formulas, exports, MCP
 * and the REST API) until someone restores it (restoreProperty), deletes it for good
 * (purgeProperty), or the daily cleanup does after the workspace's `trashRetentionDays` (see
 * server/retention). Rows keep its values and views what they said about it, so a restore brings
 * both back as they were. The other side of a two-way relation is deleted with it, when the user
 * may change that one too; otherwise the two are taken apart first (see mayOnlyDetach).
 */
export async function deleteProperty(userId: string, propertyId: string) {
  const prop = await requireProperty(userId, propertyId);
  const pair = await withPair(prop, db, false);
  const detach = await mayOnlyDetach(userId, pair, false);
  const props = detach ? [prop] : pair;
  const workspaceId = await workspaceOf(prop.databaseId);
  const deletedAt = new Date();
  await db.transaction(async (tx) => {
    if (detach) await unpair(tx, pair);
    await tx
      .update(databaseProperty)
      .set({ deletedAt, deletedBy: userId })
      .where(inArray(databaseProperty.id, props.map((p) => p.id)));
    if (workspaceId) await auditProperties(tx, workspaceId, userId, "property.trashed", props);
  });
  notifyPropertyDatabases(pair);
}

/** A property and the other side of its two-way relation, when that one is (`deleted`) or isn't deleted. */
async function withPair(prop: DatabaseProperty, exec: Executor, deleted: boolean): Promise<DatabaseProperty[]> {
  const pairedId = prop.type === "relation" ? prop.options.relation?.pairedPropertyId : null;
  if (!pairedId || pairedId === prop.id) return [prop];
  const [paired] = await exec
    .select()
    .from(databaseProperty)
    .where(and(eq(databaseProperty.id, pairedId), deleted ? isNotNull(databaseProperty.deletedAt) : isNull(databaseProperty.deletedAt)));
  return paired ? [prop, paired] : [prop];
}

/**
 * Whether deleting, restoring or deleting for good a property of a two-way relation (`pair`, as
 * withPair gives it) may act on its own side only: the user may not change the other side, in
 * another database, as they may their own (edit access to that database, unlocked, and to the
 * property itself). Then the two are taken apart instead, each a one-way relation with its values,
 * the way changing the property's type leaves the other side.
 */
async function mayOnlyDetach(userId: string, pair: DatabaseProperty[], deleted: boolean) {
  const paired = pair[1];
  if (!paired) return false;
  const { page: database, level } = await pageAccessOf(userId, paired.databaseId);
  if (!database || !hasLevel(level, "edit") || database.lockedAt) return true;
  const access = await propertyAccessFor(userId, paired.databaseId, { withDeleted: deleted });
  if (!access.visible([paired]).length) return true;
  try {
    access.requireSchema(paired.id);
  } catch (error) {
    if (error instanceof PropertyValueError) return true;
    throw error;
  }
  return false;
}

/** Takes the two sides of a two-way relation apart: each stays as a one-way relation. Returns them as they are now. */
async function unpair(exec: Executor, pair: DatabaseProperty[]): Promise<DatabaseProperty[]> {
  const out: DatabaseProperty[] = [];
  for (const p of pair) {
    if (!p.options.relation) {
      out.push(p);
      continue;
    }
    const [row] = await exec
      .update(databaseProperty)
      .set({ options: { ...p.options, relation: { ...p.options.relation, pairedPropertyId: null } } })
      .where(eq(databaseProperty.id, p.id))
      .returning();
    out.push(row ?? p);
  }
  return out;
}

/** Everyone looking at the databases of these properties reloads them (values show or go too). */
function notifyPropertyDatabases(props: { databaseId: string }[]) {
  for (const databaseId of new Set(props.map((p) => p.databaseId))) {
    notifySchema(databaseId);
    notifyRows(databaseId);
  }
}

/** One audit event per property, on its database (the other side of a relation on its own one). */
async function auditProperties(
  tx: Executor,
  workspaceId: string,
  actorId: string | null,
  action: "property.trashed" | "property.restored" | "property.deleted",
  props: { databaseId: string; name: string; type: PropertyType }[],
) {
  for (const p of props) {
    await recordAudit(
      { workspaceId, actorId, action, target: { type: "page", id: p.databaseId }, details: { property: p.name, type: p.type } },
      tx as Parameters<typeof recordAudit>[1],
    );
  }
}

/**
 * A deleted property the user may restore or delete for good: what deleting it took (edit access
 * to an unlocked database, and to the property itself as it was).
 */
async function requireDeletedProperty(userId: string, propertyId: string) {
  const [prop] = await db
    .select()
    .from(databaseProperty)
    .where(and(eq(databaseProperty.id, propertyId), isNotNull(databaseProperty.deletedAt)));
  if (!prop) throw new AccessError();
  const database = await requireDatabase(userId, prop.databaseId, "edit");
  const access = await propertyAccessFor(userId, prop.databaseId, { withDeleted: true });
  if (!access.visible([prop]).length) throw new AccessError();
  assertUnlocked(database);
  access.requireSchema(prop.id);
  return { prop, database };
}

/**
 * Brings a deleted property back, with the other side of its two-way relation: its values in every
 * row, what views said about it, formulas and rollups that read it, and its access rules. A name
 * another property took meanwhile gets a number ("Status 2", the way new properties are named).
 * Sub-items and dependencies stand for one relation each: one turned on again meanwhile keeps the
 * part, and the restored relation comes back as a plain relation. When the user may not change the
 * other side, it stays deleted and the two are taken apart (see mayOnlyDetach).
 */
export async function restoreProperty(userId: string, propertyId: string) {
  const { prop, database } = await requireDeletedProperty(userId, propertyId);
  const detach = await mayOnlyDetach(userId, await withPair(prop, db, true), true);
  const touched = new Set<string>([prop.databaseId]);
  const restored = await db.transaction(async (tx) => {
    const pair = await withPair(prop, tx, true);
    for (const p of pair) touched.add(p.databaseId);
    // The other side stays deleted, no longer paired: restoring it later brings back a one-way relation.
    const props = detach ? (await unpair(tx, pair)).slice(0, 1) : pair;
    const out: DatabaseProperty[] = [];
    for (const p of props) {
      // Its rows' numbers come back with it; those made meanwhile are numbered (drizzle/*_unique_id.sql).
      if (p.type === "unique_id") await refuseSecondUniqueId(tx, p.databaseId, p.id);
      const name = await uniquePropertyName(p.databaseId, p.name, tx, p.id);
      let options = p.options;
      const role = options.relation?.role;
      if (role) {
        const [taken] = await tx
          .select({ id: databaseProperty.id })
          .from(databaseProperty)
          .where(
            and(
              eq(databaseProperty.databaseId, p.databaseId),
              isNull(databaseProperty.deletedAt),
              sql`${databaseProperty.options} -> 'relation' ->> 'role' = ${role}`,
            ),
          )
          .limit(1);
        if (taken) {
          const { role: _role, dependencies: _dependencies, sprints: _sprints, ...relation } = options.relation!;
          options = { ...options, relation };
        }
      }
      const [row] = await tx
        .update(databaseProperty)
        .set({ deletedAt: null, deletedBy: null, name, options })
        .where(eq(databaseProperty.id, p.id))
        .returning();
      out.push(row);
    }
    await auditProperties(tx, database.workspaceId, userId, "property.restored", out);
    return out;
  });
  notifyPropertyDatabases([...touched].map((databaseId) => ({ databaseId })));
  return restored[0];
}

/**
 * Deletes a deleted property for good, now, with the other side of its relation ("Delete
 * permanently"), or without it when the user may not change that one (see mayOnlyDetach).
 */
export async function purgeProperty(userId: string, propertyId: string) {
  const { prop, database } = await requireDeletedProperty(userId, propertyId);
  const detach = await mayOnlyDetach(userId, await withPair(prop, db, true), true);
  // Its values on rows a legal hold keeps (and the other side's, when that goes too) stay.
  const sides = detach ? [prop] : await withPair(prop, db, true);
  await refuseHeldPages(database.workspaceId, [...new Set(sides.map((p) => p.databaseId))], "propertyHeld");
  const pair = await db.transaction(async (tx) => {
    const pair = await withPair(prop, tx, true);
    // Alone, it leaves the other side as a one-way relation (see eraseProperties).
    const props = detach ? pair.slice(0, 1) : pair;
    await eraseProperties(tx, props);
    await auditProperties(tx, database.workspaceId, userId, "property.deleted", props);
    return pair;
  });
  notifyPropertyDatabases(pair);
}

/**
 * Deletes deleted properties for good, with the other sides of their relations (the daily cleanup,
 * server/retention). Recorded in the audit log as the server's own. Returns how many went. Those
 * with values a legal hold keeps (either side's database holds a held row) are left for later.
 */
export async function purgeDeletedProperties(workspaceId: string, propertyIds: string[]) {
  if (!propertyIds.length) return 0;
  const props = await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(databaseProperty)
      .where(and(inArray(databaseProperty.id, propertyIds), isNotNull(databaseProperty.deletedAt)));
    const pairs = await Promise.all(due.map((p) => withPair(p, tx, true)));
    const held = await heldPageIds(workspaceId, [...new Set(pairs.flat().map((p) => p.databaseId))], tx);
    const all = new Map<string, DatabaseProperty>();
    for (const pair of pairs) {
      if (pair.some((q) => held.has(q.databaseId))) continue;
      for (const q of pair) all.set(q.id, q);
    }
    const props = [...all.values()];
    await eraseProperties(tx, props);
    await auditProperties(tx, workspaceId, null, "property.deleted", props);
    return props;
  });
  notifyPropertyDatabases(props);
  return props.length;
}

/**
 * Takes a property that was never there back out at once (a new property whose settings failed),
 * leaving nothing in the deleted properties.
 */
export async function discardProperty(userId: string, propertyId: string) {
  const prop = await requireProperty(userId, propertyId);
  await db.transaction(async (tx) => eraseProperties(tx, await withPair(prop, tx, false)));
  notifyPropertyDatabases([prop]);
}

/**
 * Deletes properties from the database for good: their values in every row (rows keep their "last
 * edited" time) and what views say about them. Another side of a two-way relation that isn't
 * among them stays, as a one-way relation with its values intact.
 */
async function eraseProperties(tx: Executor, props: DatabaseProperty[]) {
  if (!props.length) return;
  const ids = new Set(props.map((p) => p.id));
  for (const p of props) {
    const pairedId = p.options.relation?.pairedPropertyId;
    if (!pairedId || ids.has(pairedId)) continue;
    const [paired] = await tx.select().from(databaseProperty).where(eq(databaseProperty.id, pairedId));
    if (!paired?.options.relation) continue;
    await tx
      .update(databaseProperty)
      .set({ options: { ...paired.options, relation: { ...paired.options.relation, pairedPropertyId: null } } })
      .where(eq(databaseProperty.id, paired.id));
  }
  await tx.delete(databaseProperty).where(inArray(databaseProperty.id, [...ids]));
  for (const p of props) {
    await tx
      .update(page)
      .set({ properties: sql`${page.properties} - ${p.id}::text`, ...KEEP_EDIT_TIME })
      .where(and(eq(page.parentId, p.databaseId), sql`${page.properties} ? ${p.id}::text`));
  }
  // Every view, deleted ones too: a view restored later never refers to a property that's gone.
  const views = await tx
    .select()
    .from(databaseView)
    .where(inArray(databaseView.databaseId, [...new Set(props.map((p) => p.databaseId))]));
  for (const view of views) {
    const config = dropPropertyReferences(view.config, (id) => ids.has(id));
    if (JSON.stringify(config) === JSON.stringify(view.config)) continue;
    await tx.update(databaseView).set({ config }).where(eq(databaseView.id, view.id));
  }
}

/**
 * A copy of a property right after it, named `name` (made unique): its settings, its value in every
 * row (rows keep their "last edited" time) and who may see and change it, so a copy never shows
 * values the original keeps from someone. A two-way relation is copied one way: the related
 * database gets no second property.
 */
export async function duplicateProperty(userId: string, propertyId: string, name: string) {
  const prop = await requireProperty(userId, propertyId);
  // A copy would number the rows a second time.
  if (prop.type === "unique_id") await refuseSecondUniqueId(db, prop.databaseId);
  const [next] = await db
    .select({ position: databaseProperty.position })
    .from(databaseProperty)
    .where(and(eq(databaseProperty.databaseId, prop.databaseId), sql`${databaseProperty.position} > ${prop.position}`))
    .orderBy(asc(databaseProperty.position))
    .limit(1);
  const options: PropertyOptions = structuredClone(prop.options);
  // The copy links one way and stands for nothing: sub-items keep their one parent property. It
  // keeps its limit to one row and how its linked rows show (lib/relation-options).
  if (options.relation) {
    const { databaseId, single, display, show } = options.relation;
    options.relation = { databaseId, pairedPropertyId: null, ...(single ? { single } : {}), ...(display ? { display } : {}), ...(show ? { show } : {}) };
  }
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
  options: { dryRun?: boolean } = {},
): Promise<{ property: DatabaseProperty; converted: number; cleared: number }> {
  // The property changed between being checked and being locked: check it again as it is now.
  for (let attempt = 1; ; attempt++) {
    try {
      return await retypeProperty(userId, propertyId, input, options);
    } catch (error) {
      if (!(error instanceof PropertyChangedMeanwhile) || attempt === 3) throw error;
    }
  }
}

class PropertyChangedMeanwhile extends Error {
  constructor() {
    super("The property kept changing while its type was being changed; try again");
  }
}

async function retypeProperty(
  userId: string,
  propertyId: string,
  input: TypeChange,
  { dryRun = false }: { dryRun?: boolean },
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
  if (input.type !== "person" && (await loadRowAccess(prop.databaseId)).rules.some((r) => r.kind === "person" && r.propertyId === propertyId)) {
    throw new PropertyValueError(`Row access gives the people of "${prop.name}" access`, "typeChangeNamesPeople", {
      property: prop.name,
    });
  }

  if (input.type === "unique_id") await refuseSecondUniqueId(db, prop.databaseId, prop.id);
  const known = await knownProperties(userId, prop.databaseId);
  const self = { id: prop.id, name: prop.name };
  const formula = input.type === "formula" ? await formulaConfig(userId, input.formula?.expression ?? "", known, self) : undefined;
  const rollup = input.type === "rollup" ? await rollupConfig(userId, input.rollup, known, self) : undefined;
  const target = input.type === "relation" ? await relationTarget(userId, database, input.relation) : null;

  // Read once, outside the transaction: neither depends on the rows' values.
  const targetRows = target
    ? await db
        .select({ id: page.id, title: page.title })
        .from(page)
        .where(and(eq(page.parentId, target.id), eq(page.isTemplate, false), isNull(page.archivedAt), childVisibleTo(userId, target.id)))
    : undefined;
  const properties = isDerived(prop.type) ? await getProperties(prop.databaseId) : [];

  // What the values are now and what they become. Rows are read with `lock` in the transaction
  // that writes them, so a cell saved since can't be overwritten with what an older value became.
  const plan = async (exec: Executor, lock: boolean) => {
    // What the values are now: stored, filled in by Leafdesk, or (formulas, rollups) worked out.
    const query = exec
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
    const rows = await (lock ? query.for("update") : query);
    const visible = new Set(
      (await exec.select({ id: page.id }).from(page).where(and(eq(page.parentId, prop.databaseId), childVisibleTo(userId, prop.databaseId)))).map((r) => r.id),
    );
    // Formulas and rollups are worked out from the rows just read, so from the same cells.
    let derived = new Map<string, unknown>();
    if (isDerived(prop.type)) {
      const read = await withValues(userId, prop.databaseId, rows.filter((r) => visible.has(r.id)), properties);
      derived = new Map(read.map((r) => [r.id, r.properties[propertyId]]));
    }
    const current = (row: (typeof rows)[number]) =>
      isComputed(prop.type)
        ? computedValues([prop], row)[propertyId]
        : isDerived(prop.type)
          ? (derived.get(row.id) ?? null)
          : row.properties[propertyId];
    const values = rows.map(current);

    // People and related rows, as far as the user may see them (read from the rows' values too).
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
    const conversion = planConversion(prop, { type: input.type }, values, { people, sourceTitles, targetRows, yes: input.yes });

    const typeOptions: PropertyOptions = conversion.options
      ? { options: conversion.options }
      : target
        ? { relation: { databaseId: target.id } }
        : formula
        ? { formula: formula.config }
        : rollup
          ? { rollup }
          : {};
    // Whether it shows on row pages, and what it holds, don't depend on the type; the property it
    // depends on only while it is still a select or multi-select (whose options keep their lists).
    const { pageVisibility, pinned, description, dependsOn } = prop.options;
    const kept = canDepend(input.type) && dependsOn ? { dependsOn } : {};
    const typed: PropertyOptions =
      typeOptions.options && !kept.dependsOn ? { ...typeOptions, options: withoutParentOptions(typeOptions.options) } : typeOptions;
    const options: PropertyOptions = {
      ...(description ? { description } : {}),
      ...typed,
      ...kept,
      ...(pageVisibility ? { pageVisibility } : {}),
      ...(pinned ? { pinned } : {}),
    };
    // New values by row id; null removes one. Unticked boxes and types Leafdesk works out store none.
    // A unique ID's rows are numbered when the type changes (drizzle/*_unique_id.sql), and keep
    // their number through the write below.
    const next: Record<string, unknown> = {};
    rows.forEach((row, i) => {
      const value = isReadOnlyType(input.type) ? null : conversion.convert(values[i]);
      const stored = value === false ? null : value;
      if (stored !== null || propertyId in row.properties) next[row.id] = stored;
    });
    // Counted on the rows the user sees: the others aren't theirs to know about.
    const seen = values.filter((_, i) => visible.has(rows[i].id));
    const cleared = lostValues(seen, conversion);
    const converted = isNumbered(input.type)
      ? rows.filter((r) => visible.has(r.id)).length
      : isReadOnlyType(input.type)
        ? 0
        : seen.filter((v) => !isEmptyValue(conversion.convert(v))).length;
    return { options, next, converted, cleared };
  };

  // A preview changes nothing, so it holds up no one.
  if (dryRun) {
    const { options, converted, cleared } = await plan(db, false);
    return { property: { ...prop, type: input.type, options }, converted, cleared };
  }

  const pairedId = prop.type === "relation" ? prop.options.relation?.pairedPropertyId : null;
  const { changed, next, converted, cleared, paired } = await db.transaction(async (tx) => {
    // Held until the change is written, so a second change of the property waits for this one. One
    // made since the checks above makes this one start over from it (see changePropertyType).
    const [locked] = await tx
      .select({ type: databaseProperty.type, updatedAt: databaseProperty.updatedAt, deletedAt: databaseProperty.deletedAt })
      .from(databaseProperty)
      .where(eq(databaseProperty.id, propertyId))
      .for("update");
    if (!locked || locked.deletedAt || locked.type !== prop.type || locked.updatedAt.getTime() !== prop.updatedAt.getTime()) {
      throw new PropertyChangedMeanwhile();
    }
    const { options, next, converted, cleared } = await plan(tx, true);
    const [paired] = pairedId ? await tx.select().from(databaseProperty).where(eq(databaseProperty.id, pairedId)) : [];
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
      .set({ type: input.type, options: relation ? { ...options, relation } : options })
      .where(eq(databaseProperty.id, propertyId))
      .returning();
    // Properties depending on it no longer can: they offer all their options again, with no
    // lists left naming options it no longer has (lib/dependent-options).
    if (canBeParent(prop.type) && !canBeParent(input.type)) {
      const children = (await tx.select().from(databaseProperty).where(eq(databaseProperty.databaseId, prop.databaseId))).filter(
        (p) => p.options.dependsOn === propertyId,
      );
      for (const child of children) {
        const { dependsOn: _parent, ...rest } = child.options;
        await tx
          .update(databaseProperty)
          .set({ options: { ...rest, ...(rest.options ? { options: withoutParentOptions(rest.options) } : {}) } })
          .where(eq(databaseProperty.id, child.id));
      }
    }
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
    return { changed: updated, next, converted, cleared, paired };
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

/** Adds a view with its type's defaults; `config`, when given, goes over them (checked as updateView checks it). */
export async function addView(userId: string, databaseId: string, input: { name: string; type: ViewType; config?: ViewConfig }) {
  if (!isViewType(input.type)) {
    throw new PropertyValueError(`Unsupported view type "${String(input.type)}"`, "unsupportedViewType", {
      type: String(input.type),
    });
  }
  const filterError = input.config && filterConfigError(input.config);
  if (filterError) throw new PropertyValueError(filterError, "invalidFilter");
  const layoutError = input.config && layoutConfigError(input.config);
  if (layoutError) throw new PropertyValueError(layoutError, "invalidViewConfig");
  const database = await requireDatabase(userId, databaseId, "edit");
  assertUnlocked(database);
  // Defaults come from properties the user may know of (see server/property-access).
  const [all, access] = await Promise.all([getProperties(databaseId), propertyAccessFor(userId, databaseId)]);
  const props = access.visible(all);
  const formError = input.config?.form && formSchemaError(input.config.form, props);
  if (formError) throw new PropertyValueError(formError, "invalidViewConfig");
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
  // Maps put rows on the first place property.
  if (input.type === "map") config.placeBy = props.find((p) => p.type === "place")?.id;
  // Charts count rows per option of the property a board would group by, in columns.
  if (input.type === "chart") config.groupBy = chartGroupProperty(props, {})?.id;
  // Forms start out asking for the name and every property a form can ask for.
  if (input.type === "form") config.form = defaultFormConfig(props);
  // Dashboards start with a few widgets over what the maker may see (see lib/dashboard).
  if (input.type === "dashboard") config.widgets = defaultDashboardWidgets(props.filter((p) => !access.valuesHidden().has(p.id)));
  Object.assign(config, input.config);
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

/**
 * A copy of a view with all its settings (layout, filters, sorts, grouping, shown properties, a
 * form's questions, a dashboard's widgets), named `name`, right after it.
 */
export async function duplicateView(userId: string, viewId: string, name: string) {
  const view = await requireView(userId, viewId);
  assertUnlocked(view);
  const created = await addView(userId, view.databaseId, { name: name.trim() || view.name, type: view.type, config: view.config });
  await moveView(userId, created.id, view.id, "after");
  return { ...created, position: view.position + 1 };
}

/** A view the user may change (every caller edits it). */
async function requireView(userId: string, viewId: string, { deleted = false } = {}) {
  const [view] = await db
    .select()
    .from(databaseView)
    .where(and(eq(databaseView.id, viewId), deleted ? isNotNull(databaseView.deletedAt) : isNull(databaseView.deletedAt)));
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
  // A view's icon is an emoji or a built-in icon (lib/icon); anything else leaves it as it was.
  if (patch.config && patch.config.icon !== view.config.icon) {
    const icon = patch.config.icon === undefined || patch.config.icon === "" ? undefined : parseIcon(patch.config.icon);
    if (patch.config.icon && !icon) throw new PropertyValueError(`A view's icon is ${ICON_RULE}`, "invalidIcon");
    const { icon: _icon, ...rest } = patch.config;
    patch = { ...patch, config: icon ? { ...rest, icon } : rest };
  }
  // Filters, sorts and layout stay adjustable on a locked database; renaming (and its icon) doesn't.
  if (patch.name !== undefined || (patch.config && patch.config.icon !== view.config.icon)) assertUnlocked(view);
  const access = await propertyAccessFor(userId, view.databaseId);
  // A form's conditions and choice limits must fit the properties the editor knows of.
  if (patch.config?.form) {
    const formError = formSchemaError(patch.config.form, access.visible(await getProperties(view.databaseId)), view.config.form);
    if (formError) throw new PropertyValueError(formError, "invalidViewConfig");
  }
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
  // What the stored settings say about properties the editor can't know of, or about deleted ones
  // (for a restore), stays as it was, and so do form defaults they can't see.
  const deleted = await deletedPropertyIds(view.databaseId);
  if (patch.config && deleted.size) patch = { ...patch, config: keepDeleted(view.config, patch.config, deleted) };
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
  return { config: access.viewConfig(withoutDeleted(patch.config ?? view.config, deleted)) };
}

/**
 * Deletes a view: its tab goes (and its public form link and calendar feeds stop) until someone
 * restores it (restoreView), deletes it for good (purgeView) or the daily cleanup does, as for
 * deleted properties. A database keeps at least one view.
 */
export async function deleteView(userId: string, viewId: string) {
  const view = await requireView(userId, viewId);
  assertUnlocked(view);
  await db.transaction(async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(databaseView)
      .where(and(eq(databaseView.databaseId, view.databaseId), isNull(databaseView.deletedAt)));
    if (count <= 1) throw withCode(new Error("A database needs at least one view"), "lastView");
    await tx.update(databaseView).set({ deletedAt: new Date(), deletedBy: userId }).where(eq(databaseView.id, viewId));
    await auditView(tx, view.workspaceId, userId, "view.trashed", view);
  });
  notifySchema(view.databaseId);
  notifyTree(view.workspaceId);
}

async function auditView(
  tx: Executor,
  workspaceId: string,
  actorId: string | null,
  action: "view.trashed" | "view.restored" | "view.deleted",
  view: { databaseId: string; name: string; type: ViewType },
) {
  await recordAudit(
    { workspaceId, actorId, action, target: { type: "page", id: view.databaseId }, details: { name: view.name, type: view.type } },
    tx as Parameters<typeof recordAudit>[1],
  );
}

/** A deleted view the user may restore or delete for good: edit access to an unlocked database. */
async function requireDeletedView(userId: string, viewId: string) {
  const view = await requireView(userId, viewId, { deleted: true });
  assertUnlocked(view);
  return view;
}

/** Brings a deleted view back where its tab was, as it was set up. */
export async function restoreView(userId: string, viewId: string) {
  const view = await requireDeletedView(userId, viewId);
  await db.transaction(async (tx) => {
    await tx.update(databaseView).set({ deletedAt: null, deletedBy: null }).where(eq(databaseView.id, viewId));
    await auditView(tx, view.workspaceId, userId, "view.restored", view);
  });
  notifySchema(view.databaseId);
  notifyTree(view.workspaceId);
  return { id: view.id };
}

/** Deletes a deleted view for good, now ("Delete permanently"). */
export async function purgeView(userId: string, viewId: string) {
  const view = await requireDeletedView(userId, viewId);
  await db.transaction(async (tx) => {
    await tx.delete(databaseView).where(eq(databaseView.id, viewId));
    await auditView(tx, view.workspaceId, userId, "view.deleted", view);
  });
  notifySchema(view.databaseId);
}

/** Deletes deleted views for good (the daily cleanup, server/retention). Returns how many went. */
export async function purgeDeletedViews(workspaceId: string, viewIds: string[]) {
  if (!viewIds.length) return 0;
  const views = await db.transaction(async (tx) => {
    const views = await tx
      .delete(databaseView)
      .where(and(inArray(databaseView.id, viewIds), isNotNull(databaseView.deletedAt)))
      .returning();
    for (const view of views) await auditView(tx, workspaceId, null, "view.deleted", view);
    return views;
  });
  for (const databaseId of new Set(views.map((v) => v.databaseId))) notifySchema(databaseId);
  return views.length;
}

/**
 * The deleted properties and views of a database that `userId` may restore (what deleting them
 * took), newest first, and how many days the workspace keeps them (0: until someone deletes them).
 */
export async function listDeletedSchema(userId: string, databaseId: string) {
  const database = await requireDatabase(userId, databaseId, "edit");
  const deleter = alias(user, "deleter");
  const paired = alias(databaseProperty, "paired");
  const [props, views, access, settings] = await Promise.all([
    db
      .select({
        prop: databaseProperty,
        deletedBy: deleter.name,
        pairedName: paired.name,
        pairedDatabaseId: paired.databaseId,
      })
      .from(databaseProperty)
      .leftJoin(deleter, eq(deleter.id, databaseProperty.deletedBy))
      .leftJoin(paired, sql`${paired.id} = ${databaseProperty.options} -> 'relation' ->> 'pairedPropertyId'`)
      .where(and(eq(databaseProperty.databaseId, databaseId), isNotNull(databaseProperty.deletedAt)))
      .orderBy(desc(databaseProperty.deletedAt)),
    db
      .select({ view: databaseView, deletedBy: deleter.name })
      .from(databaseView)
      .leftJoin(deleter, eq(deleter.id, databaseView.deletedBy))
      .where(and(eq(databaseView.databaseId, databaseId), isNotNull(databaseView.deletedAt)))
      .orderBy(desc(databaseView.deletedAt)),
    propertyAccessFor(userId, databaseId, { withDeleted: true }),
    workspaceSettings(database.workspaceId),
  ]);
  const mayChange = (id: string) => {
    try {
      access.requireSchema(id);
      return true;
    } catch {
      return false;
    }
  };
  const properties: DeletedProperty[] = access
    .visible(props.map((r) => ({ ...r, id: r.prop.id })))
    .filter((r) => mayChange(r.id))
    .map(({ prop, deletedBy, pairedName, pairedDatabaseId }) => ({
      id: prop.id,
      name: prop.name,
      type: prop.type,
      deletedAt: prop.deletedAt!,
      deletedBy: deletedBy ?? null,
      // Named only when the relation links the database with itself: another database's
      // properties are that database's to show.
      pairedName: pairedName !== null && pairedDatabaseId === databaseId ? pairedName : null,
    }));
  const deletedViews: DeletedView[] = views.map(({ view, deletedBy }) => ({
    id: view.id,
    name: view.name,
    type: view.type,
    deletedAt: view.deletedAt!,
    deletedBy: deletedBy ?? null,
  }));
  return { properties, views: deletedViews, retentionDays: settings.trashRetentionDays };
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
      .where(and(eq(databaseView.databaseId, view.databaseId), isNull(databaseView.deletedAt)))
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
 * "true" / "false" for checkboxes, a day for dates (the row's date moves there as a whole; the app
 * sends the moved value, worked out in the viewer's zone), null for no value. For list values
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
  const row = await requirePageAccess(userId, rowId, "content");
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
    // The group's value, and the values depending on it that it clears (lib/dependent-options).
    for (const [key, value] of Object.entries(normalized)) {
      if (value === null || value === undefined || (Array.isArray(value) && !value.length)) delete properties[key];
      else properties[key] = value;
    }
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

/**
 * Moves a row right before or after another row of its database (a table row dragged by its
 * handle), in the rows' own order: position, then created time, then id. Rows sharing a position
 * leave no room between them, so when the neighbours tie, the database's rows are numbered again
 * first in that order, which keeps every row where it was (written as raw SQL: renumbering doesn't
 * edit the rows). That takes edit access to the database; without it the row lands on its
 * neighbour's position.
 */
export async function moveRowBeside(userId: string, rowId: string, targetId: string, side: "before" | "after") {
  const row = await requirePageAccess(userId, rowId, "content");
  if (!row.parentId) throw withCode(new Error("Page is not a database row"), "notADatabaseRow");
  const databaseId = row.parentId;
  await requireDatabase(userId, databaseId, "view");
  const order = (
    await db
      .select({ id: page.id, position: page.position })
      .from(page)
      .where(and(eq(page.parentId, databaseId), eq(page.isTemplate, false)))
      .orderBy(asc(page.position), asc(page.createdAt), asc(page.id))
  ).filter((r) => r.id !== rowId);
  const at = order.findIndex((r) => r.id === targetId);
  if (at < 0) throw withCode(new Error("The target is not a row of the same database"), "notADatabaseRow");
  const index = side === "before" ? at : at + 1;
  const between = () => positionBetween(order[index - 1]?.position, order[index]?.position);
  const before = order[index - 1];
  const after = order[index];
  if (before && after && !(before.position < after.position)) {
    const canRenumber = await requireDatabase(userId, databaseId, "content").then(
      () => true,
      () => false,
    );
    if (canRenumber) {
      order.forEach((r, i) => (r.position = i + 1));
      const ids = order.map((r) => r.id);
      await db.execute(sql`
        update page set position = v.position
        from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) with ordinality as v(id, position)
        where page.id = v.id and page.position is distinct from v.position`);
    }
  }
  await db.update(page).set({ position: between(), updatedBy: userId }).where(eq(page.id, rowId));
  notifyRows(databaseId);
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
      outdated: rowOutdated,
      ...(withCovers ? { hasImage: sql<boolean>`${page.contentMarkdown} ~ ${PG_MARKDOWN_IMAGE_PATTERN}` } : {}),
    })
    .from(page)
    .where(
      and(
        eq(page.parentId, databaseId),
        eq(page.isTemplate, false),
        // A trashed database still shows (and exports) the rows that went to the trash with it.
        database.archivedAt ? eq(page.archivedAt, database.archivedAt) : isNull(page.archivedAt),
        childVisibleTo(userId, databaseId),
      ),
    )
    .orderBy(asc(page.position), asc(page.createdAt), asc(page.id));
  const [relations, people, covers, templates, [synced]] = await Promise.all([
    getRelationTargets(userId, properties),
    getPeople(userId, properties),
    withCovers ? rowCovers(stored) : null,
    listRowTemplateSummaries(userId, databaseId),
    db
      .select({
        siteUrl: databaseSync.siteUrl,
        lastRunAt: databaseSync.lastRunAt,
        lastError: databaseSync.lastError,
        enabled: databaseSync.enabled,
      })
      .from(databaseSync)
      .where(eq(databaseSync.databaseId, databaseId)),
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
    /** Where the rows are kept in step from (server/jira-sync), when they are. */
    sync: synced
      ? ({ source: "jira", ...synced, lastRunAt: synced.lastRunAt?.toISOString() ?? null } satisfies DatabaseSyncSummary)
      : null,
    relations,
    people,
    viewerId: userId,
  };
}

/**
 * `uniqueId`: the row's ID as it shows ("TASK-12") when its database has a unique ID property, which
 * pickers find it by too. `values`: the row's values of the properties relations to it show beside
 * its title (RelationConfig `show`), those the viewer may see; `hidden` lists the ones they may not.
 */
export type RelationTargetRow = {
  id: string;
  title: string;
  icon: string | null;
  uniqueId?: string;
  values?: Record<string, unknown>;
  hidden?: string[];
};
export type RelationTarget = {
  /** Null when the related database was deleted or is in the trash. */
  database: { id: string; title: string; icon: string | null } | null;
  /** Name of the paired property on the related database, for two-way relations; null when hidden. */
  pairedName: string | null;
  /** Live rows of the related database, in manual order: link candidates and display titles. */
  rows: RelationTargetRow[];
  /** Properties of the related database, for choosing what a rollup reads; empty when hidden. */
  properties: RelationTargetProperty[];
  /** People the shown values of linked rows name (see getPeople), when they show a person property. */
  people?: PersonRef[];
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
      .where(
        and(
          inArray(page.parentId, targetIds),
          eq(page.isTemplate, false),
          isNull(page.archivedAt),
          or(...targetIds.map((id) => and(eq(page.parentId, id), childVisibleTo(userId, id)))),
        ),
      )
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
  // Rows' IDs (lib/unique-id), by row id, for related databases that number their rows.
  const idOf = new Map<string, string>();
  await Promise.all(
    databases.map(async (d) => {
      const numbered = (targetProperties.get(d.id) ?? []).find((p) => p.type === "unique_id");
      if (!numbered) return;
      const numbers = await db
        .select({ id: page.id, value: sql<unknown>`${page.properties} -> ${numbered.id}::text` })
        .from(page)
        .where(and(eq(page.parentId, d.id), eq(page.isTemplate, false), isNull(page.archivedAt)));
      for (const n of numbers) {
        const shown = formatUniqueId(n.value, uniqueIdPrefix(numbered));
        if (shown) idOf.set(n.id, shown);
      }
    }),
  );
  // Values linked rows show beside their title (lib/relation-options), by related database.
  const shown = new Map(
    await Promise.all(
      databases.map(async (d) => {
        const visible = accessByTarget.get(d.id)!.visible(targetProperties.get(d.id) ?? []);
        const ids = new Set(
          properties.flatMap((p) => (p.type === "relation" && p.options.relation?.databaseId === d.id ? shownPropertyIds(p.options.relation) : [])),
        );
        const props = visible.filter((p) => ids.has(p.id) && showableType(p.type));
        return [d.id, props.length ? await shownValues(userId, d.id, props, accessByTarget.get(d.id)!) : null] as const;
      }),
    ),
  );
  const out: Record<string, RelationTarget> = {};
  for (const prop of properties) {
    const targetId = prop.type === "relation" ? prop.options.relation?.databaseId : undefined;
    if (!targetId) continue;
    const database = databases.find((d) => d.id === targetId) ?? null;
    const values = database ? shown.get(targetId) : null;
    const pairedId = prop.options.relation?.pairedPropertyId;
    out[prop.id] = {
      database,
      // The paired property lives on the related database: named only for those who can see it.
      pairedName: (database && pairedId && paired.find((p) => p.id === pairedId)?.name) || null,
      rows: database
        ? rows.filter((r) => r.parentId === targetId).map(({ id, title, icon }) => ({
            id,
            title,
            icon,
            ...(idOf.has(id) ? { uniqueId: idOf.get(id) } : {}),
            ...values?.rows.get(id),
          }))
        : [],
      ...(values?.people ? { people: values.people } : {}),
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

/**
 * The values of `props` (properties of the related database `databaseId` the viewer may know of)
 * in its rows the viewer can see, for showing beside linked rows' titles, with the values the
 * viewer may not see left out (`hidden`), and the people they name.
 */
async function shownValues(userId: string, databaseId: string, props: DatabaseProperty[], access: PropertyAccess) {
  const stored = props.filter((p) => !isComputed(p.type));
  const found = await db
    .select({
      id: page.id,
      createdBy: page.createdBy,
      updatedBy: page.updatedBy,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      properties: stored.length
        ? sql<Record<string, unknown>>`jsonb_build_object(${sql.join(
            stored.map((p) => sql`${p.id}::text, ${page.properties} -> ${p.id}::text`),
            sql`, `,
          )})`
        : sql<Record<string, unknown>>`'{}'::jsonb`,
    })
    .from(page)
    .where(and(eq(page.parentId, databaseId), eq(page.isTemplate, false), isNull(page.archivedAt), childVisibleTo(userId, databaseId)));
  const rows = new Map<string, Pick<RelationTargetRow, "values" | "hidden">>();
  for (const row of access.strip(
    found.map((r) => ({ ...r, properties: { ...r.properties, ...computedValues(props, r) } })),
  )) {
    const values = Object.fromEntries(Object.entries(row.properties).filter(([, v]) => v !== null && v !== undefined));
    if (Object.keys(values).length || row.hidden?.length) rows.set(row.id, { values, ...(row.hidden?.length ? { hidden: row.hidden } : {}) });
  }
  const people = props.some((p) => holdsPeople(p.type)) ? await getPeople(userId, props) : null;
  return { rows, people };
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
      .where(and(eq(page.parentId, databaseId), childVisibleTo(userId, databaseId))),
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
  for (const config of views.flatMap((view) => configsOf(access.viewConfig(view.config)))) {
    for (const rule of filterRules([...(config.filters ?? []), ...colorRuleFilters(config)])) {
      const person = personProps.some((p) => p.id === rule.propertyId);
      if (!person) continue;
      for (const value of Array.isArray(rule.value) ? rule.value : [rule.value]) {
        if (typeof value === "string" && value !== PERSON_ME) referenced.add(value);
      }
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
  const [database, { level: databaseLevel }] = await Promise.all([
    requireDatabase(userId, row.parentId, "view"),
    pageAccessOf(userId, row.parentId),
  ]);
  const [all, access] = await Promise.all([getProperties(row.parentId), propertyAccessFor(userId, row.parentId)]);
  const properties = access.visible(all);
  const [relations, people] = await Promise.all([getRelationTargets(userId, properties), getPeople(userId, properties)]);
  const [withDerived] = await withValues(userId, row.parentId, [row], properties, { relations, people }, access);
  return {
    databaseId: row.parentId,
    databaseTitle: database.title,
    databaseLocked: Boolean(database.lockedAt),
    /** The viewer may add properties to the database ("Can edit content" changes values only). */
    schemaEditable: hasLevel(databaseLevel, "edit"),
    /** Row pages show the properties beside the body where there is room (lib/row-layout). */
    propertiesBeside: database.propertiesBeside,
    row: {
      id: row.id,
      title: row.title,
      properties: withDerived.properties,
      hidden: withDerived.hidden,
      readOnly: withDerived.readOnly,
      styles: withDerived.styles,
      /** A row template of the database: its values may say "me", "today" or "now" (lib/template-values). */
      template: row.isTemplate,
    },
    properties,
    /** The viewer's level on each restricted property; missing when none is. */
    propertyAccess: access.info(),
    relations,
    people,
    viewerId: userId,
  };
}
