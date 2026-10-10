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
import { pushNotifications } from "@/server/push";
import { rowFields } from "@/server/operations";
import { propertyAccessFor } from "@/server/property-access";
import { queueAgentRun } from "@/server/agents/run";
import { notAgentUser } from "@/server/agents/users";
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
/** A run taken this many times without finishing (one that stops the worker, say) fails. */
const MAX_CLAIMS = 25;
/**
 * A new row's title is often typed after it's created (the "New" button): a run with a webhook
 * waits up to this long, looking again every TITLE_POLL_MS, so the webhook doesn't send it untitled.
 */
const TITLE_WAIT_MS = 60_000;
const TITLE_POLL_MS = 5_000;
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

  const waitsForTitle = () =>
    run.created &&
    !row?.title.trim() &&
    Date.now() - run.createdAt.getTime() < TITLE_WAIT_MS &&
    steps.some((s, i) => s.status === "pending" && automation.actions[i].type === "webhook");

  if (edited) steps = endPending(steps, "changed", "skipped");
  else if (run.attempts > MAX_CLAIMS) steps = endPending(steps, "tooManyAttempts");
  else if (!automation.enabled) steps = endPending(steps, "disabled", "skipped");
  else if (!row || row.archivedAt || row.parentId !== automation.databaseId) steps = endPending(steps, "rowGone", "skipped");
  else if (!automation.runAs || !(await canManage(automation.runAs, automation.databaseId))) {
    steps = endPending(steps, "noAccess");
  } else if (waitsForTitle()) {
    retryAt = new Date(Date.now() + TITLE_POLL_MS);
  } else {
    let live: Promise<Set<string>> | undefined;
    const liveIds = () => (live ??= getProperties(automation.databaseId).then((props) => new Set(props.map((p) => p.id))));
    for (const [i, action] of automation.actions.entries()) {
      const step = steps[i];
      if (!step || step.status !== "pending") continue;
      step.attempts += 1;
      try {
        if (action.type === "set_properties") {
          // Values of deleted properties aren't set; with nothing else to set, the step is skipped.
          const live = await liveIds();
          const values = Object.fromEntries(Object.entries(action.values).filter(([id]) => live.has(id)));
          if (Object.keys(action.values).length && !Object.keys(values).length) {
            Object.assign(step, { status: "skipped", code: "propertyDeleted" });
            continue;
          }
          await setProperties(automation, run, values);
          step.status = "done";
        } else if (action.type === "notify") {
          // The people of a deleted person property aren't told.
          const live = await liveIds();
          step.notified = await notify(automation, run, row, { ...action, propertyIds: action.propertyIds.filter((id) => live.has(id)) });
          step.status = "done";
        } else if (action.type === "run_agent") {
          // Queued once (a retry of the run doesn't queue it again); it runs apart, as the agent.
          step.agentRunId ??= await queueAgentRun({
            agentId: action.agentId,
            workspaceId: automation.workspaceId,
            source: { kind: "automation", automationId: automation.id, automationRunId: run.id, databaseId: automation.databaseId, rowId: run.rowId },
            context: { created: run.created, changed: run.changed, actorId: run.actorId },
            prompt: action.prompt,
          });
          step.status = "done";
        } else {
          // The row as it is now (after the actions before this one); its retries send the same.
          if (step.attempts === 1 || !payload) payload = await webhookPayload(automation, run, row);
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
          // Actions run in order: the ones after it wait for it.
          retryAt = new Date(Date.now() + retryDelayMs(step.attempts));
          break;
        }
        step.status = "failed";
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
    // The server's own day (its TZ), not UTC's: the same day as the server's clock shows.
    else if (value.$ === "now") patch[id] = new Date().toLocaleDateString("en-CA");
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
    // Agents' users have no inbox.
    (await db.select({ id: user.id }).from(user).where(and(inArray(user.id, candidates), notAgentUser(user.id)))).map((u) => u.id),
  );
  const levels = await Promise.all(
    candidates
      .filter((userId) => existing.has(userId))
      .map(async (userId) => {
        const { level } = await resolvePageAccess(userId, row.id).catch(() => ({ level: "none" as const }));
        return { userId, level };
      }),
  );
  const recipients = levels.filter((r) => r.level !== "none").map((r) => r.userId);
  if (!recipients.length) return 0;
  const emailDueAt = new Date(Date.now() + EMAIL_DELAY_MS);
  const inserted = await db
    .insert(notification)
    .values(
      recipients.map((userId) => ({
        userId,
        workspaceId: row.workspaceId,
        kind: "automation" as const,
        actorId: run.actorId,
        pageId: row.id,
        automationId: automation.id,
        emailDueAt,
      })),
    )
    .returning({ id: notification.id });
  signalInbox(row.workspaceId);
  pushNotifications(inserted.map((n) => n.id));
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
            .set({ status: "failed", steps: endPending(run.steps, "error"), finishedAt: new Date() })
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
