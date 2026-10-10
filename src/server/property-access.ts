import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  databaseProperty,
  memberGroup,
  memberGroupMember,
  page,
  propertyPermission,
  user,
} from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import { intersectAccess, makeAccess, OPEN_ACCESS, type AccessRow, type PropertyAccess } from "@/lib/property-access-rows";
import {
  atLeast,
  canRestrict,
  isPropertyLevel,
  namesPeople,
  PERSON_RULE_LEVELS,
  type DatabaseLevel,
  type PropertyLevel,
  type PropertyRule,
  type PropertyViewer,
} from "@/lib/property-access";
import { PropertyValueError } from "@/lib/properties";
import type { PropertyType } from "@/lib/property-types";
import { accessRank, AccessError, getMembership, levelFromRank, peopleWithFullAccess, requirePageAccess } from "@/server/access";
import { actingFor } from "@/server/acting-for";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { loadProperties } from "@/server/derived";


export {
  hideReferences,
  makeAccess,
  OPEN_ACCESS,
  restoreReferences,
  unknownProperties,
  type AccessRow,
  type PropertyAccess,
  type RedactedFields,
} from "@/lib/property-access-rows";

/**
 * Rules that hold now: not those of a deleted property, nor exceptions naming the people of a
 * deleted person property (the rows still hold its values, for a restore). Both apply again once
 * the property is restored.
 */
const ruleHolds = sql`not exists (
  select 1 from ${databaseProperty}
  where ${databaseProperty.id} in (${propertyPermission.propertyId}, ${propertyPermission.personPropertyId})
    and ${databaseProperty.deletedAt} is not null
)`;

/**
 * Every rule of these databases, by property id. `withDeleted` takes in the rules that don't hold
 * while a property is deleted (see ruleHolds), for deciding who may see and restore it.
 */
export async function loadPropertyRules(databaseIds: string[], withDeleted = false): Promise<Map<string, PropertyRule[]>> {
  const out = new Map<string, PropertyRule[]>();
  if (!databaseIds.length) return out;
  const rows = await db
    .select({
      propertyId: propertyPermission.propertyId,
      userId: propertyPermission.userId,
      groupId: propertyPermission.groupId,
      personPropertyId: propertyPermission.personPropertyId,
      level: propertyPermission.level,
    })
    .from(propertyPermission)
    .where(and(inArray(propertyPermission.databaseId, databaseIds), withDeleted ? undefined : ruleHolds));
  for (const rule of rows) out.set(rule.propertyId, [...(out.get(rule.propertyId) ?? []), rule]);
  return out;
}

/** Whether any property of the database has rules: one index lookup. */
async function hasRules(databaseId: string, withDeleted = false) {
  const [row] = await db
    .select({ id: propertyPermission.id })
    .from(propertyPermission)
    .where(and(eq(propertyPermission.databaseId, databaseId), withDeleted ? undefined : ruleHolds))
    .limit(1);
  return Boolean(row);
}

/** The groups someone is in, in the database's workspace, and their access to the database. */
async function loadViewer(userId: string, databaseId: string, databaseLevel?: DatabaseLevel): Promise<PropertyViewer> {
  const [groups, level] = await Promise.all([
    db
      .select({ id: memberGroupMember.groupId })
      .from(memberGroupMember)
      .innerJoin(page, eq(page.workspaceId, memberGroupMember.workspaceId))
      .where(and(eq(page.id, databaseId), eq(memberGroupMember.userId, userId))),
    databaseLevel
      ? Promise.resolve(databaseLevel)
      : db
          .execute<{ level: number }>(sql`select ${accessRank(userId, sql`${databaseId}`)} as level`)
          .then((rows) => levelFromRank(rows[0]?.level)),
  ]);
  return { userId, groupIds: groups.map((g) => g.id), databaseLevel: level };
}

type AssignmentChange = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

const personIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The changes as far as the people they name may hear of them: someone who can't see a person
 * property's values in a row is left out of it before and after, so neither the inbox nor an email
 * tells them about a value hidden from them (and their unread notices aren't taken back either).
 */
export async function assignmentsTheySee<C extends AssignmentChange>(databaseId: string, personPropertyIds: string[], changes: C[]): Promise<C[]> {
  const rules = await loadPropertyRules([databaseId]);
  const restricted = personPropertyIds.filter((id) => rules.has(id));
  if (!restricted.length || !changes.length) return changes;
  const creators = new Map(
    (await db.select({ id: page.id, createdBy: page.createdBy }).from(page).where(inArray(page.id, changes.map((c) => c.rowId)))).map((r) => [r.id, r.createdBy]),
  );
  const accessOf = new Map<string, Promise<PropertyAccess>>();
  const access = (userId: string) => {
    let found = accessOf.get(userId);
    if (!found) accessOf.set(userId, (found = propertyAccessFor(userId, databaseId)));
    return found;
  };
  return Promise.all(
    changes.map(async (c) => {
      const row = { properties: c.after, createdBy: creators.get(c.rowId) ?? null };
      const before = { ...c.before };
      const after = { ...c.after };
      for (const propertyId of restricted) {
        for (const userId of new Set([...personIds(c.before[propertyId]), ...personIds(c.after[propertyId])])) {
          if (atLeast((await access(userId)).levelOf(propertyId, row), "view")) continue;
          before[propertyId] = personIds(before[propertyId]).filter((id) => id !== userId);
          after[propertyId] = personIds(after[propertyId]).filter((id) => id !== userId);
        }
      }
      return { ...c, before, after };
    }),
  );
}

/** Whether `userId` sees the values of this property in this row (for notices sent later). */
export async function seesValue(userId: string, databaseId: string, propertyId: string, row: AccessRow) {
  return atLeast((await propertyAccessFor(userId, databaseId)).levelOf(propertyId, row), "view");
}

/**
 * `userId`'s access to the properties of a database (null: an anonymous visitor of a published
 * page, who gets what the entries for everyone allow). Works from all of the database's
 * properties, whatever list the caller holds, so a shorter list never lets a value through.
 */
export async function propertyAccessFor(
  userId: string | null,
  databaseId: string,
  options: {
    databaseLevel?: DatabaseLevel;
    /**
     * Deleted properties count too, with the rules they had: who may see a deleted property in the
     * list of deleted ones, and restore it, is who could see and change it before.
     */
    withDeleted?: boolean;
  } = {},
): Promise<PropertyAccess> {
  const withDeleted = options.withDeleted ?? false;
  if (!(await hasRules(databaseId, withDeleted))) return OPEN_ACCESS;
  const [rules, viewer, properties] = await Promise.all([
    loadPropertyRules([databaseId], withDeleted),
    userId
      ? loadViewer(userId, databaseId, options.databaseLevel)
      : Promise.resolve<PropertyViewer>({ userId: "", groupIds: [], databaseLevel: "view" }),
    withDeleted
      ? db.select().from(databaseProperty).where(eq(databaseProperty.databaseId, databaseId))
      : loadProperties([databaseId]).then((all) => all.get(databaseId) ?? []),
  ]);
  const access = makeAccess(rules, viewer, properties);
  // An agent working for a member gets only what that member may as well (acting-for.ts).
  const forUserId = userId ? actingFor(userId) : null;
  return forUserId ? intersectAccess(access, await propertyAccessFor(forUserId, databaseId, { withDeleted })) : access;
}

export type PropertyRuleInput = {
  /** Everyone with access to the database: "inherit" follows it, removing the restriction. */
  everyone: PropertyLevel | "inherit";
  exceptions: { userId?: string; groupId?: string; personPropertyId?: string; level: PropertyLevel }[];
};

/** Checks a property's new access against the database (who and what an exception may name). */
export async function validateRules(
  prop: { id: string; type: PropertyType; databaseId: string; name: string },
  workspaceId: string,
  input: PropertyRuleInput,
) {
  if (!canRestrict(prop.type)) {
    throw new PropertyValueError(`"${prop.name}" can't be restricted`, "cannotRestrict", { property: prop.name });
  }
  if (input.everyone !== "inherit" && !isPropertyLevel(input.everyone)) throw new PropertyValueError("Unknown access level", "cannotRestrict");
  const seen = new Set<string>();
  for (const e of input.exceptions) {
    const principals = [e.userId, e.groupId, e.personPropertyId].filter(Boolean);
    if (principals.length !== 1 || !isPropertyLevel(e.level)) throw new PropertyValueError("Bad exception", "cannotRestrict");
    const key = principals[0]!;
    if (seen.has(key)) throw new PropertyValueError("Repeated exception", "cannotRestrict");
    seen.add(key);
    if (e.personPropertyId && !PERSON_RULE_LEVELS.includes(e.level)) throw new PropertyValueError("Bad level for a person property", "cannotRestrict");
  }
  const personIds = input.exceptions.flatMap((e) => (e.personPropertyId ? [e.personPropertyId] : []));
  if (personIds.length) {
    const found = await db
      .select({ id: databaseProperty.id, type: databaseProperty.type })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.databaseId, prop.databaseId), inArray(databaseProperty.id, personIds), isNull(databaseProperty.deletedAt)));
    if (found.length !== personIds.length || found.some((p) => !namesPeople(p.type))) {
      throw new PropertyValueError("An exception names a property that isn't a person property of this database", "cannotRestrict");
    }
  }
  const userIds = input.exceptions.flatMap((e) => (e.userId ? [e.userId] : []));
  const groupIds = input.exceptions.flatMap((e) => (e.groupId ? [e.groupId] : []));
  return { userIds, groupIds, workspaceId };
}

const personProperty = alias(databaseProperty, "person_property");

/** One entry of a property's access as the settings dialog shows it. */
export type PropertyAccessEntry =
  | { kind: "user"; id: string; name: string; email: string | null; image: string | null; level: PropertyLevel }
  | { kind: "group"; id: string; name: string; level: PropertyLevel }
  | { kind: "person"; id: string; name: string; level: PropertyLevel };

export type PropertyAccessSettings = {
  everyone: PropertyLevel | "inherit";
  exceptions: PropertyAccessEntry[];
  /** The database's workspace: whose people and groups exceptions can name. */
  workspaceId: string;
  /**
   * The others with full access to the database, whom no rule holds (the viewer has it too): how
   * many, and the names of the first few.
   */
  fullAccess: { count: number; names: string[] };
};

/** How many names of those with full access the dialog shows. */
const FULL_ACCESS_NAMES = 3;

/** A property and its database, for someone with full access to the database. */
async function requireRestrictable(actorId: string, propertyId: string) {
  const [prop] = await db
    .select()
    .from(databaseProperty)
    .where(and(eq(databaseProperty.id, propertyId), isNull(databaseProperty.deletedAt)));
  if (!prop) throw new AccessError();
  const database = await requirePageAccess(actorId, prop.databaseId, "full");
  if (database.kind !== "database") throw new AccessError();
  return { prop, database };
}

/** A property's access, for the settings dialog. Needs full access to the database. */
export async function getPropertyAccessSettings(actorId: string, propertyId: string): Promise<PropertyAccessSettings> {
  const { database } = await requireRestrictable(actorId, propertyId);
  const rules = await db
    .select({
      userId: propertyPermission.userId,
      groupId: propertyPermission.groupId,
      personPropertyId: propertyPermission.personPropertyId,
      level: propertyPermission.level,
      userName: user.name,
      email: user.email,
      image: user.image,
      groupName: memberGroup.name,
      propertyName: personProperty.name,
    })
    .from(propertyPermission)
    .leftJoin(user, eq(user.id, propertyPermission.userId))
    .leftJoin(memberGroup, eq(memberGroup.id, propertyPermission.groupId))
    .leftJoin(personProperty, eq(personProperty.id, propertyPermission.personPropertyId))
    .where(eq(propertyPermission.propertyId, propertyId))
    .orderBy(propertyPermission.createdAt);
  const everyone = rules.find((r) => !r.userId && !r.groupId && !r.personPropertyId)?.level ?? "inherit";
  const exceptions = rules.flatMap((r): PropertyAccessEntry[] => {
    if (r.userId) {
      return [{ kind: "user", id: r.userId, name: r.userName ?? "", email: r.email, image: avatarSrc(r.image), level: r.level }];
    }
    if (r.groupId) return [{ kind: "group", id: r.groupId, name: r.groupName ?? "", level: r.level }];
    if (r.personPropertyId) return [{ kind: "person", id: r.personPropertyId, name: r.propertyName ?? "", level: r.level }];
    return [];
  });
  const full = await peopleWithFullAccess(database.workspaceId, database.id, actorId);
  const named = full.length
    ? await db
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(inArray(user.id, full))
        .orderBy(user.name)
        .limit(FULL_ACCESS_NAMES)
    : [];
  return {
    everyone,
    exceptions,
    workspaceId: database.workspaceId,
    fullAccess: { count: full.length, names: named.map((u) => u.name || u.email) },
  };
}

/**
 * Replaces a property's access. Needs full access to the database. "inherit" for everyone drops
 * every entry: the property follows the database again (exceptions only ever raise a level, so
 * they mean nothing without a lower one for everyone).
 */
export async function setPropertyAccess(actorId: string, propertyId: string, input: PropertyRuleInput) {
  const { prop, database } = await requireRestrictable(actorId, propertyId);
  const { userIds, groupIds } = await validateRules(prop, database.workspaceId, input);
  if (userIds.length) {
    const memberships = await Promise.all([...new Set(userIds)].map((id) => getMembership(id, database.workspaceId)));
    if (memberships.some((m) => !m)) {
      throw new PropertyValueError("Exceptions can only name people of the workspace", "cannotRestrict");
    }
  }
  if (groupIds.length) {
    const groups = await db
      .select({ id: memberGroup.id })
      .from(memberGroup)
      .where(and(eq(memberGroup.workspaceId, database.workspaceId), inArray(memberGroup.id, groupIds)));
    if (groups.length !== new Set(groupIds).size) throw new PropertyValueError("Unknown group", "cannotRestrict");
  }
  const before = await getPropertyAccessSettings(actorId, propertyId);
  const entries =
    input.everyone === "inherit"
      ? []
      : [
          { userId: null, groupId: null, personPropertyId: null, level: input.everyone },
          ...input.exceptions.map((e) => ({
            userId: e.userId ?? null,
            groupId: e.groupId ?? null,
            personPropertyId: e.personPropertyId ?? null,
            level: e.level,
          })),
        ];
  await db.transaction(async (tx) => {
    await tx.delete(propertyPermission).where(eq(propertyPermission.propertyId, propertyId));
    if (entries.length) {
      await tx.insert(propertyPermission).values(
        entries.map((e) => ({
          ...e,
          propertyId,
          databaseId: prop.databaseId,
          workspaceId: database.workspaceId,
          createdBy: actorId,
        })),
      );
    }
    await recordAudit(
      {
        workspaceId: database.workspaceId,
        actorId,
        action: "property.access_changed",
        target: { type: "page", id: prop.databaseId },
        details: {
          property: prop.name,
          everyone: input.everyone,
          previous: before.everyone,
          exceptions: input.everyone === "inherit" ? 0 : input.exceptions.length,
        },
      },
      tx,
    );
  });
  await afterRulesChanged(prop.databaseId);
}

/** Everyone looking at the database reloads it; search forgets what it may no longer show. */
async function afterRulesChanged(databaseId: string) {
  const collab = getCollab();
  collab.broadcast(`db:${databaseId}`, "schema");
  collab.broadcast(`db:${databaseId}`, "rows");
  // Semantic search keeps no values of restricted properties (semantic-index restrictedProperties):
  // the rows' chunks are rebuilt under the new rules. Imported here: semantic-index reaches this
  // module through databases.
  const { reindexDatabaseRows } = await import("@/server/semantic-index");
  await reindexDatabaseRows(databaseId);
}
