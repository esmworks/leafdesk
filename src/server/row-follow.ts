import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { databaseProperty, page, pendingRowUpdate, rowFollower } from "@/db/schema";
import { redactError, redactValue } from "@/lib/redact";
import { changedProperties, readableProperties, storedValue } from "@/lib/row-activity";
import {
  isEmptyRowUpdate,
  mergeRowUpdates,
  parseRowUpdate,
  rowUpdateDueAt,
  visibleRowUpdate,
  type RowUpdate,
} from "@/lib/row-updates";
import { requirePageAccess } from "@/server/access";
import { requestLocale } from "@/server/mail/locale";
import { pageRecipients, recordRowUpdate } from "@/server/notifications";
import { propertyAccessFor } from "@/server/property-access";
import { startSweep } from "@/server/sweep";

/**
 * Following database rows: the people who follow a row hear in their inbox (and by email and push,
 * as they choose) when someone else changes its values, title or body. A row's creator and the
 * people its person properties name follow it, and so does anyone who comments or is mentioned on
 * it (see the `row_follower` table); anyone who can open it may follow or stop following it. Each
 * person's changes wait in `row_update_pending` until they leave the row alone for a while (see
 * lib/row-updates), so a burst of edits is one notification; who follows, who can open the row and
 * which of its properties they may see are worked out when it goes out. Nothing here throws into
 * the write it is about.
 */

/** How often the server looks for row updates that are due. */
const SWEEP_INTERVAL_MS = 5_000;

type Change = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const parent = alias(page, "parent");

/** The row with what deciding who follows it needs; null for pages that aren't database rows (or are templates). */
async function loadRow(rowId: string) {
  const [row] = await db
    .select({
      id: page.id,
      workspaceId: page.workspaceId,
      databaseId: page.parentId,
      createdBy: page.createdBy,
      properties: page.properties,
      archivedAt: page.archivedAt,
      isTemplate: page.isTemplate,
      inTemplate: page.inTemplate,
      parentKind: parent.kind,
    })
    .from(page)
    .innerJoin(parent, eq(parent.id, page.parentId))
    .where(eq(page.id, rowId));
  if (!row?.databaseId || row.parentKind !== "database" || row.isTemplate || row.inTemplate) return null;
  return { ...row, databaseId: row.databaseId };
}

type Row = NonNullable<Awaited<ReturnType<typeof loadRow>>>;

/** Who follows the row: its creator, the people its person properties name and those who chose to, but not those who chose not to. */
async function followersOf(row: Row): Promise<string[]> {
  const [people, chosen] = await Promise.all([
    db
      .select({ id: databaseProperty.id })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.databaseId, row.databaseId), eq(databaseProperty.type, "person"), isNull(databaseProperty.deletedAt))),
    db.select({ userId: rowFollower.userId, following: rowFollower.following }).from(rowFollower).where(eq(rowFollower.rowId, row.id)),
  ]);
  const followers = new Set([...(row.createdBy ? [row.createdBy] : []), ...people.flatMap((p) => ids(row.properties[p.id]))]);
  for (const { userId, following } of chosen) {
    if (following) followers.add(userId);
    else followers.delete(userId);
  }
  return [...followers];
}

/** Whether `userId` follows the row; null for pages that aren't database rows (or are templates), which no one follows. */
export async function isFollowing(userId: string, rowId: string): Promise<boolean | null> {
  const row = await loadRow(rowId);
  return row ? (await followersOf(row)).includes(userId) : null;
}

/**
 * Follows the row or stops following it, for someone who can open it. Choosing not to follow wins
 * over being its creator, assigned or having commented; choosing to follow again undoes that.
 */
export async function setFollowing(userId: string, rowId: string, following: boolean) {
  await requirePageAccess(userId, rowId, "view");
  if (!(await loadRow(rowId))) throw new Error("Page is not a database row");
  await db
    .insert(rowFollower)
    .values({ rowId, userId, following })
    .onConflictDoUpdate({ target: [rowFollower.rowId, rowFollower.userId], set: { following, updatedAt: new Date() } });
  return following;
}

/**
 * The people who commented or were mentioned on a page follow it from now on, when it is a database
 * row, unless they chose not to. Never throws.
 */
export async function followOnTakingPart(rowId: string, userIds: string[]) {
  if (!userIds.length) return;
  try {
    if (!(await loadRow(rowId))) return;
    await db
      .insert(rowFollower)
      .values([...new Set(userIds)].map((userId) => ({ rowId, userId, following: true })))
      .onConflictDoNothing();
  } catch (error) {
    console.error("[row-follow] could not follow a row", redactError(error));
  }
}

/**
 * Adds what `actorId` just changed in a row to what of theirs waits to go out, and moves the time it
 * goes out to a while from now (see lib/row-updates `rowUpdateDueAt`). Never throws.
 */
export async function queueRowUpdate(actorId: string, rowId: string, update: RowUpdate, locale?: string | null) {
  if (isEmptyRowUpdate(update)) return;
  try {
    const now = new Date();
    // Text people type can hold credentials: kept masked, like the row's activity.
    const masked: RowUpdate = {
      body: update.body,
      changes: update.changes.map((c) => ({ ...c, from: redactValue(storedValue(c.from)), to: redactValue(storedValue(c.to)) })),
    };
    const language = locale ?? (await requestLocale());
    await db.transaction(async (tx) => {
      // One merge per row and person at a time: two writes at once would both read the same changes.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:row-update:${rowId}:${actorId}`}))`);
      const [open] = await tx
        .select()
        .from(pendingRowUpdate)
        .where(and(eq(pendingRowUpdate.rowId, rowId), eq(pendingRowUpdate.actorId, actorId)));
      if (!open) {
        await tx.insert(pendingRowUpdate).values({ rowId, actorId, changes: masked, locale: language, firstAt: now, dueAt: rowUpdateDueAt(now, now) });
        return;
      }
      const changes = mergeRowUpdates(parseRowUpdate(open.changes), masked);
      // Changed back to how it was: nothing to tell any more.
      if (isEmptyRowUpdate(changes)) {
        await tx.delete(pendingRowUpdate).where(and(eq(pendingRowUpdate.rowId, rowId), eq(pendingRowUpdate.actorId, actorId)));
        return;
      }
      await tx
        .update(pendingRowUpdate)
        .set({ changes, dueAt: rowUpdateDueAt(open.firstAt, now) })
        .where(and(eq(pendingRowUpdate.rowId, rowId), eq(pendingRowUpdate.actorId, actorId)));
    });
  } catch (error) {
    console.error("[row-follow] could not queue a row update", redactError(error));
  }
}

/**
 * What saved row writes changed, for the rows' followers (see databases.afterRowWrites). New rows
 * tell no one (their creator follows them); AI values, worked out from the row, aren't news of
 * their own. Writes by nobody named (anonymous form answers) have no one to name.
 */
export async function queueRowWrites(actorId: string | null, databaseId: string, changes: Change[]) {
  if (!actorId || !changes.length) return;
  try {
    const properties = await db
      .select({ id: databaseProperty.id, type: databaseProperty.type })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.databaseId, databaseId), isNull(databaseProperty.deletedAt)));
    for (const { rowId, before, after } of changes) {
      const changed = changedProperties(before, after, properties).map((c) => ({
        propertyId: c.propertyId,
        propertyType: c.propertyType,
        from: c.oldValue,
        to: c.newValue,
      }));
      if (changed.length) await queueRowUpdate(actorId, rowId, { changes: changed, body: false });
    }
  } catch (error) {
    console.error("[row-follow] could not queue row writes", redactError(error));
  }
}

/** A save of a row's document by `writers` changed its title (from `before` to `after`) or its body. */
export async function queueRowSave(
  writers: string[],
  rowId: string,
  { before, after, body }: { before: string; after: string; body: boolean },
  locale: string | null,
) {
  if (!writers.length || (before === after && !body)) return;
  // Pages that aren't rows, and row templates, have no followers.
  if (!(await loadRow(rowId).catch(() => null))) return;
  const update: RowUpdate = { changes: before === after ? [] : [{ propertyId: null, propertyType: null, from: before, to: after }], body };
  for (const writer of new Set(writers)) await queueRowUpdate(writer, rowId, update, locale);
}

/**
 * Tells the row's followers but its author what one person's due update changed, each only about
 * the values they may see in the row; someone left with nothing to hear about hears nothing.
 */
async function deliver(pending: typeof pendingRowUpdate.$inferSelect) {
  const row = await loadRow(pending.rowId);
  if (!row || row.archivedAt) return;
  const update = parseRowUpdate(pending.changes);
  if (isEmptyRowUpdate(update)) return;
  const recipients = await pageRecipients(
    (await followersOf(row)).filter((id) => id !== pending.actorId),
    row.id,
  );
  if (!recipients.length) return;
  const properties = await db
    .select({ id: databaseProperty.id, deletedAt: databaseProperty.deletedAt })
    .from(databaseProperty)
    .where(eq(databaseProperty.databaseId, row.databaseId));
  const told: { userId: string; changes: RowUpdate }[] = [];
  for (const userId of recipients) {
    const readable = readableProperties(properties, await propertyAccessFor(userId, row.databaseId), row);
    const changes = visibleRowUpdate(update, readable);
    if (!isEmptyRowUpdate(changes)) told.push({ userId, changes });
  }
  await recordRowUpdate(pending.actorId, row.workspaceId, row.id, told, pending.locale);
}

/** Takes the due updates off the queue (all of them with `everything`) and tells their rows' followers. */
async function deliverDue(everything = false) {
  // Deleting before telling means each goes out at most once, even with two sweeps racing.
  const due = await db
    .delete(pendingRowUpdate)
    .where(everything ? undefined : lte(pendingRowUpdate.dueAt, new Date()))
    .returning();
  for (const entry of due) {
    try {
      await deliver(entry);
    } catch (error) {
      console.error("[row-follow] could not deliver a row update", redactError(error));
    }
  }
}

/** Server only: tells followers about updates as they fall due, including any left from before a restart. */
export function startRowUpdates() {
  return startSweep(SWEEP_INTERVAL_MS, () => deliverDue(), "could not deliver row updates");
}

/** Scripts and tests: deliver everything queued now instead of after the delay. */
export async function flushRowUpdates() {
  await deliverDue(true);
}

/** Scripts and tests: the rows with updates waiting, by row. */
export async function pendingRowUpdates(rowIds: string[]) {
  if (!rowIds.length) return [];
  return db.select().from(pendingRowUpdate).where(inArray(pendingRowUpdate.rowId, rowIds));
}
