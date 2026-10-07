import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation } from "@/db/schema";
import { changedProperties, matchesTrigger } from "@/lib/automations";

/**
 * Where row writes meet automations: every write path (see server/databases `afterRowWrites`)
 * hands its changes here once they are saved, and the runs they start are queued in the
 * database for the worker (server/automations/run.ts). Nothing here throws: an automation never
 * holds back or fails the write that started it.
 *
 * Changes an automation makes don't start automations, so two automations
 * can't feed each other forever. The worker runs actions inside `asAutomation`.
 *
 * Kept on globalThis, like server/row-events, so Next's bundle and the custom server share it.
 */

type State = { als: AsyncLocalStorage<true>; kick?: () => void };
const g = globalThis as typeof globalThis & { __leafdeskAutomations?: State };
const state: State = (g.__leafdeskAutomations ??= { als: new AsyncLocalStorage<true>() });

/** Whether this code runs as an automation's action. */
export const runningAutomation = () => state.als.getStore() === true;

/** Runs `fn` as an automation's action: the row writes it makes start no automations. */
export const asAutomation = <T>(fn: () => Promise<T>) => state.als.run(true, fn);

/** The worker asks to be woken when runs are queued, so they don't wait for its next sweep. */
export function onAutomationsQueued(kick: () => void) {
  state.kick = kick;
}

export type RowChange = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

const CHUNK = 500;

export async function queueAutomations(
  actorId: string | null,
  databaseId: string,
  changes: RowChange[],
  created: boolean,
) {
  if (!changes.length || runningAutomation()) return;
  try {
    const automations = await db
      .select({ id: databaseAutomation.id, trigger: databaseAutomation.trigger })
      .from(databaseAutomation)
      .where(and(eq(databaseAutomation.databaseId, databaseId), eq(databaseAutomation.enabled, true)));
    if (!automations.length) return;
    const runs = changes.flatMap((change) => {
      const write = { before: change.before, after: change.after, created };
      return automations
        .filter((a) => matchesTrigger(a.trigger, write))
        .map((a) => ({
          automationId: a.id,
          rowId: change.rowId,
          actorId,
          created,
          changed: created ? Object.keys(change.after) : changedProperties(change.before, change.after),
        }));
    });
    for (let i = 0; i < runs.length; i += CHUNK) await db.insert(automationRun).values(runs.slice(i, i + CHUNK));
    if (runs.length) state.kick?.();
  } catch (error) {
    console.error("Couldn't queue database automations", error);
  }
}
