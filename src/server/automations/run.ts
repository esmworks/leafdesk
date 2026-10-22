import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, automationVersion, databaseAutomation, notification, page, user, type AutomationDefinition } from "@/db/schema";
import {
  APPROVAL_TEST_CODE,
  FINISHED_RUN_STATUSES,
  forEachOf,
  hasRow,
  httpRetriable,
  isDynamicValue,
  MAX_FOUND_ROWS,
  MAX_HTTP_RESPONSE_BYTES,
  MAX_WEBHOOK_ATTEMPTS,
  retriable,
  retryDelayMs,
  runEvent,
  runStatusOf,
  stepIds,
  type AutomationAction,
  type AutomationStep,
  type AutomationStepItem,
  waitingApproval,
} from "@/lib/automations";
import { idsOf, resolveText, resolveValue, templateRoots, textOf, type TemplateScope } from "@/lib/automation-templates";
import { env } from "@/lib/env";
import { mapFilterRules } from "@/lib/filters";
import { pageLabel } from "@/lib/labels";
import { holdsOptions, holdsPeople } from "@/lib/property-types";
import { isCredentialKey, REDACTED, redactError, redactText, redactValue } from "@/lib/redact";
import { dayString, localDay } from "@/lib/time-zone";
import { resolvePageAccess } from "@/server/access";
import {
  createRows,
  getLookups,
  getProperties,
  getRow,
  requireDatabase,
  updateRowProperties,
  viewedRows,
  type DatabaseProperty,
} from "@/server/databases";
import { displayProperties, type PropertyDef } from "@/server/mcp/query";
import { signalInbox } from "@/server/notifications";
import { pushNotifications } from "@/server/push";
import { rowFields } from "@/server/operations";
import { propertyAccessFor } from "@/server/property-access";
import { queueAgentRun } from "@/server/agents/run";
import { notAgentUser } from "@/server/agents/users";
import { recordAudit, runAsAuditOrigin } from "@/server/audit";
import { archivePage, renamePage } from "@/server/pages";
import { exportAllowed } from "@/server/workspaces";
import { ApprovalStepError, askApproval, closeApprovals, readAnswer, stillWaiting } from "./approval";
import { HttpStepError, sendRequest } from "./http";
import { asAutomation, kickAutomations, onAutomationsQueued } from "./queue";
import { automationZone, followOwnEdit } from "./timed";
import { sendWebhook, WebhookError, webhookSecret } from "./webhook";

/**
 * The automation worker: takes queued runs (server/automations/queue) and does their steps, as
 * the person who last published the automation (`runAs`; a test run as whoever started it), with
 * their access at the time: if they can no longer manage the database, nothing runs. A run does
 * the steps of the version it started with (automation_version), so publishing doesn't change
 * runs under way.
 *
 * Each step either works or fails on its own; a step whose templates (or "for each") use a step
 * that failed or was skipped is skipped (`dependencyFailed`). Webhooks and HTTP requests are tried
 * again (MAX_WEBHOOK_ATTEMPTS, see retryDelayMs), and a wait step waits in the queue: the steps
 * after them wait too, and the run goes on later from where it was. An approval step waits the
 * same way, until it is answered or its time is up (./approval.ts); rejected, the run stops. What each step gave later
 * steps is kept in the run's `state` while it runs (cleared when it ends); the history keeps each
 * step's input and output with credentials masked (lib/redact), cut to MAX_HTTP_RESPONSE_BYTES.
 * Finished runs are kept for RUN_HISTORY_DAYS.
 */

const SWEEP_INTERVAL_MS = 5_000;
const BATCH = 20;
/** A run taken this long ago and not finished belongs to a worker that stopped: it's taken again. */
const STALE_MS = 10 * 60_000;
/** A run taken this many times without finishing or waiting on purpose (one that stops the worker, say) fails. */
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
/** Values the history keeps of a step's input or output (other than an HTTP answer): about this much JSON. */
const HISTORY_BYTES = 16 * 1024;

type Run = typeof automationRun.$inferSelect;
type Automation = typeof databaseAutomation.$inferSelect;
type Row = { id: string; title: string; parentId: string | null; workspaceId: string; archivedAt: Date | null; properties: Record<string, unknown> };
type Prop = Awaited<ReturnType<typeof getProperties>>[number];

/**
 * Takes due runs, marking them running, so two sweeps never take the same one. Databases take
 * turns: the oldest due run of each first, then the second oldest, so runs piled up in one
 * database don't hold back the automations of every other.
 */
async function claim(): Promise<Run[]> {
  const due = (run: string) => sql`
    (${sql.raw(run)}.status = 'pending' and ${sql.raw(run)}.next_at <= now())
    or (${sql.raw(run)}.status = 'running' and ${sql.raw(run)}.next_at <= now() - make_interval(secs => ${STALE_MS / 1000}))`;
  // Picked first and locked a level up, as Postgres doesn't lock rows next to a window function;
  // a run another sweep took in between is no longer due and is left out.
  const taken = await db.execute<{ id: string }>(sql`
    update ${automationRun} set status = 'running', attempts = attempts + 1, next_at = now()
    where id in (
      select r.id from ${automationRun} r
      where r.id in (
        select id from (
          select d.id, d.next_at, row_number() over (partition by a.database_id order by d.next_at) as turn
          from ${automationRun} d join ${databaseAutomation} a on a.id = d.automation_id
          where ${due("d")}
        ) turns
        order by turn, next_at
        limit ${BATCH}
      )
      and (${due("r")})
      for update of r skip locked
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
  steps.map((step) => (step.status === "pending" ? { ...step, status, code, waitUntil: undefined } : step));

/** The steps a run does: a test run's own, else its version's (the automation's live ones when that is gone). */
async function definitionOf(run: Run, automation: Automation): Promise<AutomationDefinition> {
  if (run.definition) return run.definition;
  const [version] = await db
    .select()
    .from(automationVersion)
    .where(and(eq(automationVersion.automationId, run.automationId), eq(automationVersion.version, run.version)));
  if (version) return { trigger: version.trigger, actions: version.actions, timeZone: version.timeZone };
  return { trigger: automation.trigger, actions: automation.actions, timeZone: automation.timeZone };
}

// ----------------------------------------------------------------------------- history values

/** Header names whose values are credentials even when lib/redact wouldn't think so. */
const SECRET_HEADER = /auth|token|key|secret|signature|cookie|session|password/i;

/** Headers as the history shows them: credentials masked. */
export function maskHeaders(headers: Record<string, string> | { name: string; value: string }[]) {
  const entries = Array.isArray(headers) ? headers.map((h) => [h.name, h.value] as const) : Object.entries(headers);
  return Object.fromEntries(entries.map(([name, value]) => [name, isCredentialKey(name) || SECRET_HEADER.test(name) ? REDACTED : redactText(value)]));
}

/** A value as the history keeps it: credentials masked, and cut when its JSON is longer than `limit`. */
export function forHistory(value: unknown, limit = HISTORY_BYTES): unknown {
  if (value === undefined) return undefined;
  const masked = redactValue(value);
  let text: string;
  try {
    text = JSON.stringify(masked);
  } catch {
    return String(masked);
  }
  if (text === undefined || Buffer.byteLength(text) <= limit) return masked;
  return { truncated: true, preview: text.slice(0, limit) };
}

// ------------------------------------------------------------------------------- the run

/** What a step works with: the automation, the run, whom it runs as, the templates' scope. */
type StepContext = {
  automation: Automation;
  run: Run;
  runAs: string;
  timeZone: string;
  row: Row | null;
  scope: TemplateScope;
  outputs: Record<string, unknown>;
};

class StepFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What a step that worked gives: its input and output for the history, its output for later steps. */
type StepResult = { input?: unknown; output?: unknown; raw?: unknown; httpStatus?: number; notified?: number; agentRunId?: string; agentRunIds?: string[]; items?: AutomationStepItem[]; failed?: string };

/** Does what is left of one run and saves how it went. */
export async function processRun(run: Run) {
  const [automation] = await db.select().from(databaseAutomation).where(eq(databaseAutomation.id, run.automationId));
  if (!automation) return; // deleted since: its runs went with it
  const definition = await definitionOf(run, automation);
  const actions = definition.actions;
  const ids = stepIds(actions);
  const rowRun = run.rowId !== null;
  const [row] = rowRun
    ? await db
        .select({
          id: page.id,
          title: page.title,
          parentId: page.parentId,
          workspaceId: page.workspaceId,
          archivedAt: page.archivedAt,
          properties: page.properties,
        })
        .from(page)
        .where(eq(page.id, run.rowId!))
    : [];
  // A test run runs as whoever started it; any other as who published the automation last.
  const runAs = run.test ? run.actorId : automation.runAs;

  let steps: AutomationStep[] = run.steps.length
    ? run.steps
    : actions.map((a, i) => ({ id: ids[i], type: a.type, status: "pending", attempts: 0 }) as AutomationStep);
  let payload = run.payload;
  let retryAt: Date | null = null;
  const state = { ...(run.state ?? {}) };
  const outputs: Record<string, unknown> = { ...(state.outputs ?? {}) };
  // A run from before versions whose automation changed while a webhook waited: what's left belongs to the old steps.
  const edited = steps.length !== actions.length || steps.some((s, i) => s.type !== actions[i].type);

  const waitsForTitle = () =>
    run.created &&
    !row?.title.trim() &&
    Date.now() - run.createdAt.getTime() < TITLE_WAIT_MS &&
    steps.some((s, i) => s.status === "pending" && actions[i].type === "webhook");

  if (edited) steps = endPending(steps, "changed", "skipped");
  else if (run.attempts > MAX_CLAIMS) steps = endPending(steps, "tooManyAttempts");
  else if (!automation.enabled && !run.test) steps = endPending(steps, "disabled", "skipped");
  else if (rowRun && (!row || row.archivedAt || row.parentId !== automation.databaseId)) steps = endPending(steps, "rowGone", "skipped");
  else if (!runAs || !(await canManage(runAs, automation.databaseId))) {
    steps = endPending(steps, "noAccess");
  } else if (waitsForTitle()) {
    retryAt = new Date(Date.now() + TITLE_POLL_MS);
  } else {
    // The trigger as templates see it, worked out once: a run that waits sees the same one later.
    state.trigger ??= await triggerScope(automation, run, definition, row ?? null, runAs);
    const ctx: StepContext = {
      automation,
      run,
      runAs,
      timeZone: automationZone(definition.timeZone),
      row: row ?? null,
      scope: { ...outputs, trigger: state.trigger },
      outputs,
    };
    let live: Promise<Set<string>> | undefined;
    const liveIds = () => (live ??= getProperties(automation.databaseId).then((props) => new Set(props.map((p) => p.id))));
    for (const [i, action] of actions.entries()) {
      const step = steps[i];
      if (!step || step.status !== "pending") continue;
      // A step that uses what a failed or skipped step would have given is skipped.
      const uses = [...templateRoots(action), ...(forEachOf(action) ? [forEachOf(action)!] : [])];
      // A test run's approval asked nobody: what uses its answer goes on without one.
      const broken = uses.find((root) => {
        const at = ids.indexOf(root);
        return at >= 0 && at < i && steps[at].status !== "done" && steps[at].code !== APPROVAL_TEST_CODE;
      });
      if (broken) {
        Object.assign(step, { status: "skipped", code: "dependencyFailed", error: `Uses the output of "${broken}", which didn't run` });
        continue;
      }
      const started = Date.now();
      // An approval asked once is taken again only to read its answer: that is no new try.
      if (!(action.type === "approval" && step.approval)) {
        step.attempts += 1;
        step.startedAt = new Date(started).toISOString();
      }
      let result: StepResult | undefined;
      try {
        if (action.type === "wait") {
          // Waits in the queue: the first time sets when it goes on, a later take goes on.
          if (!step.waitUntil) step.waitUntil = new Date(started + action.minutes * 60_000).toISOString();
          step.input = { minutes: action.minutes };
          if (Date.parse(step.waitUntil) > Date.now()) {
            retryAt = new Date(step.waitUntil);
            break;
          }
          Object.assign(step, { status: "done", output: { until: step.waitUntil } });
          outputs[ids[i]] = ctx.scope[ids[i]] = { until: step.waitUntil };
          continue;
        }
        if (action.type === "approval") {
          const outcome = await approvalStep(ctx, action, ids[i], i, actions, step);
          if (outcome === "wait") {
            retryAt = new Date(step.approval!.expiresAt);
            break;
          }
          if (outcome === "stop") {
            // Rejected, or not answered in time: the steps after it don't run.
            steps = endPending(steps, step.approval?.answer === "rejected" ? "rejected" : "timedOut", "skipped");
            break;
          }
          continue;
        }
        if (action.type === "set_properties" && !action.forEach) {
          // Values of deleted properties aren't set; with nothing else to set, the step is skipped.
          const liveSet = await liveIds();
          const values = Object.fromEntries(Object.entries(action.values).filter(([id]) => liveSet.has(id)));
          if (Object.keys(action.values).length && !Object.keys(values).length) {
            Object.assign(step, { status: "skipped", code: "propertyDeleted" });
            continue;
          }
          result = await setProperties(ctx, run.rowId!, automation.databaseId, values, ctx.scope);
        } else if (action.type === "notify" && !action.forEach) {
          // The people of a deleted person property aren't told.
          const liveSet = await liveIds();
          result = await notify(ctx, row ?? null, { ...action, propertyIds: action.propertyIds.filter((id) => liveSet.has(id)) }, ctx.scope);
        } else if (action.type === "run_agent" && !action.forEach) {
          // Queued once (a retry of the run doesn't queue it again); it runs apart, as the agent.
          const prompt = resolveText(action.prompt, ctx.scope).value;
          step.agentRunId ??= await queueAgentRun({
            agentId: action.agentId,
            workspaceId: automation.workspaceId,
            source: { kind: "automation", automationId: automation.id, automationRunId: run.id, databaseId: automation.databaseId, rowId: run.rowId! },
            context: {
              created: run.created,
              changed: run.changed,
              actorId: run.actorId,
              ...(run.boundTo ? { boundTo: run.boundTo } : {}),
              ...(run.basis !== null ? { datePassed: run.basis } : {}),
            },
            prompt,
          });
          result = { input: { prompt }, output: { agentRunId: step.agentRunId }, agentRunId: step.agentRunId };
        } else if (forEachOf(action)) {
          result = await forEach(ctx, action, step);
        } else if (action.type === "move_to_trash") {
          // Always the last action (manage.checkActions): nothing is left to do on the row.
          await moveToTrash(automation, runAs, run.rowId!);
          result = { output: { trashed: true } };
        } else if (action.type === "webhook") {
          // A webhook sends the row out of the workspace: not while its owners have export off.
          if (!(await exportAllowed(automation.workspaceId))) throw new StepFailure("webhookExportOff", "The workspace's owners turned export off");
          // The row as it is now (after the actions before this one); its retries send the same.
          if (step.attempts === 1 || !payload) payload = await webhookPayload(automation, run, row!, runAs);
          const status = await sendWebhook(action.url, {
            id: run.id,
            event: runEvent(run),
            body: payload,
            secret: webhookSecret(automation.secretSalt),
          });
          result = { output: { status }, httpStatus: status };
        } else if (action.type === "http_request") {
          result = await httpRequest(ctx, action, step);
        } else if (action.type === "find_rows") {
          result = await findRows(ctx, action);
        } else if (action.type === "create_row") {
          result = await createRow(ctx, action, ctx.scope);
        } else if (action.type === "upsert_row") {
          result = await upsertRow(ctx, action, ctx.scope);
        } else if (action.type === "log") {
          const message = resolveText(action.message, ctx.scope);
          result = { input: missingNote({ message: action.message }, message.missing), output: { message: message.value } };
        }
        if (result) {
          const raw = finishStep(step, result);
          if (raw !== undefined) outputs[ids[i]] = ctx.scope[ids[i]] = raw;
        }
      } catch (error) {
        const httpStatus = error instanceof WebhookError || error instanceof HttpStepError ? error.httpStatus : null;
        const code = (error as { code?: string }).code ?? "error";
        const message = error instanceof Error ? error.message : String(error);
        Object.assign(step, { code, error: redactText(message).slice(0, 500), ...(httpStatus ? { httpStatus } : {}) });
        const failedInput = (error as { input?: unknown }).input;
        if (failedInput !== undefined) step.input = forHistory(failedInput);
        if (error instanceof HttpStepError && error.response) step.output = forHistory(responseForHistory(error.response), MAX_HTTP_RESPONSE_BYTES);
        const again =
          step.attempts < MAX_WEBHOOK_ATTEMPTS &&
          ((action.type === "webhook" &&
            error instanceof WebhookError &&
            error.code !== "invalidUrl" &&
            error.code !== "blocked" &&
            retriable(httpStatus)) ||
            (action.type === "http_request" &&
              error instanceof HttpStepError &&
              (error.code === "unreachable" || error.code === "timeout" || error.code === "http") &&
              httpRetriable(httpStatus)));
        if (again) {
          // Steps run in order: the ones after it wait for it.
          retryAt = new Date(Date.now() + retryDelayMs(step.attempts));
          step.durationMs = Date.now() - started;
          break;
        }
        step.status = "failed";
      }
      step.durationMs = Date.now() - started;
    }
  }

  // A run that counts from the row's last edit doesn't count its own edit as one.
  const trigger = definition.trigger;
  if (trigger.type === "date_passed" && trigger.date === "last_edited_time" && run.basis !== null && run.rowId) {
    if (steps.some((s, i) => s.status === "done" && actions[i]?.type === "set_properties" && !forEachOf(actions[i]))) {
      await followOwnEdit(automation.id, run.rowId);
    }
  }

  const status = runStatusOf(steps);
  // A run that ended some other way while an approval waited: the question goes from the queue.
  if (status !== "pending") {
    await closeApprovals(steps.flatMap((s) => (s.type === "approval" && s.approval?.changeId && !s.approval.answer ? [s.approval.changeId] : [])));
  }
  await db
    .update(automationRun)
    .set({
      steps,
      payload,
      status,
      nextAt: retryAt ?? new Date(),
      // Waiting on purpose (a wait step, a retry) isn't a take that came to nothing.
      ...(retryAt ? { attempts: 0 } : {}),
      // What steps gave later ones is only needed while the run goes on.
      state: status === "pending" ? { ...state, outputs } : null,
      finishedAt: status === "pending" ? null : new Date(),
    })
    .where(eq(automationRun.id, run.id));
  // Answered while this take ran (its wake found the run running): it goes on now, not at the expiry.
  const asked = status === "pending" ? waitingApproval(steps) : null;
  if (asked?.approval?.changeId && !(await stillWaiting(asked.approval.changeId))) {
    await db.update(automationRun).set({ nextAt: new Date() }).where(and(eq(automationRun.id, run.id), eq(automationRun.status, "pending")));
    kickAutomations();
  }
}

/**
 * An approval step, each time the run is taken: the first time it asks (./approval.ts); later it
 * reads the answer. "wait" while nobody answered; "stop" when rejected or, unanswered in time,
 * when it stops then; "next" when approved or it goes on anyway, with its output for later steps.
 */
async function approvalStep(
  ctx: StepContext,
  action: Extract<AutomationAction, { type: "approval" }>,
  stepId: string,
  index: number,
  actions: AutomationAction[],
  step: AutomationStep,
): Promise<"wait" | "stop" | "next"> {
  if (!step.approval) {
    let asked;
    try {
      asked = await askApproval({ automation: ctx.automation, run: ctx.run, row: ctx.row, action, stepId, index, actions, scope: ctx.scope });
    } catch (error) {
      if (error instanceof ApprovalStepError) throw new StepFailure(error.code, error.message);
      throw error;
    }
    step.approval = asked.state;
    step.input = forHistory(missingNote({ message: asked.message, approvers: asked.state.approvers.map((a) => a.name), timeoutDays: action.timeoutDays, onTimeout: action.onTimeout }, asked.missing));
    if (asked.state.test) {
      // A test run asks nobody: the step says whom it would have asked, and the run goes on.
      const output = { approved: null, approved_by: null, answered_at: null };
      Object.assign(step, { status: "skipped", code: APPROVAL_TEST_CODE, output });
      ctx.outputs[stepId] = ctx.scope[stepId] = output;
      return "next";
    }
  }
  const answer = await readAnswer(step.approval.changeId);
  if (answer.answer === "waiting") return "wait";
  const answeredAt = answer.answer === "timedOut" ? null : answer.at;
  step.approval = { ...step.approval, answer: answer.answer, answeredBy: answer.answer === "timedOut" ? null : answer.by, answeredAt };
  const output = {
    approved: answer.answer === "approved",
    approved_by: answer.answer === "approved" ? answer.by : null,
    answered_at: answeredAt,
    ...(answer.answer === "rejected" ? { rejected_by: answer.by } : {}),
    ...(answer.answer === "timedOut" ? { timed_out: true } : {}),
  };
  step.output = forHistory(output);
  if (step.startedAt) step.durationMs = Date.now() - Date.parse(step.startedAt);
  if (answer.answer === "approved" || (answer.answer === "timedOut" && action.onTimeout === "continue")) {
    Object.assign(step, { status: "done", code: answer.answer === "timedOut" ? "timedOut" : undefined });
    ctx.outputs[stepId] = ctx.scope[stepId] = output;
    return "next";
  }
  Object.assign(step, { status: "stopped", code: answer.answer === "rejected" ? "rejected" : "timedOut" });
  return "stop";
}

/**
 * Marks a step done (or failed, for a "for each" with rows that failed) with what it gave; returns
 * its output for later steps.
 */
function finishStep(step: AutomationStep, result: StepResult): unknown {
  if (result.input !== undefined) step.input = forHistory(result.input);
  if (result.output !== undefined) step.output = forHistory(result.output, step.type === "http_request" ? MAX_HTTP_RESPONSE_BYTES : HISTORY_BYTES);
  if (result.httpStatus) step.httpStatus = result.httpStatus;
  if (result.notified !== undefined) step.notified = result.notified;
  if (result.agentRunId) step.agentRunId = result.agentRunId;
  if (result.agentRunIds) step.agentRunIds = result.agentRunIds;
  if (result.items) step.items = result.items;
  Object.assign(step, { code: undefined, error: undefined });
  if (result.failed) {
    Object.assign(step, { status: "failed", code: "rowsFailed", error: result.failed });
    return undefined;
  }
  step.status = "done";
  return result.raw !== undefined ? result.raw : result.output;
}

/** The input, with the templates that led nowhere when there were any. */
const missingNote = <T extends object>(input: T, missing: string[]) => (missing.length ? { ...input, missing: [...new Set(missing)] } : input);

async function canManage(userId: string, databaseId: string) {
  try {
    const database = await requireDatabase(userId, databaseId, "full");
    return !database.archivedAt;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------- the trigger

const rowUrl = (workspaceId: string, id: string) => `${env.appUrl}/w/${workspaceId}/p/${id}`;

/** A database row as templates see it: its id, title and link, and its values by property name. */
function rowScope(workspaceId: string, row: { id: string; title: string; properties: Record<string, unknown> }, props: PropertyDef[], lookups: Parameters<typeof displayProperties>[2]) {
  return {
    ...displayProperties(props, row.properties, lookups, env.appUrl),
    id: row.id,
    title: pageLabel(row.title),
    url: rowUrl(workspaceId, row.id),
  };
}

/**
 * What `{{trigger.…}}` is. A row's run: the row as the automation's person sees it (its values by
 * property name, its id, title and link), with `changes.<Property>.before/after` for a change,
 * `actor` and `event`, and `date` for "date passed". An incoming webhook's: its JSON body. A
 * schedule's: when it was due.
 */
async function triggerScope(automation: Automation, run: Run, definition: AutomationDefinition, row: Row | null, runAs: string): Promise<unknown> {
  const data = run.triggerData ?? {};
  if (run.origin === "incoming_webhook") return data.body ?? {};
  const [database] = await db.select({ title: page.title }).from(page).where(eq(page.id, automation.databaseId));
  const databaseInfo = { id: automation.databaseId, title: pageLabel(database?.title ?? ""), url: rowUrl(automation.workspaceId, automation.databaseId) };
  if (run.origin === "schedule" || !hasRow(definition.trigger) || !row) {
    return { event: runEvent(run), scheduledFor: data.scheduledFor ?? null, database: databaseInfo };
  }
  const { properties, row: loaded, relations, people } = await getRow(runAs, row.id);
  const lookups = { relations, people };
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const changed = (data.changes ?? {}) as Record<string, { before: unknown; after: unknown }>;
  for (const [id, change] of Object.entries(changed)) {
    const prop = properties.find((p) => p.id === id);
    if (!prop) continue; // one the automation's person can't see stays out
    const show = (value: unknown) => displayProperties([prop as PropertyDef], { [id]: value }, lookups, env.appUrl)[prop.name] ?? null;
    changes[prop.name] = { before: show(change.before), after: show(change.after) };
  }
  const [actor] = run.actorId && !run.test ? await db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, run.actorId)) : [];
  return {
    ...rowScope(automation.workspaceId, loaded, properties as PropertyDef[], lookups),
    event: runEvent(run),
    database: databaseInfo,
    changes,
    actor: actor ?? null,
    ...(run.basis !== null ? { date: run.basis } : {}),
  };
}

// -------------------------------------------------------------------------- row values

/**
 * A step's values for a row of `databaseId`, by property id, with templates written in: a value
 * that is one template keeps what it finds (rows and people give their ids to relation and person
 * properties); text is text. A template that leads nowhere clears the property.
 */
async function resolveRowValues(ctx: StepContext, databaseId: string, values: Record<string, unknown>, scope: TemplateScope) {
  const props = await getProperties(databaseId);
  const patch: Record<string, unknown> = {};
  const shown: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [id, value] of Object.entries(values)) {
    const prop = props.find((p) => p.id === id);
    if (!prop) continue; // deleted since
    let out: unknown;
    if (isDynamicValue(value)) {
      // The day in the automation's time zone (whoever saved it last), the one "date passed" counts in.
      if (value.$ === "now") out = dayString(localDay(Date.now(), ctx.timeZone));
      // Nobody to set when an anonymous form answer (or a schedule) started it: the value stays as it is.
      else if (ctx.run.actorId) out = [ctx.run.actorId];
      else continue;
    } else out = coerce(prop, resolveValue(value, scope, missing).value);
    patch[id] = out;
    shown[prop.name] = out;
  }
  return { patch, shown, missing };
}

/** A resolved value made fit for the property it goes into. */
function coerce(prop: Prop, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (prop.type === "relation" || holdsPeople(prop.type) || prop.type === "multi_select" || prop.type === "files") {
    if (prop.type === "files") return value;
    return idsOf(value);
  }
  if (prop.type === "number") {
    if (typeof value === "number") return value;
    const n = Number(textOf(value).trim());
    return Number.isFinite(n) && textOf(value).trim() !== "" ? n : textOf(value);
  }
  if (prop.type === "checkbox") {
    if (typeof value === "boolean") return value;
    const text = textOf(value).trim().toLowerCase();
    return text === "true" || text === "yes" || text === "1";
  }
  if (prop.type === "checklist") return value;
  if (typeof value === "object") return textOf(value);
  return value;
}

async function setProperties(ctx: StepContext, rowId: string, databaseId: string, values: Record<string, unknown>, scope: TemplateScope): Promise<StepResult> {
  const { patch, shown, missing } = await resolveRowValues(ctx, databaseId, values, scope);
  if (Object.keys(patch).length) await asAutomation(() => updateRowProperties(ctx.runAs, rowId, patch));
  return { input: missingNote({ row: rowId, values: shown }, missing), output: { id: rowId, values: shown } };
}

/**
 * Moves the row to the trash as the automation's person, the way they would, and records it in
 * the audit log with the automation as the one who did it (rows a person trashes aren't recorded
 * one by one; rows an automation trashes are, as nobody watched it happen).
 */
async function moveToTrash(automation: Automation, runAs: string, rowId: string) {
  await runAsAuditOrigin({ kind: "automation", name: automation.name }, async () => {
    const row = await asAutomation(() => archivePage(runAs, rowId));
    await recordAudit({
      workspaceId: row.workspaceId,
      actorId: runAs,
      action: "page.trashed",
      target: { type: "page", id: row.id, label: row.title },
      details: { kind: row.kind, automationId: automation.id, databaseId: automation.databaseId },
    });
  });
}

/**
 * Tells the action's people, and whoever its person properties name in the row now, as long as
 * they can open the row (the database, for a run without a row). Returns how many were told.
 */
async function notify(
  ctx: StepContext,
  row: Pick<Row, "id" | "workspaceId" | "properties"> | null,
  action: Extract<AutomationAction, { type: "notify" }>,
  scope: TemplateScope,
): Promise<StepResult> {
  const { automation, run } = ctx;
  const message = action.message ? resolveText(action.message, scope) : null;
  const text = message?.value.trim() ? message.value.trim().slice(0, 2000) : null;
  const input = missingNote({ message: text }, message?.missing ?? []);
  const fromRow = row
    ? action.propertyIds.flatMap((id) => {
        const value = row.properties[id];
        return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      })
    : [];
  const candidates = [...new Set([...action.userIds, ...fromRow])];
  if (!candidates.length) return { input, output: { notified: 0 }, notified: 0 };
  const pageId = row?.id ?? automation.databaseId;
  const existing = new Set(
    // Agents' users have no inbox.
    (await db.select({ id: user.id }).from(user).where(and(inArray(user.id, candidates), notAgentUser(user.id)))).map((u) => u.id),
  );
  const levels = await Promise.all(
    candidates
      .filter((userId) => existing.has(userId))
      .map(async (userId) => {
        const { level } = await resolvePageAccess(userId, pageId).catch(() => ({ level: "none" as const }));
        return { userId, level };
      }),
  );
  const recipients = levels.filter((r) => r.level !== "none").map((r) => r.userId);
  if (!recipients.length) return { input, output: { notified: 0 }, notified: 0 };
  const emailDueAt = new Date(Date.now() + EMAIL_DELAY_MS);
  const inserted = await db
    .insert(notification)
    .values(
      recipients.map((userId) => ({
        userId,
        workspaceId: automation.workspaceId,
        kind: "automation" as const,
        actorId: run.test ? null : run.actorId,
        pageId,
        automationId: automation.id,
        // A "date passed" run: the row's date it ran for, so the notification says so.
        date: row && row.id === run.rowId ? run.basis : null,
        message: text,
        emailDueAt,
      })),
    )
    .returning({ id: notification.id });
  signalInbox(automation.workspaceId);
  pushNotifications(inserted.map((n) => n.id));
  return { input, output: { notified: recipients.length }, notified: recipients.length };
}

/**
 * The body every try of the run's webhooks sends: the row as the automation's person sees it
 * when it's first sent (after the run's earlier actions), and which properties changed.
 */
async function webhookPayload(automation: Automation, run: Run, row: Row, runAs: string) {
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
    event: runEvent(run),
    created_at: run.createdAt.toISOString(),
    automation: { id: automation.id, name: automation.name },
    workspace_id: row.workspaceId,
    database: { id: automation.databaseId, title: pageLabel(database?.title ?? ""), url: url(automation.databaseId) },
    row: { id: row.id, title: pageLabel(row.title), url: url(row.id), properties: fields.properties },
    changed: run.changed.flatMap((id) => (visible.has(id) ? [visible.get(id)!] : [])),
    actor: actor[0] ? { id: actor[0].id, name: actor[0].name } : null,
    // A "date passed" run: the row's date it ran for.
    ...(run.basis !== null ? { date: run.basis } : {}),
    ...(run.test ? { test: true } : {}),
  });
}

// -------------------------------------------------------------------------- HTTP requests

const responseForHistory = (response: { status: number; headers: Record<string, string>; body: unknown; truncated?: boolean }) => ({
  ...response,
  headers: maskHeaders(response.headers),
});

async function httpRequest(ctx: StepContext, action: Extract<AutomationAction, { type: "http_request" }>, step: AutomationStep): Promise<StepResult> {
  // A request sends what it likes out of the workspace: not while its owners have export off.
  if (!(await exportAllowed(ctx.automation.workspaceId))) throw new StepFailure("webhookExportOff", "The workspace's owners turned export off");
  const missing: string[] = [];
  const url = resolveText(action.url, ctx.scope);
  missing.push(...url.missing);
  const headers = action.headers.map((h) => {
    const value = resolveText(h.value, ctx.scope);
    missing.push(...value.missing);
    return { name: h.name, value: value.value };
  });
  const body = action.body === undefined ? undefined : resolveValue(action.body, ctx.scope, missing).value;
  step.input = forHistory(missingNote({ method: action.method, url: redactText(url.value), headers: maskHeaders(headers), ...(body !== undefined ? { body } : {}) }, missing));
  if (!url.value.trim()) throw new StepFailure("invalidUrl", url.missing.length ? `The address is empty: {{${url.missing[0]}}} led nowhere` : "The address is empty");
  const response = await sendRequest({ method: action.method, url: url.value, headers, body });
  return { output: responseForHistory(response), raw: response, httpStatus: response.status };
}

// -------------------------------------------------------------------------------- rows

/** A database of the automation's workspace the automation's person can open at `level`. */
async function targetDatabase(ctx: StepContext, databaseId: string, level: "view" | "edit") {
  let database;
  try {
    database = await requireDatabase(ctx.runAs, databaseId, level);
  } catch {
    throw new StepFailure("noAccess", level === "view" ? "The automation's person can't open the database" : "The automation's person can't add or change rows in the database");
  }
  if (database.workspaceId !== ctx.automation.workspaceId || database.archivedAt) throw new StepFailure("databaseGone", "The database is gone or in the trash");
  return database;
}

/**
 * A templated filter value as the stored filter holds it: templates give what a row shows (an
 * option's name, a person or row as {id, name}), filters compare ids, so names of options become
 * their ids and people and rows their ids; a day keeps its date, a number and a checkbox their type.
 */
function filterValue(prop: DatabaseProperty | undefined, list: boolean, resolved: unknown): unknown {
  const options = prop && holdsOptions(prop.type) ? ((prop.options as { options?: { id: string; name: string }[] }).options ?? []) : null;
  const toOption = (v: unknown) => {
    if (!options) return v;
    const text = textOf(v).trim().toLowerCase();
    return options.find((o) => o.id === v || o.name.trim().toLowerCase() === text)?.id ?? textOf(v);
  };
  const byId = prop && (prop.type === "relation" || holdsPeople(prop.type));
  if (list) return (idsOf(resolved) as unknown[]).map(toOption);
  if (byId) return (idsOf(resolved) as unknown[])[0] ?? null;
  if (options) return toOption(resolved);
  if (resolved !== null && typeof resolved === "object") return textOf(resolved);
  if (prop?.type === "number" && typeof resolved === "string" && resolved.trim() && Number.isFinite(Number(resolved))) return Number(resolved);
  if (prop?.type === "checkbox" && (resolved === "true" || resolved === "false")) return resolved === "true";
  if (prop?.type === "date" && typeof resolved === "string" && /^\d{4}-\d{2}-\d{2}/.test(resolved)) return resolved.slice(0, 10);
  return resolved;
}

async function findRows(ctx: StepContext, action: Extract<AutomationAction, { type: "find_rows" }>): Promise<StepResult> {
  const database = await targetDatabase(ctx, action.databaseId, "view");
  const missing: string[] = [];
  let empty: string | null = null;
  const props = await getProperties(action.databaseId);
  // Filter values may be templates; one that leads nowhere would match everything or nothing, so it's an error.
  const filters = mapFilterRules(action.filters ?? [], (rule) => {
    if (rule.value === undefined || !templateRoots(rule.value).size) return rule;
    const resolved = resolveValue(rule.value, ctx.scope, missing).value;
    if (resolved === null || resolved === "" || (Array.isArray(resolved) && !resolved.length)) empty ??= rule.propertyId;
    const prop = props.find((p) => p.id === rule.propertyId);
    return { ...rule, value: filterValue(prop, Array.isArray(rule.value), resolved) };
  });
  const input = missingNote({ database: { id: database.id, title: pageLabel(database.title) }, filters, sorts: action.sorts ?? [], limit: action.limit }, missing);
  if (empty) {
    const name = props.find((p) => p.id === empty)?.name ?? empty;
    throw Object.assign(new StepFailure("emptyFilter", `The filter on "${name}" has no value: ${missing.map((m) => `{{${m}}}`).join(", ")} led nowhere`), { input });
  }
  const rows = (await viewedRows(ctx.runAs, action.databaseId, { filters, filterCombinator: action.filterCombinator, sorts: action.sorts }, undefined, { timeZone: ctx.timeZone })).slice(
    0,
    Math.min(action.limit, MAX_FOUND_ROWS),
  );
  const access = await propertyAccessFor(ctx.runAs, action.databaseId);
  const visible = access.visible(props) as DatabaseProperty[];
  const lookups = await getLookups(ctx.runAs, visible);
  const found = rows.map((r) => ({ ...rowScope(database.workspaceId, r, visible as PropertyDef[], lookups), databaseId: database.id }));
  const output = { rows: found, count: found.length, first: found[0] ?? null };
  return { input, output: { count: found.length, rows: found }, raw: output };
}

/** The rows a "for each" goes over: what its find_rows step found. */
function foundRows(ctx: StepContext, stepId: string) {
  const found = ctx.outputs[stepId] as { rows?: { id: string; title: string; databaseId: string }[] } | undefined;
  return (found?.rows ?? []).slice(0, MAX_FOUND_ROWS);
}

/** Does a row step once for each found row, each with `{{item.…}}` set to that row. */
async function forEach(ctx: StepContext, action: AutomationAction, step: AutomationStep): Promise<StepResult> {
  const over = forEachOf(action)!;
  const rows = foundRows(ctx, over);
  const items: AutomationStepItem[] = [];
  const outputs: unknown[] = [];
  const agentRunIds: string[] = step.agentRunIds ? [...step.agentRunIds] : [];
  let notified = 0;
  for (const [n, item] of rows.entries()) {
    const scope = { ...ctx.scope, item };
    try {
      if (action.type === "set_properties") {
        const result = await setProperties(ctx, item.id, item.databaseId, action.values, scope);
        outputs.push(result.output);
      } else if (action.type === "notify") {
        const [loaded] = await db.select({ id: page.id, workspaceId: page.workspaceId, properties: page.properties }).from(page).where(eq(page.id, item.id));
        if (!loaded) throw new StepFailure("rowGone", "The row is gone");
        const result = await notify(ctx, loaded, action, scope);
        notified += result.notified ?? 0;
        outputs.push(result.output);
      } else if (action.type === "run_agent") {
        // A run taken again finds the agent runs it already queued (queueAgentRun is idempotent per row).
        const prompt = resolveText(action.prompt, scope).value;
        const webhookRun = ctx.run.origin === "incoming_webhook";
        const id = await queueAgentRun({
          agentId: action.agentId,
          workspaceId: ctx.automation.workspaceId,
          source: { kind: "automation", automationId: ctx.automation.id, automationRunId: ctx.run.id, databaseId: item.databaseId, rowId: item.id },
          // A request from outside is nobody's: the agent is held to the automation's person and asks before calling out.
          context: {
            created: false,
            changed: [],
            actorId: webhookRun ? null : (ctx.run.actorId ?? ctx.runAs),
            ...(webhookRun ? { boundTo: ctx.runAs } : ctx.run.boundTo ? { boundTo: ctx.run.boundTo } : {}),
          },
          prompt,
        });
        if (!agentRunIds[n]) agentRunIds[n] = id;
        outputs.push({ agentRunId: id });
      }
      items.push({ rowId: item.id, title: item.title, status: "done" });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "error";
      items.push({ rowId: item.id, title: item.title, status: "failed", code, error: redactText(error instanceof Error ? error.message : String(error)).slice(0, 300) });
      outputs.push(null);
    }
  }
  const failed = items.filter((i) => i.status === "failed").length;
  return {
    input: { forEach: over, rows: rows.length },
    output: { count: rows.length, done: rows.length - failed, failed },
    raw: { count: rows.length, items: outputs },
    items,
    ...(action.type === "notify" ? { notified } : {}),
    ...(action.type === "run_agent" ? { agentRunIds } : {}),
    ...(failed ? { failed: `${failed} of ${rows.length} rows failed` } : {}),
  };
}

async function createRow(ctx: StepContext, action: Extract<AutomationAction, { type: "create_row" }>, scope: TemplateScope): Promise<StepResult> {
  const database = await targetDatabase(ctx, action.databaseId, "edit");
  const title = action.title ? resolveText(action.title, scope) : { value: "", missing: [] };
  const { patch, shown, missing } = await resolveRowValues(ctx, action.databaseId, action.values, scope);
  const input = missingNote({ database: { id: database.id, title: pageLabel(database.title) }, title: title.value, values: shown }, [...title.missing, ...missing]);
  const [created] = await asAutomation(() => createRows(ctx.runAs, action.databaseId, [{ title: title.value.trim(), properties: patch }]));
  const output = { id: created.id, title: pageLabel(created.title), url: rowUrl(database.workspaceId, created.id), created: true };
  return { input, output };
}

async function upsertRow(ctx: StepContext, action: Extract<AutomationAction, { type: "upsert_row" }>, scope: TemplateScope): Promise<StepResult> {
  const database = await targetDatabase(ctx, action.databaseId, "edit");
  const match = resolveText(action.matchValue, scope);
  const needle = match.value.trim();
  const title = action.title ? resolveText(action.title, scope) : null;
  const { patch, shown, missing } = await resolveRowValues(ctx, action.databaseId, action.values, scope);
  const props = await getProperties(action.databaseId);
  const matchProp = action.matchPropertyId === "title" ? null : props.find((p) => p.id === action.matchPropertyId);
  const input = missingNote(
    { database: { id: database.id, title: pageLabel(database.title) }, match: { property: matchProp?.name ?? "title", value: needle }, ...(title ? { title: title.value } : {}), values: shown },
    [...match.missing, ...(title?.missing ?? []), ...missing],
  );
  if (!needle) throw Object.assign(new StepFailure("emptyMatch", match.missing.length ? `The value to match is empty: {{${match.missing[0]}}} led nowhere` : "The value to match is empty"), { input });
  if (action.matchPropertyId !== "title" && !matchProp) throw new StepFailure("propertyDeleted", "The property to match on is deleted");
  // The first row (in the database's order) whose value, as text, is the same, case aside.
  const rows = await viewedRows(ctx.runAs, action.databaseId, {}, undefined, { timeZone: ctx.timeZone });
  const lookups = matchProp ? await getLookups(ctx.runAs, [matchProp as DatabaseProperty]) : null;
  const same = (r: (typeof rows)[number]) => {
    const value = matchProp ? displayProperties([matchProp as PropertyDef], r.properties, lookups!, env.appUrl)[matchProp.name] : pageLabel(r.title);
    return textOf(value).trim().toLowerCase() === needle.toLowerCase();
  };
  const existing = rows.find(same);
  if (existing) {
    const changes = { ...patch };
    if (Object.keys(changes).length) await asAutomation(() => updateRowProperties(ctx.runAs, existing.id, changes));
    if (title?.value.trim()) {
      await asAutomation(() => renamePage({ userId: ctx.runAs }, existing.id, title.value.trim()));
    }
    return { input, output: { id: existing.id, title: title?.value.trim() || pageLabel(existing.title), url: rowUrl(database.workspaceId, existing.id), created: false } };
  }
  const properties = { ...patch };
  if (matchProp && properties[matchProp.id] === undefined) properties[matchProp.id] = coerce(matchProp, needle);
  const newTitle = matchProp ? (title?.value.trim() ?? "") : needle;
  const [created] = await asAutomation(() => createRows(ctx.runAs, action.databaseId, [{ title: newTitle, properties }]));
  return { input, output: { id: created.id, title: pageLabel(created.title), url: rowUrl(database.workspaceId, created.id), created: true } };
}

// ------------------------------------------------------------------------------- worker

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
          console.error("automation run failed", redactError(error));
          await db
            .update(automationRun)
            .set({ status: "failed", steps: endPending(run.steps, "error"), state: null, finishedAt: new Date() })
            .where(eq(automationRun.id, run.id))
            .catch(() => undefined);
          await closeApprovals(run.steps.flatMap((s) => (s.approval?.changeId && !s.approval.answer ? [s.approval.changeId] : []))).catch(() => undefined);
        }
      }
      if (runs.length === BATCH) again = true;
    } while (again);
  } catch (error) {
    console.error("could not run automations", redactError(error));
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
        inArray(automationRun.status, [...FINISHED_RUN_STATUSES]),
        lte(automationRun.finishedAt, new Date(Date.now() - RUN_HISTORY_DAYS * 24 * 60 * 60_000)),
      ),
    )
    .catch((error) => console.error("could not prune automation runs", redactError(error)));
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
