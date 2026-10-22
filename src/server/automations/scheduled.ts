import { and, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation, page } from "@/db/schema";
import { nextScheduledRun, parseAutomationSchedule } from "@/lib/automation-schedule";
import type { AutomationTrigger } from "@/lib/automations";
import { redactError } from "@/lib/redact";
import { requireDatabase } from "@/server/databases";
import { startSweep } from "@/server/sweep";
import { kickAutomations } from "./queue";
import { automationZone } from "./timed";

/**
 * Scheduled automations (trigger "schedule", lib/automation-schedule): `next_run_at` says when one
 * that is on and published next comes round. Every SWEEP_MS a check takes those that are due with
 * FOR UPDATE SKIP LOCKED, moves their next run on from now (a server that was down runs once for
 * the times it missed, not once each) and queues a run without a row, like a row write queues one.
 * One whose person (who published it last) lost full access to the database queues nothing and
 * says so in `checkError` until a check can run it again; so does a schedule that never comes.
 */

const SWEEP_MS = 30_000;
const BATCH = 50;

/** When a scheduled automation next runs after `now`; null for other triggers or a schedule that never comes. */
export function nextRunOf(trigger: AutomationTrigger, timeZone: string, now = new Date()) {
  if (trigger.type !== "schedule") return null;
  const schedule = parseAutomationSchedule(trigger.schedule);
  return schedule ? nextScheduledRun(schedule, automationZone(timeZone), now) : null;
}

async function canManage(userId: string | null, databaseId: string) {
  if (!userId) return false;
  try {
    const database = await requireDatabase(userId, databaseId, "full");
    return !database.archivedAt;
  } catch {
    return false;
  }
}

/** Queues the runs of scheduled automations due at `now`. Returns how many. */
export async function runScheduledAutomations({ now = new Date(), automationIds }: { now?: Date; automationIds?: string[] } = {}) {
  if (automationIds?.length === 0) return 0;
  let queued = 0;
  for (;;) {
    const claimed = await db.transaction(async (tx) => {
      const due = await tx
        .select({ automation: databaseAutomation })
        .from(databaseAutomation)
        .innerJoin(page, eq(page.id, databaseAutomation.databaseId))
        .where(
          and(
            eq(databaseAutomation.enabled, true),
            gt(databaseAutomation.version, 0),
            isNotNull(databaseAutomation.nextRunAt),
            lte(databaseAutomation.nextRunAt, now),
            sql`${databaseAutomation.trigger} ->> 'type' = 'schedule'`,
            // A database in the trash or in a template runs nothing; its schedule waits.
            isNull(page.archivedAt),
            eq(page.inTemplate, false),
            automationIds ? sql`${databaseAutomation.id} in ${automationIds}` : undefined,
          ),
        )
        .orderBy(databaseAutomation.nextRunAt)
        .limit(BATCH)
        .for("update", { of: databaseAutomation, skipLocked: true });
      const out: { id: string; databaseId: string; runAs: string | null; version: number; at: Date }[] = [];
      for (const { automation } of due) {
        const next = nextRunOf(automation.trigger, automation.timeZone, now);
        await tx
          .update(databaseAutomation)
          .set({ nextRunAt: next, ...(next ? {} : { checkError: "scheduleInvalid" as const }) })
          .where(eq(databaseAutomation.id, automation.id));
        out.push({ id: automation.id, databaseId: automation.databaseId, runAs: automation.runAs, version: automation.version, at: automation.nextRunAt! });
      }
      return out;
    });
    for (const automation of claimed) {
      try {
        if (!(await canManage(automation.runAs, automation.databaseId))) {
          await db.update(databaseAutomation).set({ checkError: "noAccess" }).where(eq(databaseAutomation.id, automation.id));
          continue;
        }
        await db
          .update(databaseAutomation)
          .set({ checkError: null })
          .where(and(eq(databaseAutomation.id, automation.id), eq(databaseAutomation.checkError, "noAccess")));
        await db.insert(automationRun).values({
          automationId: automation.id,
          rowId: null,
          actorId: null,
          origin: "schedule",
          version: automation.version,
          triggerData: { scheduledFor: automation.at.toISOString() },
        });
        queued++;
      } catch (error) {
        console.error("could not queue a scheduled automation", automation.id, redactError(error));
      }
    }
    if (claimed.length < BATCH) break;
  }
  if (queued) kickAutomations();
  return queued;
}

/** Server only: queues scheduled automations' runs as they come due. */
export function startScheduledAutomations() {
  return startSweep(SWEEP_MS, () => runScheduledAutomations(), "could not run scheduled automations");
}
