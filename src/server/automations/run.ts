import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation, notification, page, user } from "@/db/schema";
import {
  isDynamicValue,
  MAX_WEBHOOK_ATTEMPTS,
  retriable,
  retryDelayMs,
  runStatusOf,
  webhookEvent,
  type AutomationAction,
  type AutomationStep,
} from "@/lib/automations";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { resolvePageAccess } from "@/server/access";
import { getProperties, requireDatabase, updateRowProperties } from "@/server/databases";
import { signalInbox } from "@/server/notifications";
import { rowFields } from "@/server/operations";
import { propertyAccessFor } from "@/server/property-access";
import { asAutomation, onAutomationsQueued } from "./queue";
import { sendWebhook, WebhookError, webhookSecret } from "./webhook";

/**
 * The automation worker: takes queued runs (server/automations/queue) and does their actions, as
 * the person who last saved the automation (`runAs`), with their access at the time: if they
 * can no longer manage the database, nothing runs. Each action is a step that either works or
 * fails on its own; only webhooks are tried again (MAX_WEBHOOK_ATTEMPTS, see retryDelayMs).
 * Finished runs are kept for RUN_HISTORY_DAYS.
 */

const SWEEP_INTERVAL_MS = 5_000;
const BATCH = 20;
/** A run taken this long ago and not finished belongs to a worker that stopped: it's taken again. */
const STALE_MS = 10 * 60_000;
export const RUN_HISTORY_DAYS = 30;
/** How long an automation's email waits, like a share's, so it isn't sent for something read at once. */
const EMAIL_DELAY_MS = 30_000;

type Run = typeof automationRun.$inferSelect;
type Automation = typeof databaseAutomation.$inferSelect;
type Row = { id: string; title: string; parentId: string | null; workspaceId: string; archivedAt: Date | null; properties: Record<string, unknown> };

/** Takes due runs, marking them running, so two sweeps never take the same one. */
async function claim(): Promise<Run[]> {
  const taken = await db.execute<{ id: string }>(sql`
    update ${automationRun} set status = 'running', attempts = attempts + 1, next_at = now()
    where id in (
      select id from ${automationRun}
      where (status = 'pending' and next_at <= now())
         or (status = 'running' and next_at <= now() - make_interval(secs => ${STALE_MS / 1000}))
      order by next_at
      limit ${BATCH}
      for update skip locked
    )
    returning id
  `);
  const ids = [...taken].map((r) => r.id);
  if (!ids.length) return [];
  // Loaded again through the schema, so dates and JSON come back typed.
  return db.select().from(automationRun).where(inArray(automationRun.id, ids)).orderBy(automationRun.createdAt);
}

/** Ends the steps still waiting with `code`; steps already done or failed keep how they went. */
const endPending = (steps: AutomationStep[], code: string, status: AutomationStep["status"] = "failed") =>
  steps.map((step) => (step.status === "pending" ? { ...step, status, code } : step));

/** Does what is left of one run and saves how it went. */
export async function processRun(run: Run) {
  const [automation] = await db.select().from(databaseAutomation).where(eq(databaseAutomation.id, run.automationId));
  if (!automation) return; // deleted since: its runs went with it
  const [row] = await db
    .select({
      id: page.id,
      title: page.title,
      parentId: page.parentId,
      workspaceId: page.workspaceId,
      archivedAt: page.archivedAt,
      properties: page.properties,
    })
    .from(page)
    .where(eq(page.id, run.rowId));

  let steps: AutomationStep[] = run.steps.length
    ? run.steps
    : automation.actions.map((a) => ({ type: a.type, status: "pending", attempts: 0 }) as AutomationStep);
  let payload = run.payload;
  let retryAt: Date | null = null;
  // Actions changed while a webhook waited to be tried again: what's left belongs to the old ones.
  const edited = steps.length !== automation.actions.length || steps.some((s, i) => s.type !== automation.actions[i].type);

  if (edited) steps = endPending(steps, "changed", "skipped");
  else if (!automation.enabled) steps = endPending(steps, "disabled", "skipped");
  else if (!row || row.archivedAt || row.parentId !== automation.databaseId) steps = endPending(steps, "rowGone", "skipped");
  else if (!automation.runAs || !(await canManage(automation.runAs, automation.databaseId))) {
    steps = endPending(steps, "noAccess");
  } else {
    for (const [i, action] of automation.actions.entries()) {
      const step = steps[i];
      if (!step || step.status !== "pending") continue;
      step.attempts += 1;
      try {
        if (action.type === "set_properties") {
          await setProperties(automation, run, action.values);
          step.status = "done";
        } else if (action.type === "notify") {
          step.notified = await notify(automation, run, row, action);
          step.status = "done";
        } else {
          payload ??= await webhookPayload(automation, run, row);
          const status = await sendWebhook(action.url, {
            id: run.id,
            event: webhookEvent(run.created),
            body: payload,
            secret: webhookSecret(automation.secretSalt),
          });
          Object.assign(step, { status: "done", httpStatus: status, code: undefined, error: undefined });
        }
      } catch (error) {
        const httpStatus = error instanceof WebhookError ? error.httpStatus : null;
        const code = (error as { code?: string }).code ?? "error";
        const message = error instanceof Error ? error.message : String(error);
        Object.assign(step, { code, error: message.slice(0, 500), ...(httpStatus ? { httpStatus } : {}) });
        const again =
          action.type === "webhook" &&
          step.attempts < MAX_WEBHOOK_ATTEMPTS &&
          error instanceof WebhookError &&
          error.code !== "invalidUrl" &&
          error.code !== "blocked" &&
          retriable(httpStatus);
        if (again) {
          const at = new Date(Date.now() + retryDelayMs(step.attempts));
          if (!retryAt || at < retryAt) retryAt = at;
        } else step.status = "failed";
      }
    }
  }

  const status = runStatusOf(steps);
  await db
    .update(automationRun)
    .set({
      steps,
      payload,
      status,
      nextAt: retryAt ?? new Date(),
      finishedAt: status === "pending" ? null : new Date(),
    })
    .where(eq(automationRun.id, run.id));
}

async function canManage(userId: string, databaseId: string) {
  try {
    const database = await requireDatabase(userId, databaseId, "full");
    return !database.archivedAt;
  } catch {
    return false;
  }
}

/** Sets the action's values, working out `now` and `actor`, as the automation's person. */
async function setProperties(automation: Automation, run: Run, values: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    if (!isDynamicValue(value)) patch[id] = value;
    else if (value.$ === "now") patch[id] = new Date().toISOString().slice(0, 10);
    // Nobody to set when an anonymous form answer started it: the value stays as it is.
    else if (run.actorId) patch[id] = [run.actorId];
  }
  if (!Object.keys(patch).length) return;
  await asAutomation(() => updateRowProperties(automation.runAs!, run.rowId, patch));
}

/**
 * Tells the action's people, and whoever its person properties name in the row now, as long as
 * they can open the row. Returns how many were told.
 */
async function notify(automation: Automation, run: Run, row: Row, action: Extract<AutomationAction, { type: "notify" }>) {
  const fromRow = action.propertyIds.flatMap((id) => {
    const value = row.properties[id];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  });
  const candidates = [...new Set([...action.userIds, ...fromRow])];
  if (!candidates.length) return 0;
  const existing = new Set(
    (await db.select({ id: user.id }).from(user).where(inArray(user.id, candidates))).map((u) => u.id),
  );
  const recipients: string[] = [];
  for (const userId of candidates) {
    if (!existing.has(userId)) continue;
    const { level } = await resolvePageAccess(userId, row.id).catch(() => ({ level: "none" as const }));
    if (level !== "none") recipients.push(userId);
  }
  if (!recipients.length) return 0;
  const emailDueAt = new Date(Date.now() + EMAIL_DELAY_MS);
  await db.insert(notification).values(
    recipients.map((userId) => ({
      userId,
      workspaceId: row.workspaceId,
      kind: "automation" as const,
      actorId: run.actorId,
      pageId: row.id,
      automationId: automation.id,
      emailDueAt,
    })),
  );
  signalInbox(row.workspaceId);
  return recipients.length;
}

/**
 * The body every try of the run's webhooks sends: the row as the automation's person sees it
 * when it's first sent (after the run's earlier actions), and which properties changed.
 */
async function webhookPayload(automation: Automation, run: Run, row: Row) {
  const runAs = automation.runAs!;
  const ctx = { userId: runAs, actor: { userId: runAs } };
  const [fields, all, access, [database], actor] = await Promise.all([
    rowFields(ctx, row.id),
    getProperties(automation.databaseId),
    propertyAccessFor(runAs, automation.databaseId),
    db.select({ title: page.title }).from(page).where(eq(page.id, automation.databaseId)),
    run.actorId ? db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, run.actorId)) : Promise.resolve([]),
  ]);
  const visible = new Map(access.visible(all).map((p) => [p.id, p.name]));
  const url = (id: string) => `${env.appUrl}/w/${row.workspaceId}/p/${id}`;
  return JSON.stringify({
    id: run.id,
    event: webhookEvent(run.created),
    created_at: run.createdAt.toISOString(),
    automation: { id: automation.id, name: automation.name },
    workspace_id: row.workspaceId,
    database: { id: automation.databaseId, title: pageLabel(database?.title ?? ""), url: url(automation.databaseId) },
    row: { id: row.id, title: pageLabel(row.title), url: url(row.id), properties: fields.properties },
    changed: run.changed.flatMap((id) => (visible.has(id) ? [visible.get(id)!] : [])),
    actor: actor[0] ? { id: actor[0].id, name: actor[0].name } : null,
  });
}

let sweeping = false;
let again = false;

async function sweep() {
  if (sweeping) {
    again = true;
    return;
  }
  sweeping = true;
  try {
    do {
      again = false;
      const runs = await claim();
      for (const run of runs) {
        try {
          await processRun(run);
        } catch (error) {
          console.error("automation run failed", error);
          await db
            .update(automationRun)
            .set({ status: "failed", finishedAt: new Date() })
            .where(eq(automationRun.id, run.id))
            .catch(() => undefined);
        }
      }
      if (runs.length === BATCH) again = true;
    } while (again);
  } catch (error) {
    console.error("could not run automations", error);
  } finally {
    sweeping = false;
  }
}

/** Runs everything due now and waits for it (scripts and tests; the server sweeps on its own). */
export async function flushAutomations() {
  while (sweeping) await new Promise((resolve) => setTimeout(resolve, 20));
  await sweep();
}

/** Finished runs older than RUN_HISTORY_DAYS go; the latest ones are the automation's history. */
export async function pruneAutomationRuns() {
  await db
    .delete(automationRun)
    .where(
      and(
        inArray(automationRun.status, ["done", "failed"]),
        lte(automationRun.finishedAt, new Date(Date.now() - RUN_HISTORY_DAYS * 24 * 60 * 60_000)),
      ),
    )
    .catch((error) => console.error("could not prune automation runs", error));
}

/** Server only: runs queued automations, right away when they are queued and every few seconds. */
export function startAutomations() {
  onAutomationsQueued(() => setImmediate(() => void sweep()));
  void sweep();
  void pruneAutomationRuns();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  const daily = setInterval(() => void pruneAutomationRuns(), 24 * 60 * 60_000);
  timer.unref?.();
  daily.unref?.();
  return () => {
    clearInterval(timer);
    clearInterval(daily);
  };
}
