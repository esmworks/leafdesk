"use server";

import { getTranslations } from "next-intl/server";
import type { PropertyType, SelectOption, ViewConfig, ViewType } from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import type { DependencyInput } from "@/lib/dependencies";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import type { PropertyLevel } from "@/lib/property-access";
import { AccessError, pageAccessOf } from "@/server/access";
import { databaseAi } from "@/server/ai-properties";
import * as databases from "@/server/databases";
import { duplicateRows } from "@/server/duplicate";
import { listGroups } from "@/server/groups";
import { getPropertyAccessSettings, loadPropertyRules, setPropertyAccess } from "@/server/property-access";
import { listMembers } from "@/server/workspaces";
import * as pages from "@/server/pages";
import * as templates from "@/server/templates";
import { requireUserId } from "@/server/session";

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
    return { ...snapshot, ...management, ai };
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

export async function createRowAction(
  workspaceId: string,
  databaseId: string,
  input: {
    title?: string;
    properties?: Record<string, unknown>;
    /** Copy this row template of the database (see server/templates.ts). */
    templateId?: string | null;
    /** Start from the database's default row template, when it has one. */
    useDefault?: boolean;
  } = {},
) {
  return run(async (userId) => {
    if (input.templateId || input.useDefault) {
      const created = await templates.createRow({ userId }, databaseId, input);
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

export async function archiveRowsAction(databaseId: string, rowIds: string[]) {
  return run((userId) => pages.archiveRows(userId, databaseId, rowIds));
}

export async function duplicateRowsAction(databaseId: string, rowIds: string[]) {
  return run(async (userId) => {
    const t = await getTranslations("page.header");
    return duplicateRows({ userId }, databaseId, rowIds, t("duplicateSuffix"));
  });
}

export async function moveRowAction(
  rowId: string,
  move: { position?: number; groupBy?: string; groupValue?: string | null; groupFrom?: string | null },
) {
  return run((userId) => databases.moveRow(userId, rowId, move));
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
  },
) {
  return run((userId) => databases.updateProperty(userId, propertyId, patch));
}

export async function ensureOptionAction(propertyId: string, name: string) {
  return run((userId) => databases.ensureOption(userId, propertyId, name));
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

export async function addViewAction(databaseId: string, input: { name: string; type: ViewType }) {
  return run((userId) => databases.addView(userId, databaseId, input));
}

export async function updateViewAction(viewId: string, patch: { name?: string; config?: ViewConfig }) {
  return run((userId) => databases.updateView(userId, viewId, patch));
}

export async function deleteViewAction(viewId: string) {
  return run((userId) => databases.deleteView(userId, viewId));
}

export async function moveViewAction(viewId: string, targetId: string, side: "before" | "after") {
  return run((userId) => databases.moveView(userId, viewId, targetId, side));
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
