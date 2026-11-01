import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentDailyChange } from "@/db/schema";
import { changeDay, type QuietHours } from "@/lib/quiet-hours";
import { redactError } from "@/lib/redact";

/**
 * An agent's daily limit on changes (`daily_change_limit`): every change its runs make takes one of
 * the day's before it is made (run.ts), in one statement, so runs at once never go past it. The day
 * is on its quiet hours' clock, else UTC's. A count that can't be read or written counts as the
 * limit reached: the change is refused rather than made uncounted.
 */

type Limited = { id: string; dailyChangeLimit: number | null; quietHours: QuietHours | null };

/** Days of counts kept, past today. */
const KEPT_DAYS = 3;

/** Takes one of the day's changes: the day it was counted on, or null when the limit is reached (or the count failed). */
export async function takeDailyChange(agent: Limited, now = new Date()): Promise<{ day: string } | null> {
  const limit = agent.dailyChangeLimit;
  const day = changeDay(now, agent.quietHours?.timeZone);
  if (limit === null) return { day };
  try {
    const taken = await db
      .insert(agentDailyChange)
      .values({ agentId: agent.id, day, count: 1 })
      .onConflictDoUpdate({
        target: [agentDailyChange.agentId, agentDailyChange.day],
        set: { count: sql`${agentDailyChange.count} + 1` },
        setWhere: sql`${agentDailyChange.count} < ${limit}`,
      })
      .returning({ count: agentDailyChange.count });
    return taken.length ? { day } : null;
  } catch (error) {
    console.error("[agents] could not count a change against the daily limit", redactError(error));
    return null;
  }
}

/** Whether the day's limit is reached already (the count unreadable counts as reached), without taking one. */
export async function dailyLimitReached(agent: Limited, now = new Date()): Promise<boolean> {
  const limit = agent.dailyChangeLimit;
  if (limit === null) return false;
  try {
    const [row] = await db
      .select({ count: agentDailyChange.count })
      .from(agentDailyChange)
      .where(and(eq(agentDailyChange.agentId, agent.id), eq(agentDailyChange.day, changeDay(now, agent.quietHours?.timeZone))));
    return (row?.count ?? 0) >= limit;
  } catch (error) {
    console.error("[agents] could not read the daily limit's count", redactError(error));
    return true;
  }
}

/** Gives back a change taken for one that failed, on the day it was taken. Never throws. */
export async function giveBackDailyChange(agent: Pick<Limited, "id" | "dailyChangeLimit">, day: string) {
  if (agent.dailyChangeLimit === null) return;
  await db
    .update(agentDailyChange)
    .set({ count: sql`greatest(${agentDailyChange.count} - 1, 0)` })
    .where(and(eq(agentDailyChange.agentId, agent.id), eq(agentDailyChange.day, day)))
    .catch((error: unknown) => console.error("[agents] could not give back a change", redactError(error)));
}

/** Counts of days long past go. */
export async function pruneDailyChanges(now = new Date()) {
  const before = new Date(now.getTime() - KEPT_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
  await db.delete(agentDailyChange).where(lt(agentDailyChange.day, before));
}
