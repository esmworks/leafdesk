import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, mailDatabase } from "@/db/schema";
import { atLeast } from "@/lib/property-access";
import { enforceWorkspacePolicy, pageAccessOf } from "@/server/access";
import { propertyAccessFor } from "@/server/property-access";

/**
 * Who sees a row's email: whoever sees the row and the values of the email properties mail is
 * matched on in its database (all its email properties once it is no longer a mail database). The
 * messages carry the other party's address, so they are as private as that value.
 */

export type RowMailAccess = {
  rowId: string;
  databaseId: string;
  workspaceId: string;
  level: "view" | "comment" | "content" | "edit" | "full";
  /** Full access to the database: may hide anyone's message from the row. */
  databaseFull: boolean;
};

/** The emails' row and the user's access to them; null when they may not see them. */
export async function rowMailAccess(userId: string, rowId: string): Promise<RowMailAccess | null> {
  const { page: row, level } = await pageAccessOf(userId, rowId);
  if (!row || level === "none" || !row.parentId || row.archivedAt) return null;
  const databaseId = row.parentId;
  const [matched] = await db.select({ propertyIds: mailDatabase.propertyIds }).from(mailDatabase).where(eq(mailDatabase.databaseId, databaseId));
  const emailProperties = (
    await db
      .select({ id: databaseProperty.id })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.databaseId, databaseId), eq(databaseProperty.type, "email"), isNull(databaseProperty.deletedAt)))
  ).map((p) => p.id);
  const guarded = matched ? matched.propertyIds.filter((id) => emailProperties.includes(id)) : emailProperties;
  if (guarded.length) {
    const access = await propertyAccessFor(userId, databaseId);
    const accessRow = { properties: row.properties ?? {}, createdBy: row.createdBy };
    if (!guarded.every((id) => atLeast(access.levelOf(id, accessRow), "view"))) return null;
  }
  const database = await pageAccessOf(userId, databaseId);
  return { rowId, databaseId, workspaceId: row.workspaceId, level, databaseFull: database.level === "full" };
}

/**
 * rowMailAccess for the person of this request: throws the policy error when a policy of the
 * row's workspace holds back their session (see enforceWorkspacePolicy). What the person reads and
 * writes goes through here; checks on behalf of others and background work use rowMailAccess.
 */
export async function requestRowMailAccess(userId: string, rowId: string): Promise<RowMailAccess | null> {
  const access = await rowMailAccess(userId, rowId);
  if (access) await enforceWorkspacePolicy(userId, access.workspaceId);
  return access;
}

/** Of `userIds`, those who see the row's email. */
export async function seeRowMail(userIds: string[], rowId: string): Promise<string[]> {
  const seen = await Promise.all(userIds.map(async (id) => ((await rowMailAccess(id, rowId)) ? id : null)));
  return seen.filter((id): id is string => !!id);
}
