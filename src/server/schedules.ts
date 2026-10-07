import { and, asc, count, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { page, schedule } from "@/db/schema";
import {
  nextOccurrence,
  parseRepeatRule,
  repeatSummary,
  type RepeatRule,
  type ScheduleError,
  type ScheduleKind,
  type ScheduleSettings,
  type TemplateRepeatSummary,
} from "@/lib/schedule";
import { dayString, isTimeZone, localDay } from "@/lib/time-zone";
import { AccessError, requirePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { requireDatabase, withCode } from "@/server/databases";
import { createRow } from "@/server/templates";

/**
 * Schedules (lib/schedule for the rules): something that happens on a repeat rule, in a time zone.
 * Each replica's worker looks for schedules that are due every SWEEP_INTERVAL_MS. It takes them
 * with FOR UPDATE SKIP LOCKED and moves their next run on before doing anything, so a run happens
 * at most once even with several replicas or a crash; a server that was down catches up with one
 * run, then keeps to the rule. What a run does depends on the schedule's kind (see
 * registerScheduleHandler); "row_template" adds a row from a database's row template.
 *
 * A schedule runs as the person who set it last, with their access at the time. A run they could
 * no longer do pauses it (`enabled` off, with the reason in `lastError`) until someone sets it again.
 */

const SWEEP_INTERVAL_MS = 30_000;
const BATCH = 20;
/** Schedules a workspace may have, of every kind. */
export const MAX_SCHEDULES_PER_WORKSPACE = 200;

export type ScheduleRow = typeof schedule.$inferSelect;

/** A run that can't happen: every code but "failed" pauses the schedule. */
export class ScheduleRunError extends Error {
  constructor(
    readonly code: ScheduleError,
    message: string = code,
  ) {
    super(message);
  }
}

/**
 * Does one run of a schedule, as `runAs`, for the time it was due (`at`): true when it did
 * something, false when there was nothing to do this time. Throws ScheduleRunError when it can't;
 * any other error counts as "failed" (it runs again next time).
 */
export type ScheduleHandler = (run: { schedule: ScheduleRow; runAs: string; at: Date }) => Promise<boolean>;

const handlers = new Map<ScheduleKind, ScheduleHandler>();

/** What schedules of `kind` do when they run. */
export function registerScheduleHandler(kind: ScheduleKind, handler: ScheduleHandler) {
  handlers.set(kind, handler);
}

/** Takes the schedules due at `now` and moves each one's next run on, in one transaction. */
async function claimDue(now: Date) {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schedule)
      .where(and(eq(schedule.enabled, true), lte(schedule.nextRunAt, now)))
      .orderBy(asc(schedule.nextRunAt))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    const claimed: { row: ScheduleRow; at: Date }[] = [];
    for (const row of due) {
      const rule = parseRepeatRule(row.rule);
      if (!rule || !isTimeZone(row.timeZone)) {
        // Only written through setTemplateRepeat, which checks both; a runtime that lost a zone pauses it.
        await tx.update(schedule).set({ enabled: false, nextRunAt: null, lastError: "failed" }).where(eq(schedule.id, row.id));
        continue;
      }
      // From now, not from when it was due: missed runs make one run, not one each.
      const next = nextOccurrence(rule, row.timeZone, now);
      await tx.update(schedule).set({ nextRunAt: next }).where(eq(schedule.id, row.id));
      claimed.push({ row, at: row.nextRunAt! });
    }
    return claimed;
  });
}

async function runOne(row: ScheduleRow, at: Date, now: Date) {
  let error: ScheduleError | null = null;
  let done = false;
  try {
    const handler = handlers.get(row.kind);
    if (!handler) throw new Error(`No handler for schedules of kind ${row.kind}`);
    if (!row.runAs) throw new ScheduleRunError("runAsGone");
    done = await handler({ schedule: row, runAs: row.runAs, at });
  } catch (e) {
    error = e instanceof ScheduleRunError ? e.code : "failed";
    if (error === "failed") console.error("schedule run failed", row.id, e);
  }
  const pause = error !== null && error !== "failed";
  await db
    .update(schedule)
    .set(pause ? { enabled: false, nextRunAt: null, lastError: error } : { lastRunAt: done ? now : undefined, lastError: error })
    .where(eq(schedule.id, row.id));
  if (row.databaseId) getCollab().broadcast(`db:${row.databaseId}`, "rows");
}

/** Runs every schedule due at `now`. Returns how many ran (or tried to). */
export async function runDueSchedules(now = new Date()) {
  let total = 0;
  for (;;) {
    const claimed = await claimDue(now);
    for (const { row, at } of claimed) await runOne(row, at, now);
    total += claimed.length;
    if (claimed.length < BATCH) return total;
  }
}

let sweeping = false;

/** Server only: runs schedules as they fall due, and any missed while the server was down. */
export function startSchedules() {
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await runDueSchedules();
    } catch (error) {
      console.error("could not run schedules", error);
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------------------------
// Repeating row templates

/** The title a scheduled row gets: the template's, with the day it was due when asked. */
export function scheduledRowTitle(templateTitle: string, at: Date, timeZone: string, settings: ScheduleSettings) {
  if (!settings.dateInTitle) return templateTitle;
  const day = dayString(localDay(at.getTime(), timeZone));
  return templateTitle.trim() ? `${templateTitle.trim()} ${day}` : day;
}

registerScheduleHandler("row_template", async ({ schedule: row, runAs, at }) => {
  if (!row.templateId || !row.databaseId) throw new ScheduleRunError("templateGone");
  const [template] = await db
    .select({ title: page.title, isTemplate: page.isTemplate, parentId: page.parentId })
    .from(page)
    .where(eq(page.id, row.templateId));
  if (!template?.isTemplate || template.parentId !== row.databaseId) throw new ScheduleRunError("templateGone");
  const [database] = await db.select({ archivedAt: page.archivedAt }).from(page).where(eq(page.id, row.databaseId));
  // A database in the trash makes no rows; it carries on if the database comes back.
  if (!database || database.archivedAt) return false;
  try {
    await createRow({ userId: runAs }, row.databaseId, {
      templateId: row.templateId,
      title: scheduledRowTitle(template.title, at, row.timeZone, row.settings),
    });
  } catch (error) {
    if (error instanceof AccessError) throw new ScheduleRunError("accessLost", error.message);
    throw error;
  }
  return true;
});

export type TemplateRepeat = {
  rule: RepeatRule;
  timeZone: string;
  dateInTitle: boolean;
} & TemplateRepeatSummary & { lastRunAt: string | null };

/** A row template, checked: the user may view it and it belongs to a database. */
async function requireRowTemplate(userId: string, templateId: string) {
  const template = await requirePageAccess(userId, templateId, "view");
  if (!template.isTemplate || !template.parentId) throw withCode(new AccessError("Not a row template"), "notATemplate");
  return { ...template, databaseId: template.parentId };
}

/** How a row template repeats, or null when it doesn't. Needs view access to the template. */
export async function getTemplateRepeat(userId: string, templateId: string): Promise<TemplateRepeat | null> {
  await requireRowTemplate(userId, templateId);
  const [row] = await db.select().from(schedule).where(eq(schedule.templateId, templateId));
  if (!row) return null;
  return {
    rule: row.rule,
    timeZone: row.timeZone,
    dateInTitle: Boolean(row.settings.dateInTitle),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    ...repeatSummary(row),
  };
}

export type TemplateRepeatInput = { rule: unknown; timeZone: unknown; dateInTitle?: unknown };

/**
 * Makes a row template repeat, or changes how, as `userId` from now on: they need to be able to
 * add rows to its database. Turns it back on when it was paused; the next run is counted from now.
 */
export async function setTemplateRepeat(userId: string, templateId: string, input: TemplateRepeatInput, now = new Date()) {
  const template = await requireRowTemplate(userId, templateId);
  await requireDatabase(userId, template.databaseId, "edit");
  const rule = parseRepeatRule(input.rule);
  if (!rule || !isTimeZone(input.timeZone)) throw withCode(new Error("Invalid repeat rule or time zone"), "invalidRepeat");
  const timeZone = input.timeZone;
  const values = {
    rule,
    timeZone,
    settings: { dateInTitle: input.dateInTitle === true },
    enabled: true,
    nextRunAt: nextOccurrence(rule, timeZone, now),
    lastError: null,
    runAs: userId,
  };
  const [existing] = await db.select({ id: schedule.id }).from(schedule).where(eq(schedule.templateId, templateId));
  if (existing) {
    await db.update(schedule).set(values).where(eq(schedule.id, existing.id));
  } else {
    const [{ n }] = await db.select({ n: count() }).from(schedule).where(eq(schedule.workspaceId, template.workspaceId));
    if (n >= MAX_SCHEDULES_PER_WORKSPACE) throw withCode(new Error("Too many schedules in this workspace"), "tooManySchedules");
    await db
      .insert(schedule)
      .values({ ...values, workspaceId: template.workspaceId, kind: "row_template", templateId, databaseId: template.databaseId, createdBy: userId })
      .onConflictDoUpdate({ target: schedule.templateId, set: values });
  }
  getCollab().broadcast(`db:${template.databaseId}`, "rows");
  return (await getTemplateRepeat(userId, templateId))!;
}

/** Stops a row template repeating. Needs the access setting it does. */
export async function removeTemplateRepeat(userId: string, templateId: string) {
  const template = await requireRowTemplate(userId, templateId);
  await requireDatabase(userId, template.databaseId, "edit");
  await db.delete(schedule).where(eq(schedule.templateId, templateId));
  getCollab().broadcast(`db:${template.databaseId}`, "rows");
}
