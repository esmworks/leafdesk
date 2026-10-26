import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, automationThreshold, databaseAutomation, page } from "@/db/schema";
import {
  dateCheckIntervalMs,
  thresholdFires,
  thresholdMet,
  thresholdValue,
  type AutomationCheckError,
  type ThresholdTrigger,
} from "@/lib/automations";
import { chartAggregateFunctionsOf, measureRows, type ChartMeasure } from "@/lib/chart";
import { valueType } from "@/lib/derived";
import { redactError } from "@/lib/redact";
import { AccessError } from "@/server/access";
import { getDatabase, requireDatabase, viewedRows } from "@/server/databases";
import { startSweep } from "@/server/sweep";
import { kickAutomations, onThresholdRows } from "./queue";
import { automationZone } from "./timed";

/**
 * Threshold automations (lib/automations ThresholdTrigger): a calculation over the rows a view of
 * the database shows, worked out as the automation's person (who published it last) sees them: the
 * rows and values they may see, the view's filters with "today" in the automation's time zone.
 * automation_threshold keeps whether the value was past the line at the last check, and a check
 * that finds it past the line when it wasn't queues a run without a row, with the value in its
 * trigger data. So it starts once per crossing, and again only after the value came back.
 *
 * Publishing (with another view, calculation or line) and turning it on note where the value
 * stands without a run: what is already past the line then isn't news. Rows written, trashed or
 * restored ask for a check of their database's thresholds a moment later (queue.ts
 * thresholdRowsChanged; an automation's own writes don't); every check interval of "date passed"
 * automations (AUTOMATION_DATE_CHECK_SECONDS) looks at all of them, for values that change with the
 * day (filters on "today", formulas over it) or in other databases (rollups). One check of an
 * automation at a time (a transaction-level advisory lock), so two can't both take one crossing.
 */

type Automation = typeof databaseAutomation.$inferSelect;

/** A trigger's value as `userId` sees it, or why it can't be worked out. */
export type ThresholdReading =
  | { error: AutomationCheckError }
  | { error: null; value: number | null; view: { id: string; name: string }; property: { id: string; name: string } | null };

/** The calculation over the view's rows, as `userId` sees them, at `now` with days in `timeZone`. */
export async function readThreshold(
  userId: string,
  databaseId: string,
  trigger: ThresholdTrigger,
  { now = new Date(), timeZone = "UTC" }: { now?: Date; timeZone?: string } = {},
): Promise<ThresholdReading> {
  let found: Awaited<ReturnType<typeof getDatabase>>;
  try {
    found = await getDatabase(userId, databaseId);
  } catch (error) {
    if (error instanceof AccessError) return { error: "noAccess" };
    throw error;
  }
  // Only a shared view: a personal one is gone for whoever publishes it next.
  const view = found.views.find((v) => v.id === trigger.viewId && v.ownerId === null);
  if (!view) return { error: "viewDeleted" };
  let measure: ChartMeasure = { kind: "count" };
  let property: { id: string; name: string } | null = null;
  if (trigger.fn !== "count_all") {
    const prop = found.properties.find((p) => p.id === trigger.propertyId);
    if (!prop || !chartAggregateFunctionsOf(prop).includes(trigger.fn)) return { error: "propertyDeleted" };
    measure = { kind: "aggregate", fn: trigger.fn, prop: { id: prop.id, type: valueType(prop), options: prop.options } };
    property = { id: prop.id, name: prop.name };
  }
  const rows = await viewedRows(
    userId,
    databaseId,
    { filters: view.config.filters, filterCombinator: view.config.filterCombinator },
    undefined,
    { now, timeZone: automationZone(timeZone) },
  );
  const result = measureRows(rows, measure);
  const value = result?.format === "number" ? thresholdValue(trigger.fn, result.value) : null;
  return { error: null, value, view: { id: view.id, name: view.name }, property };
}

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

/**
 * Checks one threshold automation at `now`: notes where its value stands, and queues a run when it
 * crossed the line since the last check. `quiet` only notes it (publishing, turning on). Returns
 * whether it queued a run.
 */
async function checkAutomation(automation: Automation, now: Date, quiet: boolean) {
  const trigger = automation.trigger as ThresholdTrigger;
  if (!(await canManage(automation.runAs, automation.databaseId))) {
    await setCheckError(automation, "noAccess");
    return false;
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:threshold:${automation.id}`}))`);
    // Read under the lock: a check that read before another one wrote would put back an older value.
    const reading = await readThreshold(automation.runAs!, automation.databaseId, trigger, { now, timeZone: automation.timeZone });
    if (reading.error) {
      await setCheckError(automation, reading.error);
      return false;
    }
    await setCheckError(automation, null);
    // Published again or turned off meanwhile: that save notes the value itself.
    const [current] = await tx
      .select({ version: databaseAutomation.version, enabled: databaseAutomation.enabled })
      .from(databaseAutomation)
      .where(eq(databaseAutomation.id, automation.id));
    if (!current || current.version !== automation.version || (!quiet && !current.enabled)) return false;
    const met = thresholdMet(reading.value, trigger);
    const [before] = await tx.select().from(automationThreshold).where(eq(automationThreshold.automationId, automation.id));
    await tx
      .insert(automationThreshold)
      .values({ automationId: automation.id, met, value: reading.value, checkedAt: now })
      .onConflictDoUpdate({ target: automationThreshold.automationId, set: { met, value: reading.value, checkedAt: now } });
    if (quiet || !thresholdFires(before?.met ?? null, met)) return false;
    await tx.insert(automationRun).values({
      automationId: automation.id,
      rowId: null,
      actorId: null,
      origin: "view_threshold",
      version: automation.version,
      triggerData: thresholdData(trigger, reading, before?.value ?? null),
    });
    return true;
  });
}

/** What a run keeps of the crossing: `{{trigger.value}}`, `.threshold` and the rest (see run.ts triggerScope). */
export function thresholdData(trigger: ThresholdTrigger, reading: Extract<ThresholdReading, { error: null }>, previous: number | null) {
  return {
    value: reading.value,
    previous,
    threshold: trigger.value,
    comparison: trigger.comparison,
    fn: trigger.fn,
    viewId: reading.view.id,
    propertyId: reading.property?.id ?? null,
  };
}

/**
 * Notes where a threshold automation's value stands now, without a run: after it is published
 * (`fresh`: with another trigger, or the first time) or turned on, so only crossings after that
 * start it. Never throws: a check that can't run says why in `checkError`, and the next one notes it.
 */
export async function armThreshold(automationId: string, fresh: boolean) {
  try {
    const [automation] = await db.select().from(databaseAutomation).where(eq(databaseAutomation.id, automationId));
    if (automation?.trigger.type !== "view_threshold" || automation.version < 1) {
      await db.delete(automationThreshold).where(eq(automationThreshold.automationId, automationId));
      return;
    }
    if (!fresh) {
      const [state] = await db.select({ met: automationThreshold.met }).from(automationThreshold).where(eq(automationThreshold.automationId, automationId));
      if (state) return;
    }
    await checkAutomation(automation, new Date(), true);
  } catch (error) {
    console.error("could not note a threshold automation's value", automationId, redactError(error));
  }
}

export type ThresholdOptions = { now?: Date; automationIds?: string[]; databaseIds?: string[] };

/**
 * One check of every threshold automation that is on and published (or of those of some
 * databases, or some automations: the e2e scripts check only their own). Returns how many runs it
 * queued.
 */
export async function runThresholdAutomations({ now = new Date(), automationIds, databaseIds }: ThresholdOptions = {}) {
  if (automationIds?.length === 0 || databaseIds?.length === 0) return 0;
  const automations = await db
    .select({ automation: databaseAutomation })
    .from(databaseAutomation)
    .innerJoin(page, eq(page.id, databaseAutomation.databaseId))
    .where(
      and(
        eq(databaseAutomation.enabled, true),
        sql`${databaseAutomation.version} > 0`,
        sql`${databaseAutomation.trigger} ->> 'type' = 'view_threshold'`,
        // A database in the trash or in a template checks nothing; it carries on when restored.
        isNull(page.archivedAt),
        eq(page.inTemplate, false),
        automationIds ? inArray(databaseAutomation.id, automationIds) : undefined,
        databaseIds ? inArray(databaseAutomation.databaseId, databaseIds) : undefined,
      ),
    );
  let queued = 0;
  for (const { automation } of automations) {
    try {
      if (await checkAutomation(automation, now, false)) queued++;
    } catch (error) {
      console.error("could not check a threshold automation", automation.id, redactError(error));
    }
  }
  if (queued) kickAutomations();
  return queued;
}

/** How long after rows are written their database's thresholds are checked: writes in a burst make one check. */
const SETTLE_MS = 1500;

/**
 * Server only: checks the thresholds of databases whose rows changed, a moment after, and all of
 * them now and every AUTOMATION_DATE_CHECK_SECONDS.
 */
export function startThresholdAutomations() {
  const waiting = new Map<string, NodeJS.Timeout>();
  onThresholdRows((databaseId) => {
    if (waiting.has(databaseId)) return;
    const timer = setTimeout(() => {
      waiting.delete(databaseId);
      runThresholdAutomations({ databaseIds: [databaseId] }).catch((error) => console.error("could not check threshold automations", redactError(error)));
    }, SETTLE_MS);
    timer.unref?.();
    waiting.set(databaseId, timer);
  });
  return startSweep(dateCheckIntervalMs(process.env.AUTOMATION_DATE_CHECK_SECONDS), () => runThresholdAutomations(), "could not check threshold automations");
}
