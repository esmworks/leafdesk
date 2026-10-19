import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, mailDatabase, page, rowEmail } from "@/db/schema";
import { normalizeAddress } from "@/lib/mail";

/**
 * Which row a message belongs on, for the mailbox of `ownerId` (see server/row-mail): the row an
 * earlier message of its thread is on; else the row, in the first of the workspace's mail databases
 * where exactly one does, whose email property holds one of the other party's addresses. Only rows
 * the mailbox's owner sees count, so their mail never lands where they couldn't put it themselves.
 */

export type RowMatch = { rowId: string; databaseId: string };

/** The row a message whose `In-Reply-To`/`References` name these ids belongs on, if any is on one. */
export async function matchThread(workspaceId: string, ownerId: string, messageIds: string[]): Promise<RowMatch | null> {
  if (!messageIds.length) return null;
  const [found] = await db
    .select({ rowId: rowEmail.rowId, databaseId: rowEmail.databaseId })
    .from(rowEmail)
    .innerJoin(page, eq(page.id, rowEmail.rowId))
    .where(
      and(
        eq(rowEmail.workspaceId, workspaceId),
        inArray(rowEmail.messageId, messageIds.slice(0, 100)),
        isNull(page.archivedAt),
        sql`page_access_level(${ownerId}, ${page.id}) > 0`,
      ),
    )
    .orderBy(sql`${rowEmail.sentAt} desc`)
    .limit(1);
  return found ?? null;
}

/** The databases mail is matched to in a workspace, in order, with their email properties still there. */
export async function mailDatabases(workspaceId: string) {
  const rows = await db
    .select({ databaseId: mailDatabase.databaseId, propertyIds: mailDatabase.propertyIds })
    .from(mailDatabase)
    .innerJoin(page, eq(page.id, mailDatabase.databaseId))
    .where(and(eq(mailDatabase.workspaceId, workspaceId), isNull(page.archivedAt)))
    .orderBy(asc(mailDatabase.position), asc(mailDatabase.createdAt));
  if (!rows.length) return [];
  const emailProperties = await db
    .select({ id: databaseProperty.id, databaseId: databaseProperty.databaseId })
    .from(databaseProperty)
    .where(
      and(
        inArray(
          databaseProperty.databaseId,
          rows.map((r) => r.databaseId),
        ),
        eq(databaseProperty.type, "email"),
        isNull(databaseProperty.deletedAt),
      ),
    );
  const live = new Set(emailProperties.map((p) => p.id));
  return rows.map((r) => ({ databaseId: r.databaseId, propertyIds: r.propertyIds.filter((id) => live.has(id)) })).filter((r) => r.propertyIds.length);
}

/**
 * The row of the first mail database where exactly one row the owner sees has one of `addresses`
 * in one of its matched email properties. A database with two such rows is passed over: guessing
 * would put mail on the wrong customer.
 */
export async function matchAddresses(workspaceId: string, ownerId: string, addresses: string[]): Promise<RowMatch | null> {
  const wanted = [...new Set(addresses.map(normalizeAddress).filter((a): a is string => !!a))];
  if (!wanted.length) return null;
  for (const { databaseId, propertyIds } of await mailDatabases(workspaceId)) {
    const holds = sql.join(
      propertyIds.map(
        (id) =>
          sql`lower(regexp_replace(trim(coalesce(${page.properties} ->> ${id}, '')), '^mailto:', '', 'i')) in (${sql.join(
            wanted.map((a) => sql`${a}`),
            sql`, `,
          )})`,
      ),
      sql` or `,
    );
    const rows = await db
      .select({ id: page.id })
      .from(page)
      .where(
        and(
          eq(page.parentId, databaseId),
          eq(page.workspaceId, workspaceId),
          isNull(page.archivedAt),
          eq(page.inTemplate, false),
          eq(page.isTemplate, false),
          sql`(${holds})`,
          sql`page_access_level(${ownerId}, ${page.id}) > 0`,
        ),
      )
      .limit(2);
    if (rows.length === 1) return { rowId: rows[0].id, databaseId };
  }
  return null;
}
