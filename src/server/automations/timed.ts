import { and, count, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "@/db";
import { automationFire, automationRun, databaseAutomation, page } from "@/db/schema";
import {
  DATE_PASSED_BATCH,
  dateCheckIntervalMs,
  datePassedCutoffs,
  statusMatch,
  type AutomationCheckError,
  type DatePassedTrigger,
} from "@/lib/automations";
import { redactError } from "@/lib/redact";
import { getProperties, requireDatabase } from "@/server/databases";
import { startSweep } from "@/server/sweep";
import { kickAutomations, MAX_WAITING_RUNS } from "./queue";

/**
 * "Date passed" automations (lib/automations DatePassedTrigger): every few minutes (ten unless
 * AUTOMATION_DATE_CHECK_SECONDS says otherwise, see dateCheckIntervalMs) a check looks, for each such automation that is on, for the rows of its database whose date is the
 * automation's days past and whose status meets its condition, and queues a run for each of them
 * like a row write does (server/automations/run.ts does the actions). The date's value is kept per
 * row in automation_fire: a row runs once per value, and again only once its date has another
 * value that is past too (it was edited again, say). Rows in the trash, templates and the rows of
 * databases in the trash or in templates are left out; a trashed row keeps its entry, so a restore
 * doesn't run it again for the same date.
 *
 * Rows that already match when an automation is created or turned on run at the next check, at most
 * DATE_PASSED_BATCH a check per automation (the rest at the checks after), within the database's
 * MAX_WAITING_RUNS. The check queues nothing for an automation whose date or status property is
 * deleted, or whose person (who saved it last) lost full access: it says why in `checkError` until a
 * check can look again. One server checks at a time (a session advisory lock, as in retention.ts).
 *
 * Days count by the server's calendar (the day the `now` value of "set properties" gives); times,
 * and when a row was added or last edited, by the clock.
 */

const LOCK = "leafdesk:date-passed-automations";

/** The server's calendar day at `now`, as "set properties" dates `now` (its TZ). */
export const serverDay = (now: Date) => now.toLocaleDateString("en-CA");

type Prop = Awaited<ReturnType<typeof getProperties>>[number];

/** A trigger's properties, checked against the database's live ones: what the query needs, or why it can't run. */
export function resolveDatePassed(trigger: DatePassedTrigger, props: Prop[]) {
  let dateProperty: string | null = null;
  if (trigger.date !== "created_time" && trigger.date !== "last_edited_time") {
    const prop = props.find((p) => p.id === trigger.date);
    if (prop?.type !== "date") return { error: "propertyDeleted" as const };
    dateProperty = prop.id;
  }
  let status: { propertyId: string; match: ReturnType<typeof statusMatch> } | null = null;
  if (trigger.status) {
    const prop = props.find((p) => p.id === trigger.status!.propertyId);
    if (prop?.type !== "status") return { error: "propertyDeleted" as const };
    status = { propertyId: prop.id, match: statusMatch(prop.options.options ?? [], trigger.status.groups) };
  }
  return { error: null, dateProperty, status };
}

type Resolved = Extract<ReturnType<typeof resolveDatePassed>, { error: null }>;

const utc = (column: SQLWrapper) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The value of a row's date a trigger counts from, as text: a date property's start (a day, or a
 * UTC time), or when the row was added or last edited (UTC, to the microsecond). What
 * automation_fire keeps, so it is only ever worked out here.
 */
export function basisSql(trigger: Pick<DatePassedTrigger, "date">): SQL {
  if (trigger.date === "created_time") return utc(page.createdAt);
  if (trigger.date === "last_edited_time") return utc(page.updatedAt);
  return sql`nullif(split_part(${page.properties} ->> ${trigger.date}::text, '/', 1), '')`;
}

const inList = (expr: SQL, values: string[]) => (values.length ? sql`${expr} in ${values}` : sql`false`);

/**
 * The live rows of the database the trigger matches at `now` (see the note at the top), with the
 * value of their date; without those it already ran for at that value when `automationId` is given.
 */
function matching(trigger: DatePassedTrigger, resolved: Resolved, database: { id: string; workspaceId: string }, now: Date, automationId: string | null) {
  const cutoffs = datePassedCutoffs(trigger.days, now, serverDay(now));
  const basis = basisSql(trigger);
  const conditions: SQL[] = [
    sql`${page.workspaceId} = ${database.workspaceId}`,
    sql`${page.parentId} = ${database.id}`,
    sql`${page.archivedAt} is null`,
    sql`not ${page.isTemplate}`,
    sql`not ${page.inTemplate}`,
  ];
  if (resolved.dateProperty === null) {
    const column = trigger.date === "created_time" ? page.createdAt : page.updatedAt;
    conditions.push(sql`${column} <= ${cutoffs.instant}::timestamptz`);
  } else {
    // Days and UTC times compare as text with the cutoffs of their kind.
    conditions.push(sql`(
      (${basis} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${basis} <= ${cutoffs.day})
      or (${basis} like '____-__-__T%' and ${basis} <= ${cutoffs.instant})
    )`);
  }
  if (resolved.status) {
    const value = sql`${page.properties} ->> ${resolved.status.propertyId}::text`;
    const { optionIds, knownIds, empty } = resolved.status.match;
    conditions.push(
      empty ? sql`(${value} is null or not ${inList(value, knownIds)} or ${inList(value, optionIds)})` : inList(value, optionIds),
    );
  }
  if (automationId) {
    conditions.push(sql`not exists (
      select 1 from ${automationFire} f
      where f.automation_id = ${automationId} and f.row_id = ${page.id} and f.basis = ${basis}
    )`);
  }
  return { basis, where: and(...conditions)! };
}

/** How many rows a trigger would run for at the next check (see matching). */
export async function countDatePassedMatches(
  trigger: DatePassedTrigger,
  database: { id: string; workspaceId: string },
  automationId: string | null,
  now = new Date(),
) {
  const resolved = resolveDatePassed(trigger, await getProperties(database.id));
  if (resolved.error) return 0;
  const { where } = matching(trigger, resolved, database, now, automationId);
  const [{ n }] = await db.select({ n: count() }).from(page).where(where);
  return n;
}

/** Forgets the rows an automation ran for: with another date to count from, every row is new to it. */
export async function forgetFired(automationId: string) {
  await db.delete(automationFire).where(eq(automationFire.automationId, automationId));
}

/**
 * After a run's own edit of the row: the row's edited time it ran for becomes that edit's, so an
 * automation counting from the last edit doesn't take its own change for someone else's.
 */
export async function followOwnEdit(automationId: string, rowId: string) {
  await db.execute(sql`
    update ${automationFire} set basis = (select ${basisSql({ date: "last_edited_time" })} from ${page} where ${page.id} = ${rowId})
    where automation_id = ${automationId} and row_id = ${rowId}
  `);
}

type Automation = typeof databaseAutomation.$inferSelect;

async function setCheckError(automation: Automation, error: AutomationCheckError | null) {
  if (automation.checkError === error) return;
  await db.update(databaseAutomation).set({ checkError: error }).where(eq(databaseAutomation.id, automation.id));
}

async function canManage(userId: string | null, databaseId: string) {
  if (!userId) return false;
  try {
    await requireDatabase(userId, databaseId, "full");
    return true;
  } catch {
    return false;
  }
}

/** Queues the runs one automation has due at `now`. Returns how many. */
async function checkAutomation(automation: Automation, database: { id: string; workspaceId: string }, now: Date) {
  const trigger = automation.trigger as DatePassedTrigger;
  const resolved = resolveDatePassed(trigger, await getProperties(database.id));
  if (resolved.error) {
    await setCheckError(automation, resolved.error);
    return 0;
  }
  if (!(await canManage(automation.runAs, database.id))) {
    await setCheckError(automation, "noAccess");
    return 0;
  }
  await setCheckError(automation, null);

  const [{ waiting }] = await db
    .select({ waiting: count() })
    .from(automationRun)
    .innerJoin(databaseAutomation, eq(databaseAutomation.id, automationRun.automationId))
    .where(and(eq(databaseAutomation.databaseId, database.id), inArray(automationRun.status, ["pending", "running"])));
  const room = Math.min(DATE_PASSED_BATCH, MAX_WAITING_RUNS - waiting);
  if (room <= 0) return 0;

  const { basis, where } = matching(trigger, resolved, database, now, automation.id);
  const due = await db
    .select({ rowId: page.id, basis: sql<string>`${basis}` })
    .from(page)
    .where(where)
    .orderBy(sql`${basis}`, page.id)
    .limit(room);
  if (!due.length) return 0;

  // The fire entries and the runs together: a row is either taken for this value of its date, run
  // and all, or left for the next check.
  return db.transaction(async (tx) => {
    const fired = await tx
      .insert(automationFire)
      .values(due.map((r) => ({ automationId: automation.id, rowId: r.rowId, basis: r.basis, firedAt: now })))
      .onConflictDoUpdate({
        target: [automationFire.automationId, automationFire.rowId],
        set: { basis: sql`excluded.basis`, firedAt: sql`excluded.fired_at` },
        setWhere: sql`${automationFire.basis} <> excluded.basis`,
      })
      .returning({ rowId: automationFire.rowId, basis: automationFire.basis });
    if (!fired.length) return 0;
    await tx.insert(automationRun).values(
      fired.map((r) => ({ automationId: automation.id, rowId: r.rowId, actorId: null, created: false, changed: [], basis: r.basis })),
    );
    return fired.length;
  });
}

export type DatePassedOptions = { now?: Date; automationIds?: string[] };

/**
 * One check: queues the runs every "date passed" automation that is on has due at `now`. Returns
 * how many it queued, or null when another server is checking right now. `automationIds` narrows
 * it to some automations (the e2e scripts check only their own).
 */
export async function runDatePassedAutomations({ now = new Date(), automationIds }: DatePassedOptions = {}): Promise<number | null> {
  if (automationIds?.length === 0) return 0;
  const connection = await db.$client.reserve();
  try {
    const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${LOCK})) as locked`;
    if (!row?.locked) return null;
    try {
      const automations = await db
        .select({ automation: databaseAutomation, workspaceId: page.workspaceId })
        .from(databaseAutomation)
        .innerJoin(page, eq(page.id, databaseAutomation.databaseId))
        .where(
          and(
            eq(databaseAutomation.enabled, true),
            sql`${databaseAutomation.trigger} ->> 'type' = 'date_passed'`,
            // A database in the trash or in a template runs nothing; it carries on when restored.
            isNull(page.archivedAt),
            eq(page.inTemplate, false),
            automationIds ? inArray(databaseAutomation.id, automationIds) : undefined,
          ),
        );
      let queued = 0;
      for (const { automation, workspaceId } of automations) {
        try {
          queued += await checkAutomation(automation, { id: automation.databaseId, workspaceId }, now);
        } catch (error) {
          console.error("could not check a date-passed automation", automation.id, redactError(error));
        }
      }
      if (queued) kickAutomations();
      return queued;
    } finally {
      await connection`select pg_advisory_unlock(hashtext(${LOCK}))`;
    }
  } finally {
    connection.release();
  }
}

/** Server only: checks "date passed" automations now and every AUTOMATION_DATE_CHECK_SECONDS. */
export function startDatePassedAutomations() {
  return startSweep(dateCheckIntervalMs(process.env.AUTOMATION_DATE_CHECK_SECONDS), () => runDatePassedAutomations(), "could not check date-passed automations");
}
