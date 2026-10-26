"use server";

import { env } from "@/lib/env";
import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import type { NumberDisplay, NumberFormat, PropertyType, SelectOption, ViewConfig, ViewType } from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import type { DateOptionsInput } from "@/lib/date-options";
import type { RelationOptionsInput } from "@/lib/relation-options";
import { isLocale, TIME_ZONE_COOKIE } from "@/i18n/config";
import type { PageVisibility } from "@/lib/page-visibility";
import type { DependencyInput } from "@/lib/dependencies";
import type { MergeChoices } from "@/lib/merge-rows";
import { LegalHoldError } from "@/lib/legal-hold";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import type { PropertyLevel } from "@/lib/property-access";
import type { RowAccessConfig } from "@/lib/row-access";
import type { PastedRow } from "@/lib/table-clipboard";
import { AccessError, pageAccessOf } from "@/server/access";
import { databaseAi } from "@/server/ai-properties";
import * as calendarFeeds from "@/server/calendar-feeds";
import * as databases from "@/server/databases";
import { duplicateRows } from "@/server/duplicate";
import { listGroups } from "@/server/groups";
import { pasteRows } from "@/server/paste";
import { getPropertyAccessSettings, loadPropertyRules, setPropertyAccess } from "@/server/property-access";
import { getRowAccessSettings, setRowAccess } from "@/server/row-access";
import { listRowActivity } from "@/server/row-activity-feed";
import { listMembers } from "@/server/workspaces";
import { mergeCandidates, mergeRows, previewMerge } from "@/server/merge-rows";
import * as pages from "@/server/pages";
import * as templates from "@/server/templates";
import { requireUserId } from "@/server/session";
import { completeSprint, getSprints, setSprints } from "@/server/sprints";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Translates a domain error for the UI. Errors carry a stable `code` (plus `params`) next to their
 * English message, which stays as-is for MCP clients. Access errors without a code read as "not
 * found or no access"; anything else uncoded falls back to the generic message.
 */
async function errorMessage(error: Error): Promise<string> {
  const t = await getTranslations();
  const { code, params } = error as { code?: unknown; params?: Record<string, string> };
  if (isDatabaseErrorCode(code)) return t(`database.errors.${code}`, params ?? {});
  if (error instanceof AccessError) return t("database.errors.accessDenied");
  return t("common.genericError");
}

// Domain errors (validation, access, plain `new Error(...)` guards) become translated messages;
// driver/query errors are logged and hidden so SQL details never reach the client.
async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    if (
      error instanceof PropertyValueError ||
      error instanceof AccessError ||
      (error instanceof Error && error.constructor === Error)
    ) {
      return { ok: false, error: await errorMessage(error) };
    }
    if (error instanceof LegalHoldError) return { ok: false, error: (await getTranslations("settings.legalHolds.errors"))(error.code) };
    console.error("[database action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

/**
 * Whether the user may change who sees and edits each property (full access to the database), and
 * then which properties have rules: those don't apply to them, so the snapshot doesn't say.
 */
async function propertyAccessManagement(userId: string, databaseId: string, properties: { id: string }[]) {
  const { level } = await pageAccessOf(userId, databaseId);
  if (level !== "full") return { canManageAccess: false, restrictedPropertyIds: [] as string[] };
  const rules = await loadPropertyRules([databaseId]);
  return {
    canManageAccess: true,
    restrictedPropertyIds: properties.filter((p) => rules.get(p.id)?.length).map((p) => p.id),
  };
}

export async function loadDatabaseAction(databaseId: string, options: { covers?: boolean } = {}) {
  return run(async (userId) => {
    const snapshot = await databases.getDatabaseSnapshot(userId, databaseId, { covers: options.covers === true });
    const [ai, management] = await Promise.all([
      databaseAi(databaseId, snapshot.properties, snapshot.rows),
      propertyAccessManagement(userId, databaseId, snapshot.properties),
    ]);
    // Map views draw their map from the server's tile settings (MAP_TILE_URL); null: maps are off.
    return { ...snapshot, ...management, ai, map: env.mapTiles };
  });
}

export async function loadRowAction(rowId: string) {
  return run(async (userId) => {
    const row = await databases.getRow(userId, rowId);
    const [ai, management] = await Promise.all([
      databaseAi(row.databaseId, row.properties, [{ id: rowId, hidden: row.row.hidden }]),
      propertyAccessManagement(userId, row.databaseId, row.properties),
    ]);
    return { ...row, ...management, ai: { enabled: ai.enabled, states: ai.states[rowId] ?? {} } };
  });
}

/** A page of the row's activity, newest first (see server/row-activity-feed). */
export async function loadRowActivityAction(rowId: string, offset = 0, limit = 20) {
  return run((userId) => listRowActivity(userId, rowId, { offset, limit }));
}

export async function createRowAction(
  workspaceId: string,
  databaseId: string,
  input: {
    title?: string;
    properties?: Record<string, unknown>;
    /** Copy this row template of the database (see server/templates.ts). */
    templateId?: string | null;
    /** Start from the default row template of the view (`viewId`) or else the database, when it has one. */
    useDefault?: boolean;
    viewId?: string;
  } = {},
) {
  return run(async (userId) => {
    if (input.templateId || input.useDefault) {
      // A template's "today" is the day on the person's clock (lib/template-values).
      const created = await templates.createRow({ userId }, databaseId, {
        title: input.title,
        properties: input.properties,
        templateId: input.templateId,
        useDefault: input.useDefault,
        viewId: typeof input.viewId === "string" ? input.viewId : undefined,
        timeZone: await cookieTimeZone(),
        // And its "@today" in the title is written in their language.
        locale: await getLocale(),
      });
      return { id: created.id, position: created.position };
    }
    const created = await pages.createPage(
      { userId },
      { workspaceId, parentId: databaseId, title: input.title, properties: input.properties },
    );
    return { id: created.id, position: created.position };
  });
}

/** A row's title from a view; refused, with a message, while the row is locked (lib/page-lock). */
export async function renameRowAction(rowId: string, title: string) {
  return run((userId) => pages.renamePage({ userId }, rowId, title));
}

export async function updateRowPropertiesAction(rowId: string, patch: Record<string, unknown>) {
  return run((userId) => databases.updateRowProperties(userId, rowId, patch));
}

// Bulk row actions skip rows the user may not change and return them (see databases.rowsWithAccess).

export async function updateRowsPropertiesAction(databaseId: string, rowIds: string[], patch: Record<string, unknown>) {
  return run((userId) => databases.updateRowsProperties(userId, databaseId, rowIds, patch));
}

/** Cells pasted into a table: each row's own values, and rows added below the last (see server/paste). */
export async function pasteRowsAction(databaseId: string, input: { updates: (PastedRow & { rowId: string })[]; newRows: PastedRow[] }) {
  return run((userId) => {
    const updates = Array.isArray(input?.updates) ? input.updates : [];
    const newRows = Array.isArray(input?.newRows) ? input.newRows : [];
    if (![...updates, ...newRows].every(isPastedRow) || !updates.every((u) => typeof u.rowId === "string")) {
      throw new Error("Invalid paste");
    }
    return pasteRows({ userId }, databaseId, { updates, newRows });
  });
}

const isPastedRow = (row: PastedRow) =>
  !!row &&
  typeof row === "object" &&
  (row.title === undefined || typeof row.title === "string") &&
  !!row.values &&
  typeof row.values === "object" &&
  !Array.isArray(row.values);

export async function archiveRowsAction(databaseId: string, rowIds: string[]) {
  return run((userId) => pages.archiveRows(userId, databaseId, rowIds));
}

/** Undoes archiveRowsAction: the rows it moved to the trash come back. */
export async function restoreRowsAction(rowIds: string[]) {
  return run(async (userId) => {
    if (!Array.isArray(rowIds)) throw new Error("Invalid rows");
    for (const id of rowIds.map(String)) await pages.restorePage(userId, id);
  });
}

/** "Set icon" and "Remove icon" (null) on selected rows. */
export async function setRowsIconAction(databaseId: string, rowIds: string[], icon: string | null) {
  return run((userId) => {
    if (!Array.isArray(rowIds) || (icon !== null && typeof icon !== "string")) throw new Error("Invalid icon");
    return pages.setRowsIcon(userId, String(databaseId), rowIds.map(String), icon);
  });
}

export async function duplicateRowsAction(databaseId: string, rowIds: string[]) {
  return run((userId) => duplicateRows({ userId }, databaseId, rowIds));
}

/** What merging these rows would bring together (the merge dialog). */
export async function previewMergeAction(rowIds: string[]) {
  return run((userId) => previewMerge(userId, rowIds.map(String)));
}

/** Merges `otherRowIds` into `keptRowId`, with a row (or "combine") for each property. */
export async function mergeRowsAction(input: { keptRowId: string; otherRowIds: string[]; choices?: MergeChoices }) {
  // The body headings the merge writes are in the language the merger's app is in right now.
  const locale = await getLocale();
  return run((userId) =>
    mergeRows(
      { userId },
      { keptRowId: String(input.keptRowId), otherRowIds: input.otherRowIds.map(String), choices: input.choices ?? {} },
      { locale: isLocale(locale) ? locale : undefined },
    ),
  );
}

/** Rows "Merge with…" offers for a row. */
export async function mergeCandidatesAction(rowId: string, query: string) {
  return run((userId) => mergeCandidates(userId, String(rowId), String(query ?? "")));
}

export async function moveRowAction(
  rowId: string,
  move: { position?: number; groupBy?: string; groupValue?: string | null; groupFrom?: string | null },
) {
  return run((userId) => databases.moveRow(userId, rowId, move));
}

/** Moves a row right before or after another row of its database (server/databases moveRowBeside). */
export async function moveRowBesideAction(rowId: string, targetId: string, side: "before" | "after") {
  return run(async (userId) => {
    if (typeof rowId !== "string" || typeof targetId !== "string" || (side !== "before" && side !== "after")) {
      throw new Error("Invalid move");
    }
    return databases.moveRowBeside(userId, rowId, targetId, side);
  });
}

export async function addPropertyAction(
  databaseId: string,
  input: {
    name: string;
    type: PropertyType;
    options?: databases.OptionInput[];
    relation?: databases.RelationInput;
    formula?: { expression: string };
    rollup?: databases.RollupInput;
    number?: NumberFormat | null;
    prefix?: string | null;
  },
) {
  return run(async (userId) => {
    // A new status starts with Not started / In progress / Done in the creator's language.
    if (input.type === "status" && !input.options?.length) {
      const t = await getTranslations("database.page.defaultGroupOptions");
      input = { ...input, options: [t("notStarted"), t("inProgress"), t("done")] };
    }
    return databases.addProperty(userId, databaseId, input);
  });
}

/** Turns sub-items on (with a relation of the database with itself, or new properties) or off. */
export async function setSubItemsAction(databaseId: string, input: { on: boolean; propertyId?: string }) {
  return run(async (userId) => {
    if (!input.on) return databases.setSubItems(userId, databaseId, { on: false });
    // New properties are named in the language of whoever turns sub-items on.
    const t = await getTranslations("database.subItems");
    return databases.setSubItems(userId, databaseId, {
      on: true,
      propertyId: input.propertyId,
      names: { parent: t("parentName"), subItems: t("subItemsName") },
    });
  });
}

/** Turns dependencies on (with a relation of the database with itself, or new properties) or off, or changes their settings. */
export async function setDependenciesAction(
  databaseId: string,
  input: { on: boolean; propertyId?: string; settings?: DependencyInput },
) {
  return run(async (userId) => {
    if (!input.on) return databases.setDependencies(userId, databaseId, { on: false });
    // New properties are named in the language of whoever turns dependencies on.
    const t = await getTranslations("database.dependencies");
    return databases.setDependencies(userId, databaseId, {
      on: true,
      propertyId: input.propertyId,
      settings: input.settings,
      names: { blockedBy: t("blockedByName"), blocking: t("blockingName") },
    });
  });
}

/** Sprints of a task database, or which task database a sprints database belongs to (server/sprints). */
export async function getSprintsAction(databaseId: string) {
  return run((userId) => getSprints(userId, databaseId));
}

/** Turns sprints on (first sprint starting on `start`, a day) or off, or changes how long new sprints are. */
export async function setSprintsAction(databaseId: string, input: { on: boolean; weeks?: number; start?: string }) {
  return run(async (userId) => {
    if (!input.on) return setSprints({ userId }, databaseId, { on: false });
    if (typeof input.weeks !== "number" || (input.start !== undefined && typeof input.start !== "string")) {
      throw new PropertyValueError("A sprint is 1 to 4 weeks long", "invalidSprints");
    }
    return setSprints({ userId }, databaseId, { on: true, weeks: input.weeks, start: input.start });
  });
}

/** Completes the current sprint of a task or sprints database; `dryRun` only says what would change. */
export async function completeSprintAction(databaseId: string, dryRun = false) {
  return run((userId) => completeSprint(userId, databaseId, { dryRun: dryRun === true }));
}

export async function listDatabasesAction(workspaceId: string) {
  return run((userId) => databases.listWorkspaceDatabases(userId, workspaceId));
}

export async function updatePropertyAction(
  propertyId: string,
  patch: {
    name?: string;
    options?: SelectOption[];
    position?: number;
    formula?: { expression: string };
    rollup?: Partial<databases.RollupInput>;
    number?: NumberFormat | null;
    date?: DateOptionsInput;
    pageVisibility?: PageVisibility;
    numberDisplay?: NumberDisplay | null;
    description?: string | null;
    dependsOn?: string | null;
    prefix?: string | null;
    urlPreview?: boolean;
    icon?: string | null;
    relation?: RelationOptionsInput;
    onePerson?: boolean;
    oneRow?: boolean;
    statusDisplay?: "checkbox" | "option";
    unique?: boolean;
  },
) {
  return run((userId) => databases.updateProperty(userId, propertyId, patch));
}

/** Pins a property under its rows' titles, or unpins it (lib/row-layout). */
export async function setPropertyPinnedAction(propertyId: string, pinned: boolean) {
  return run((userId) => databases.setPropertyPinned(userId, String(propertyId), pinned === true));
}

/** Shows the database's row properties beside the row's body, or above it (lib/row-layout). */
export async function setPropertiesBesideAction(databaseId: string, beside: boolean) {
  return run((userId) => databases.setPropertiesBeside(userId, String(databaseId), beside === true));
}

export async function ensureOptionAction(propertyId: string, name: string) {
  return run((userId) => databases.ensureOption(userId, propertyId, name));
}

/** Makes a one-way relation two-way (see databases.makeRelationTwoWay). */
export async function makeRelationTwoWayAction(propertyId: string, pairedName?: string) {
  return run((userId) => databases.makeRelationTwoWay(userId, String(propertyId), typeof pairedName === "string" ? pairedName : undefined));
}

/** Copies a property, its values and its access rules right after it (see databases.duplicateProperty). */
export async function duplicatePropertyAction(propertyId: string, name: string) {
  return run((userId) => databases.duplicateProperty(userId, propertyId, name));
}

/** Changes a property's type and converts its values (see databases.changePropertyType). */
export async function changePropertyTypeAction(propertyId: string, change: databases.TypeChange) {
  return run((userId) => databases.changePropertyType(userId, propertyId, change));
}

export async function deletePropertyAction(propertyId: string) {
  return run((userId) => databases.deleteProperty(userId, propertyId));
}

export async function addViewAction(databaseId: string, input: { name: string; type: ViewType; personal?: boolean }) {
  return run((userId) =>
    databases.addView(userId, databaseId, { name: String(input.name), type: input.type, personal: input.personal === true }),
  );
}

export async function duplicateViewAction(viewId: string, name: string) {
  if (typeof viewId !== "string" || typeof name !== "string") return { ok: false as const, error: "Invalid view" };
  return run((userId) => databases.duplicateView(userId, viewId, name.slice(0, 200)));
}

export async function updateViewAction(viewId: string, patch: { name?: string; config?: ViewConfig; type?: ViewType }) {
  return run((userId) => databases.updateView(userId, viewId, patch));
}

/** Shares a personal view with everyone who may see the database (edit access, see databases.updateView). */
export async function shareViewAction(viewId: string) {
  if (typeof viewId !== "string") return { ok: false as const, error: "Invalid view" };
  return run((userId) => databases.updateView(userId, viewId, { personal: false }));
}

export async function deleteViewAction(viewId: string) {
  return run((userId) => databases.deleteView(userId, viewId));
}

export async function moveViewAction(viewId: string, targetId: string, side: "before" | "after") {
  return run((userId) => databases.moveView(userId, viewId, targetId, side));
}

// Deleted properties and views (see databases.deleteProperty and deleteView): editors of the schema.

/** The deleted properties and views the user may restore, and how long the workspace keeps them. */
export async function loadDeletedSchemaAction(databaseId: string) {
  return run((userId) => databases.listDeletedSchema(userId, databaseId));
}

export async function restorePropertyAction(propertyId: string) {
  return run(async (userId) => {
    const restored = await databases.restoreProperty(userId, propertyId);
    return { id: restored.id, name: restored.name };
  });
}

export async function purgePropertyAction(propertyId: string) {
  return run((userId) => databases.purgeProperty(userId, propertyId));
}

export async function restoreViewAction(viewId: string) {
  return run((userId) => databases.restoreView(userId, viewId));
}

export async function purgeViewAction(viewId: string) {
  return run((userId) => databases.purgeView(userId, viewId));
}

// Property access (see server/property-access.ts): full access to the database only.

/** A property's access for the settings dialog, with the people and groups that can be added. */
export async function loadPropertyAccessAction(propertyId: string) {
  return run(async (userId) => {
    const settings = await getPropertyAccessSettings(userId, propertyId);
    const { workspaceId } = settings;
    // Guests can't list the workspace's people or groups: they only keep the entries already there.
    const noneForGuests = (error: unknown) => {
      if (error instanceof AccessError) return [];
      throw error;
    };
    const [members, groups] = await Promise.all([
      listMembers(userId, workspaceId).catch(noneForGuests),
      listGroups(userId, workspaceId).catch(noneForGuests),
    ]);
    return {
      ...settings,
      members: members.map((m) => ({ id: m.userId, name: m.name, email: m.email, image: avatarSrc(m.image) })),
      groups: groups.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount })),
    };
  });
}

export async function setPropertyAccessAction(
  propertyId: string,
  input: {
    everyone: PropertyLevel | "inherit";
    exceptions: { userId?: string; groupId?: string; personPropertyId?: string; level: PropertyLevel }[];
  },
) {
  return run((userId) => setPropertyAccess(userId, propertyId, input));
}

// Row access (see server/row-access.ts): full access to the database only.

export async function loadRowAccessAction(databaseId: string) {
  return run((userId) => getRowAccessSettings(userId, databaseId));
}

export async function setRowAccessAction(databaseId: string, input: RowAccessConfig) {
  // Checked and narrowed by parseRowAccess against the database's properties.
  return run((userId) => setRowAccess(userId, databaseId, input));
}

/** The browser's time zone, from its cookie (see TimeZoneCookie); unchecked, undefined without one. */
async function cookieTimeZone() {
  return (await cookies()).get(TIME_ZONE_COOKIE)?.value || undefined;
}

/** Whether the workspace allows calendar feeds, and the user's feed of the calendar view. */
export async function getCalendarFeedAction(viewId: string) {
  const timeZone = await cookieTimeZone();
  return run((userId) => calendarFeeds.getCalendarFeed(userId, viewId, timeZone));
}

/** Makes the user a new feed of the calendar view (replacing theirs) and returns its address, shown once. */
export async function createCalendarFeedAction(viewId: string) {
  const timeZone = await cookieTimeZone();
  return run((userId) => calendarFeeds.createCalendarFeed(userId, viewId, timeZone));
}

/** Stops the user's feed of the calendar view. */
export async function deleteCalendarFeedAction(viewId: string) {
  return run((userId) => calendarFeeds.deleteCalendarFeed(userId, viewId));
}

/** Whether the workspace allows calendar feeds, and the user's feed of the rows assigned to them there. */
export async function getAssignedCalendarFeedAction(workspaceId: string) {
  const timeZone = await cookieTimeZone();
  return run((userId) => calendarFeeds.getAssignedCalendarFeed(userId, workspaceId, timeZone));
}

/** Makes the user a new feed of the rows assigned to them in the workspace and returns its address, shown once. */
export async function createAssignedCalendarFeedAction(workspaceId: string) {
  const timeZone = await cookieTimeZone();
  return run((userId) => calendarFeeds.createAssignedCalendarFeed(userId, workspaceId, timeZone));
}

/** Stops the user's feed of the rows assigned to them in the workspace. */
export async function deleteAssignedCalendarFeedAction(workspaceId: string) {
  return run((userId) => calendarFeeds.deleteAssignedCalendarFeed(userId, workspaceId));
}

/** Stops one of the user's feeds from their account's list, whatever it shows. */
export async function deleteOwnCalendarFeedAction(feedId: string) {
  return run((userId) => calendarFeeds.deleteOwnCalendarFeed(userId, feedId));
}
