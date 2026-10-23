import { AsyncLocalStorage } from "node:async_hooks";
import { and, count, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation, databaseProperty } from "@/db/schema";
import { changedProperties, matchesTrigger, watchedProperties } from "@/lib/automations";
import { redactError } from "@/lib/redact";

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

/** Runs `fn` as no automation's action, whatever started the code calling it (timers carry it on). */
export const outsideAutomation = <T>(fn: () => Promise<T>) => state.als.exit(fn);

/** The worker asks to be woken when runs are queued, so they don't wait for its next sweep. */
export function onAutomationsQueued(kick: () => void) {
  state.kick = kick;
}

/** Wakes the worker for runs queued some other way (the "date passed" check). */
export const kickAutomations = () => state.kick?.();

/**
 * Makes a waiting run due now and wakes the worker: an approval it waits for was answered. Taken
 * while it runs, the worker looks at the answer again after saving it (run.ts), so it isn't lost.
 */
export async function wakeRun(runId: string) {
  await db.update(automationRun).set({ nextAt: new Date() }).where(and(eq(automationRun.id, runId), eq(automationRun.status, "pending")));
  state.kick?.();
}

export type RowChange = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

const CHUNK = 500;
/**
 * Runs one database's automations may have waiting (or running) at once. A write that would queue
 * more starts only the first ones and the server log says how many it left out, so bulk edits
 * can't pile up runs without end. The worker takes databases in turn either way (run.ts `claim`).
 */
export const MAX_WAITING_RUNS = 20_000;
const LEFT_OUT_LOG_MS = 60_000;
const leftOutLogged = new Map<string, number>();

export async function queueAutomations(
  actorId: string | null,
  databaseId: string,
  changes: RowChange[],
  created: boolean,
  /** An answer to a public form: who published it (automation_run.bound_to). */
  boundTo: string | null = null,
) {
  if (!changes.length || runningAutomation()) return;
  try {
    const automations = await db
      .select({ id: databaseAutomation.id, trigger: databaseAutomation.trigger, version: databaseAutomation.version })
      .from(databaseAutomation)
      // Only published automations run; one that is only a draft (version 0) waits for it.
      .where(and(eq(databaseAutomation.databaseId, databaseId), eq(databaseAutomation.enabled, true), gt(databaseAutomation.version, 0)));
    if (!automations.length) return;
    // Deleted properties start nothing: their values (kept for a restore) aren't changes, and
    // automations waiting for one of them to change wait until it is restored.
    const deleted = new Set(
      (
        await db
          .select({ id: databaseProperty.id })
          .from(databaseProperty)
          .where(and(eq(databaseProperty.databaseId, databaseId), isNotNull(databaseProperty.deletedAt)))
      ).map((p) => p.id),
    );
    const live = (values: Record<string, unknown>) =>
      deleted.size ? Object.fromEntries(Object.entries(values).filter(([id]) => !deleted.has(id))) : values;
    // One watching several properties waits only while all of them are deleted.
    const armed = automations.filter((a) => {
      if (a.trigger.type === "row_created") return true;
      if (a.trigger.type !== "property_changed") return false;
      const watched = watchedProperties(a.trigger);
      return !watched.length || watched.some((id) => !deleted.has(id));
    });
    let runs = changes.flatMap((change) => {
      const write = { before: live(change.before), after: live(change.after), created };
      const changed = created ? Object.keys(write.after) : changedProperties(write.before, write.after);
      return armed
        .filter((a) => matchesTrigger(a.trigger, write))
        .map((a) => ({
          automationId: a.id,
          rowId: change.rowId,
          actorId,
          boundTo,
          created,
          changed,
          version: a.version,
          // The changed values before and after, for `trigger.changes` in the steps' templates.
          triggerData: created ? null : { changes: Object.fromEntries(changed.map((id) => [id, { before: write.before[id] ?? null, after: write.after[id] ?? null }])) },
        }));
    });
    if (!runs.length) return;
    const [{ waiting }] = await db
      .select({ waiting: count() })
      .from(automationRun)
      .where(
        and(
          inArray(automationRun.automationId, automations.map((a) => a.id)),
          inArray(automationRun.status, ["pending", "running"]),
        ),
      );
    const room = Math.max(0, MAX_WAITING_RUNS - waiting);
    if (runs.length > room) {
      const now = Date.now();
      if (now - (leftOutLogged.get(databaseId) ?? 0) > LEFT_OUT_LOG_MS) {
        leftOutLogged.set(databaseId, now);
        console.error(`Automations of database ${databaseId}: ${runs.length - room} runs not queued, ${waiting} are waiting already (at most ${MAX_WAITING_RUNS})`);
      }
      runs = runs.slice(0, room);
    }
    for (let i = 0; i < runs.length; i += CHUNK) await db.insert(automationRun).values(runs.slice(i, i + CHUNK));
    if (runs.length) state.kick?.();
  } catch (error) {
    console.error("Couldn't queue database automations", redactError(error));
  }
}
