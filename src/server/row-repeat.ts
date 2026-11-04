import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, databaseSync, databaseView, page, rowActivity, rowRepeat } from "@/db/schema";
import { agendaDoneValue, agendaStatusProperty, isAgendaDone } from "@/lib/agenda";
import { dateDays, shiftDateValue } from "@/lib/date-value";
import { blockedByProperty, blockingProperty, dependencySettings } from "@/lib/dependencies";
import { atLeast } from "@/lib/property-access";
import {
  MAX_REPEATS_PER_DAY,
  nextRepeatValue,
  parseRowRepeatRule,
  skippedRepeatValue,
  type RowRepeatError,
  type RowRepeatView,
} from "@/lib/row-repeat";
import { TODO_BLOCK } from "@/lib/page-tasks";
import { dayString, isTimeZone, localDay } from "@/lib/time-zone";
import { AccessError, requirePageAccess } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { getProperties, notifyRows, updateRowProperties, withCode } from "@/server/databases";
import { duplicatePage } from "@/server/duplicate";
import { archivePage } from "@/server/pages";
import { propertyAccessFor } from "@/server/property-access";

/**
 * Rows that come round again (lib/row-repeat for the rules). A rule sits on one date property of a
 * row (table row_repeat). When the row is marked done (its database's first status, else first
 * checkbox, as an agenda reads it), a copy of it opens beside it with that date moved to the next
 * time, and the rule moves to the copy; the done row stays as the record of that time. Marked
 * not done again while nobody touched the copy, the copy goes to the trash and the rule comes back.
 */

const viewOf = (r: typeof rowRepeat.$inferSelect): RowRepeatView => ({
  propertyId: r.propertyId,
  rule: r.rule,
  timeZone: r.timeZone,
  lastError: r.lastError ?? null,
});

const todayIn = (timeZone: string, now = Date.now()) => dayString(localDay(now, timeZone));

/** The rules of these rows, by row id (rows without one left out). Callers have checked access to the rows. */
export async function rowRepeatsOf(rowIds: string[]): Promise<Record<string, RowRepeatView>> {
  if (!rowIds.length) return {};
  const rows = await db.select().from(rowRepeat).where(inArray(rowRepeat.rowId, rowIds));
  return Object.fromEntries(rows.map((r) => [r.rowId, viewOf(r)]));
}

/** The rules of a database's rows, by row id. Callers have checked access to the database. */
export async function databaseRowRepeats(databaseId: string): Promise<Record<string, RowRepeatView>> {
  const rows = await db.select().from(rowRepeat).where(eq(rowRepeat.databaseId, databaseId));
  return Object.fromEntries(rows.map((r) => [r.rowId, viewOf(r)]));
}

/** The property marking a database's rows done: its first status, else its first checkbox. */
export function doneProperty<P extends Pick<DatabaseProperty, "id" | "type" | "options">>(properties: P[]): P | undefined {
  return agendaStatusProperty({}, properties);
}

/**
 * Checks that `userId` may change how row `rowId` repeats: what changing its date takes (content
 * access to the row, and the date property theirs to change), on a live row of a database that
 * isn't synced from elsewhere and has something to mark rows done with.
 */
async function requireRepeatable(userId: string, rowId: string, propertyId: string) {
  const row = await requirePageAccess(userId, rowId, "content");
  if (!row.parentId) throw withCode(new Error("Page is not a database row"), "notADatabaseRow");
  if (row.archivedAt) throw withCode(new AccessError("The row is in the trash"), "parentInTrash");
  if (row.inTemplate) throw withCode(new Error("Templates don't repeat"), "repeatTemplate");
  const databaseId = row.parentId;
  const properties = await getProperties(databaseId);
  const prop = properties.find((p) => p.id === propertyId);
  if (!prop || prop.type !== "date") throw withCode(new Error("Rows repeat on a date property"), "repeatNotDate");
  if (!doneProperty(properties)) throw withCode(new Error("The database has no status or checkbox to mark rows done"), "repeatNeedsDone");
  const [synced] = await db.select({ id: databaseSync.id }).from(databaseSync).where(eq(databaseSync.databaseId, databaseId)).limit(1);
  if (synced) throw withCode(new Error("Synced databases don't repeat rows"), "repeatSynced");
  const access = await propertyAccessFor(userId, databaseId);
  if (!atLeast(access.levelOf(propertyId, row), "edit")) throw new AccessError();
  return { row, databaseId, prop, properties };
}

export type RowRepeatInput = { propertyId: unknown; rule: unknown; timeZone: unknown };

/**
 * Sets how a row repeats (null: it stops), as `userId` from now on: a copy they may not add is
 * added as them. The rule's anchor is the row's date when it has one, else today.
 */
export async function setRowRepeat(userId: string, rowId: string, input: RowRepeatInput | null): Promise<RowRepeatView | null> {
  if (input === null) {
    const row = await requirePageAccess(userId, rowId, "content");
    const [existing] = await db.select().from(rowRepeat).where(eq(rowRepeat.rowId, rowId));
    if (!existing) return null;
    await requireRepeatable(userId, rowId, existing.propertyId);
    await db.delete(rowRepeat).where(eq(rowRepeat.rowId, rowId));
    if (row.parentId) notifyRows(row.parentId);
    return null;
  }
  if (typeof input.propertyId !== "string") throw withCode(new Error("Rows repeat on a date property"), "repeatNotDate");
  if (!isTimeZone(input.timeZone)) throw withCode(new Error("Unknown time zone"), "invalidRepeat");
  const timeZone = input.timeZone;
  const { row, databaseId } = await requireRepeatable(userId, rowId, input.propertyId);
  const days = dateDays(row.properties[input.propertyId], timeZone);
  const rule = parseRowRepeatRule(input.rule, days ? dayString(days.start) : todayIn(timeZone));
  if (!rule) throw withCode(new Error("Not a repeat rule"), "invalidRepeat");
  const [saved] = await db
    .insert(rowRepeat)
    .values({ rowId, databaseId, propertyId: input.propertyId, rule, timeZone, setBy: userId, chainId: crypto.randomUUID() })
    .onConflictDoUpdate({
      target: rowRepeat.rowId,
      set: { propertyId: input.propertyId, rule, timeZone, setBy: userId, lastError: null },
    })
    .returning();
  notifyRows(databaseId);
  return viewOf(saved);
}

/**
 * "Skip this one": moves the row's date to where its copy would go had it been done today, without
 * a copy. Once the rule has ended (`until`), the date stays and the rule goes. Returns the new date.
 */
export async function skipRowRepeat(userId: string, rowId: string): Promise<string | null> {
  const [rule] = await db.select().from(rowRepeat).where(eq(rowRepeat.rowId, rowId));
  if (!rule) throw withCode(new Error("The row doesn't repeat"), "invalidRepeat");
  const { row, databaseId } = await requireRepeatable(userId, rowId, rule.propertyId);
  const next = skippedRepeatValue(rule.rule, row.properties[rule.propertyId], todayIn(rule.timeZone), rule.timeZone);
  if (next === null) {
    await db.delete(rowRepeat).where(eq(rowRepeat.rowId, rowId));
    notifyRows(databaseId);
    return null;
  }
  await updateRowProperties(userId, rowId, { [rule.propertyId]: next });
  return next;
}

type DatabaseProperty = typeof databaseProperty.$inferSelect;

type Change = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

/**
 * Called after row writes (databases.ts afterRowWrites): rows that became done open their next
 * copy, rows that stopped being done take back the copy they opened while nobody touched it. Runs
 * as the writer; a copy they may not add is added as whoever set the rule. Never throws: the row
 * write has happened either way.
 */
export async function repeatDoneRows(actorId: string, databaseId: string, changes: Change[], now = new Date()) {
  if (!changes.length) return;
  try {
    const ids = changes.map((c) => c.rowId);
    const [rules, taking] = await Promise.all([
      db.select().from(rowRepeat).where(inArray(rowRepeat.rowId, ids)),
      db.select().from(rowRepeat).where(inArray(rowRepeat.previousRowId, ids)),
    ]);
    if (!rules.length && !taking.length) return;
    const properties = await getProperties(databaseId);
    const done = doneProperty(properties);
    if (!done) return;
    const ruleOf = new Map(rules.map((r) => [r.rowId, r]));
    const copyOf = new Map(taking.map((r) => [r.previousRowId!, r]));
    for (const { rowId, before, after } of changes) {
      const was = isAgendaDone(done, before[done.id]);
      const is = isAgendaDone(done, after[done.id]);
      if (!was && is) {
        const rule = ruleOf.get(rowId);
        if (rule) await openNext(actorId, rule, properties, done, now);
      } else if (was && !is) {
        const copy = copyOf.get(rowId);
        if (copy) await takeBack(actorId, rowId, copy, done);
      }
    }
  } catch (error) {
    console.error("[row-repeat] repeating done rows failed", error);
  }
}

/** The date property moving along with `propertyId`: the other end of a dependency or timeline pair. */
async function partnerOf(databaseId: string, propertyId: string, properties: DatabaseProperty[]): Promise<string | null> {
  const by = blockedByProperty(properties);
  if (by) {
    const { start, end } = dependencySettings(by, properties);
    if (start === propertyId && end) return end;
    if (end === propertyId && start) return start;
  }
  const views = await db
    .select({ config: databaseView.config })
    .from(databaseView)
    .where(and(eq(databaseView.databaseId, databaseId), eq(databaseView.type, "timeline"), isNull(databaseView.deletedAt)));
  for (const { config } of views) {
    if (config.dateBy === propertyId && config.endDateBy && config.endDateBy !== propertyId) return config.endDateBy;
    if (config.endDateBy === propertyId && config.dateBy && config.dateBy !== propertyId) return config.dateBy;
  }
  return null;
}

/**
 * The copy's values: the rule's date (and its partner) moved by `shift` days to `next`, done
 * undone, checklists unticked; the other dates, files and dependency links stay with the done
 * row, which they describe.
 */
function copiedValues(
  values: Record<string, unknown>,
  properties: DatabaseProperty[],
  done: DatabaseProperty,
  propertyId: string,
  partner: string | null,
  next: string,
  shift: number,
  timeZone: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  const links = new Set([blockedByProperty(properties)?.id, blockingProperty(properties)?.id].filter(Boolean));
  for (const p of properties) {
    if (!(p.id in out) || p.id === propertyId) continue;
    if (p.type === "date") {
      const moved = p.id === partner ? shiftDateValue(out[p.id], shift, timeZone) : null;
      if (moved) out[p.id] = moved;
      else delete out[p.id];
    } else if (p.type === "files" || links.has(p.id)) delete out[p.id];
    else if (p.type === "checklist" && Array.isArray(out[p.id])) {
      out[p.id] = (out[p.id] as Record<string, unknown>[]).map((item) => ({ ...item, checked: false }));
    }
  }
  out[propertyId] = next;
  const undone = agendaDoneValue(done, false);
  if (undone === null || undone === undefined) delete out[done.id];
  else out[done.id] = undone;
  return out;
}

/** Unticks the to-dos of a body (BlockNote blocks as plain JSON); null when none was ticked. */
export function untickedBlocks(blocks: unknown[]): unknown[] | null {
  let changed = false;
  const walk = (list: unknown[]): unknown[] =>
    list.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] };
      let next = b;
      if (b.type === TODO_BLOCK && b.props?.checked === true) {
        changed = true;
        next = { ...b, props: { ...b.props, checked: false } };
      }
      if (Array.isArray(b.children) && b.children.length) next = { ...next, children: walk(b.children) };
      return next;
    });
  const out = walk(blocks);
  return changed ? out : null;
}

/** What says a copy is as it was opened: its body. */
async function bodyHash(rowId: string): Promise<string | null> {
  const [row] = await db.select({ hash: sql<string>`md5(${page.contentMarkdown})` }).from(page).where(eq(page.id, rowId));
  return row?.hash ?? null;
}

/** Who may add the copy: the writer when they may add rows there, else whoever set the rule, else nobody. */
async function copyAuthor(actorId: string, setBy: string | null, databaseId: string): Promise<string | null> {
  for (const userId of [actorId, setBy]) {
    if (!userId) continue;
    try {
      const database = await requirePageAccess(userId, databaseId, "content");
      if (!database.archivedAt) return userId;
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
    }
  }
  return null;
}

async function noteError(rowId: string, error: RowRepeatError | null) {
  await db.update(rowRepeat).set({ lastError: error }).where(eq(rowRepeat.rowId, rowId));
}

/** Opens the copy of a row that was just marked done, and moves its rule there. */
async function openNext(actorId: string, rule: typeof rowRepeat.$inferSelect, properties: DatabaseProperty[], done: DatabaseProperty, now: Date) {
  const { rowId, databaseId, propertyId, timeZone } = rule;
  if (!properties.some((p) => p.id === propertyId && p.type === "date")) return;
  const [row] = await db
    .select({ title: page.title, properties: page.properties, archivedAt: page.archivedAt, inTemplate: page.inTemplate })
    .from(page)
    .where(eq(page.id, rowId));
  if (!row || row.archivedAt || row.inTemplate) return;
  const today = todayIn(timeZone, now.getTime());
  const count = rule.spawnDay === today ? rule.spawnCount : 0;
  if (count >= MAX_REPEATS_PER_DAY) return noteError(rowId, "tooMany");
  const next = nextRepeatValue(rule.rule, row.properties[propertyId], today, today, timeZone);
  if (next === null) {
    // Past its last day: the rule has ended.
    await db.delete(rowRepeat).where(eq(rowRepeat.rowId, rowId));
    notifyRows(databaseId);
    return;
  }
  const author = await copyAuthor(actorId, rule.setBy, databaseId);
  if (!author) return noteError(rowId, "accessLost");

  // Claimed first: of two writes marking the row done at once, only the one that takes the rule
  // opens a copy.
  const [claimed] = await db.delete(rowRepeat).where(eq(rowRepeat.rowId, rowId)).returning();
  if (!claimed) return;
  const base = dateDays(row.properties[propertyId], timeZone);
  const shift = base ? dateDays(next, timeZone)!.start - base.start : 0;
  const partner = await partnerOf(databaseId, propertyId, properties);
  const actor: WriteActor = { userId: author };
  let copyId: string;
  try {
    ({ id: copyId } = await duplicatePage(actor, rowId, {
      title: row.title,
      values: (copied) => copiedValues(copied, properties, done, propertyId, partner, next, shift, timeZone),
    }));
  } catch (error) {
    // The rule goes back: nothing was opened.
    await db.insert(rowRepeat).values({ ...claimed, lastError: "accessLost" }).onConflictDoNothing();
    throw error;
  }
  try {
    await getCollab().transformBlocks(copyId, untickedBlocks, actor);
  } catch (error) {
    console.error("[row-repeat] unticking a copy's to-dos failed", error);
  }
  await db
    .insert(rowRepeat)
    .values({
      rowId: copyId,
      databaseId,
      propertyId,
      rule: claimed.rule,
      timeZone,
      setBy: claimed.setBy,
      chainId: claimed.chainId,
      previousRowId: rowId,
      madeHash: await bodyHash(copyId),
      spawnDay: today,
      spawnCount: count + 1,
    })
    .onConflictDoNothing();
  notifyRows(databaseId);
}

/**
 * A row marked not done again takes back the copy it opened, while that is still as it was opened:
 * not done, its body unchanged and no value of it changed by a person. The copy goes to the trash
 * and the rule comes back to the row.
 */
async function takeBack(actorId: string, rowId: string, copy: typeof rowRepeat.$inferSelect, done: DatabaseProperty) {
  const [row] = await db
    .select({ properties: page.properties, archivedAt: page.archivedAt })
    .from(page)
    .where(eq(page.id, copy.rowId));
  if (!row || row.archivedAt || isAgendaDone(done, row.properties[done.id])) return;
  if (copy.madeHash === null || (await bodyHash(copy.rowId)) !== copy.madeHash) return;
  const [edited] = await db
    .select({ id: rowActivity.id })
    .from(rowActivity)
    .where(and(eq(rowActivity.rowId, copy.rowId), ne(rowActivity.actorKind, "automation")))
    .limit(1);
  if (edited) return;
  let trashed = false;
  for (const userId of [actorId, copy.setBy]) {
    if (!userId || trashed) continue;
    try {
      await archivePage(userId, copy.rowId);
      trashed = true;
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
    }
  }
  if (!trashed) return;
  await db.transaction(async (tx) => {
    const [moved] = await tx.delete(rowRepeat).where(eq(rowRepeat.rowId, copy.rowId)).returning();
    if (!moved) return;
    await tx
      .insert(rowRepeat)
      .values({ ...moved, rowId, previousRowId: null, madeHash: null, spawnCount: Math.max(0, moved.spawnCount - 1), lastError: null })
      .onConflictDoNothing();
  });
  notifyRows(copy.databaseId);
}
