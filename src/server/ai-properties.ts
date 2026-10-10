/**
 * AI autofill properties (#42): text properties whose values a model works out from the rest of
 * the row (see AiAutofillConfig in lib/ai). Values are stored like any text value; what is pending
 * or failed lives in `ai_property_state`.
 *
 * Values are worked out in the background by a queue shared by the whole process: at most
 * AI_CONCURRENCY at a time, each workspace within its AI_WORKSPACE_RATE_LIMIT (jobs wait for their
 * turn instead of failing). A job runs as the person who asked for it, with their access at the
 * time it runs: rows they can no longer edit are skipped, and only values they can see go into the
 * prompt. They ask by refreshing a row, "Update all rows" for a view's rows, or, for properties set
 * to follow their row, by changing the row (debounced; nothing runs when its inputs are the same).
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiPropertyState, databaseProperty, page, type PropertyOptions } from "@/db/schema";
import {
  checkAutofill,
  MAX_AUTOFILL_ROWS,
  MAX_AUTOFILL_VALUE,
  type AiAutofillConfig,
  type AiCellState,
  type AiErrorCode,
  type AutofillErrorCode,
} from "@/lib/ai";
import { PropertyValueError } from "@/lib/properties";
import { AccessError, hasLevel, pageAccessOf } from "@/server/access";
import { aiConfig, AiError, complete, describeAiSetup, isAiError, takeRateLimit, takeWorkspaceCapacity } from "@/server/ai";
import { autofillNeedsBody, autofillPrompt, cleanValue, formatValue, type Prompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { getCollab } from "@/server/collab/bridge";
import * as databases from "@/server/databases";
import { displayProperties } from "@/server/mcp/query";
import { compileFormulas, relatedDatabases } from "@/lib/derived";
import { formulaReferences } from "@/lib/property-access";
import { relatedSchemasFor } from "@/server/derived";
import { loadPropertyRules, propertyAccessFor, type AccessRow, type PropertyAccess } from "@/server/property-access";
import { onRowChanged, type RowChange } from "@/server/row-events";

type Property = databases.DatabaseProperty;

/** Autofill settings that don't fit the database; `code` names the problem for the UI. */
export class AutofillError extends Error {
  constructor(
    readonly code: AutofillErrorCode | "notText" | "databaseLocked",
    message: string,
    readonly params: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AutofillError";
  }
}

const notify = (databaseId: string, event: "rows" | "schema") => getCollab().broadcast(`db:${databaseId}`, event);

// ------------------------------------------------------------------------------- settings

/** The property's autofill settings checked against the database (throws AutofillError). */
export function validAutofill(input: unknown, properties: Property[], selfId?: string): AiAutofillConfig {
  const check = checkAutofill(input, properties, selfId);
  if (!check.ok) throw new AutofillError(check.code, `Invalid AI autofill settings (${check.code})`, check.params);
  return check.config;
}

/**
 * Turns autofill on (or changes it) for a text property, or off with `null`. Needs edit access to
 * an unlocked database, like other property settings, and AI on for the workspace. Values already
 * filled in stay; pending and failed states of the old settings are dropped.
 */
export async function setAutofill(userId: string, propertyId: string, input: AiAutofillConfig | null) {
  const [prop] = await db
    .select()
    .from(databaseProperty)
    .where(and(eq(databaseProperty.id, propertyId), isNull(databaseProperty.deletedAt)))
    .limit(1);
  if (!prop) throw new AccessError();
  const database = await databases.requireDatabase(userId, prop.databaseId, "edit");
  // Before anything tells what the property is: one they can't know of doesn't exist for them
  // (refused as a missing property is), and settings change the property itself.
  const access = await propertyAccessFor(userId, prop.databaseId);
  if (!access.visible([prop]).length) throw new AccessError();
  access.requireSchema(prop.id);
  if (database.lockedAt) throw new AutofillError("databaseLocked", "The database is locked");
  if (prop.type !== "text") throw new AutofillError("notText", "AI autofill works on text properties");
  let options: PropertyOptions;
  if (input === null) {
    const { ai: _, ...rest } = prop.options;
    options = rest;
  } else {
    if (!(await aiAvailable(database.workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
    // Only properties they may know of can be inputs: others read as unknown, as anywhere else.
    options = { ...prop.options, ai: validAutofill(input, access.visible(await databases.getProperties(prop.databaseId)), prop.id) };
  }
  await db.update(databaseProperty).set({ options }).where(eq(databaseProperty.id, propertyId));
  await db.delete(aiPropertyState).where(and(eq(aiPropertyState.propertyId, propertyId), inArray(aiPropertyState.status, ["pending", "error"])));
  notify(prop.databaseId, "schema");
  return options.ai ?? null;
}

/** Whether property access lets the person change the property's value in this row. */
function mayWrite(access: PropertyAccess, row: AccessRow, propertyId: string) {
  try {
    access.requireValues({ properties: row.properties, createdBy: row.createdBy }, [propertyId]);
    return true;
  } catch (error) {
    if (error instanceof PropertyValueError || error instanceof AccessError) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------------- queue

type Job = {
  rowId: string;
  propertyId: string;
  databaseId: string;
  workspaceId: string;
  userId: string;
  /** Asked for explicitly: runs even when the inputs didn't change. */
  force: boolean;
};

type Queue = {
  waiting: Job[];
  /** Keys of waiting jobs, jobs waiting for their workspace's allowance and running ones. */
  active: Set<string>;
  running: Map<string, { again?: Job }>;
  /** Automatic updates waiting for a row to settle, per row id. */
  debounce: Map<string, ReturnType<typeof setTimeout>>;
};

const KEY = "__leafdeskAiQueue";
const queue = ((globalThis as Record<string, unknown>)[KEY] ??= {
  waiting: [],
  active: new Set(),
  running: new Map(),
  debounce: new Map(),
} satisfies Queue) as Queue;

const jobKey = (job: { rowId: string; propertyId: string }) => `${job.rowId}:${job.propertyId}`;

/** Whether a value is waiting or being worked out in this process. */
export const isQueued = (rowId: string, propertyId: string) => queue.active.has(jobKey({ rowId, propertyId }));

/** Queues jobs (a job already waiting takes the newer request; a running one runs again after). */
function enqueue(jobs: Job[]) {
  for (const job of jobs) {
    const key = jobKey(job);
    const running = queue.running.get(key);
    if (running) {
      running.again = job;
      continue;
    }
    const at = queue.waiting.findIndex((j) => jobKey(j) === key);
    if (at >= 0) queue.waiting[at] = { ...job, force: job.force || queue.waiting[at].force };
    else if (!queue.active.has(key)) {
      queue.waiting.push(job);
      queue.active.add(key);
    }
  }
}

function pump() {
  const limit = aiConfig().limits.concurrency;
  while (queue.running.size < limit && queue.waiting.length) {
    const job = queue.waiting.shift()!;
    const key = jobKey(job);
    queue.running.set(key, {});
    void runJob(job).then((retryIn) => {
      const again = queue.running.get(key)?.again;
      queue.running.delete(key);
      if (again) {
        queue.active.delete(key);
        enqueue([again]);
      } else if (retryIn > 0) {
        // The workspace used up its allowance: try again when it has room, keeping the slot free.
        setTimeout(() => {
          queue.active.delete(key);
          enqueue([job]);
          pump();
        }, retryIn).unref?.();
      } else queue.active.delete(key);
      pump();
    });
  }
}

async function setState(
  job: Pick<Job, "rowId" | "propertyId" | "userId">,
  state: { status: "pending" | "done" | "error"; error?: AiErrorCode | null; sourceHash?: string | null },
) {
  const values = {
    rowId: job.rowId,
    propertyId: job.propertyId,
    status: state.status,
    error: state.error ?? null,
    requestedBy: job.userId,
    updatedAt: new Date(),
    ...(state.sourceHash !== undefined ? { sourceHash: state.sourceHash } : {}),
  };
  await db
    .insert(aiPropertyState)
    .values(values)
    .onConflictDoUpdate({ target: [aiPropertyState.rowId, aiPropertyState.propertyId], set: values })
    // The row or property may have been deleted meanwhile.
    .catch((error: { code?: string }) => {
      if (error?.code !== "23503") throw error;
    });
}

/**
 * The prompt for a row's value and a fingerprint of everything it depends on. `props`: the
 * properties the person may know of; values they may not see are left out by rowValues.
 */
async function rowInput(
  userId: string,
  row: databases.DatabaseRow & { createdBy: string | null; updatedBy: string | null; parentId: string | null },
  props: Property[], prop: Property) {
  const config = prop.options.ai!;
  const inputs = props.filter((p) => p.id !== prop.id);
  const values = await databases.rowValues(userId, row, props);
  // As the person sees them: option names, people and related rows they can see, by name.
  const shown = displayProperties(inputs, values, await databases.getLookups(userId, props));
  const text = Object.fromEntries(
    Object.entries(shown)
      .map(([name, value]) => [name, formatValue(value)] as const)
      .filter(([, value]) => value.trim()),
  );
  const body = autofillNeedsBody(config) ? (await getCollab().readPage(row.id)).markdown : "";
  const maxContent = Math.max(1_000, aiConfig().limits.maxInputChars - 3_000);
  const prompt: Prompt | null = autofillPrompt(
    config,
    { title: row.title, values: text, names: Object.fromEntries(inputs.map((p) => [p.id, p.name])), body },
    maxContent,
  );
  const hash = createHash("sha256").update(JSON.stringify({ config, prompt })).digest("hex");
  return { config, prompt, hash };
}

/**
 * Formulas reading a restricted property of related rows (or a formula there that reads one):
 * left out of autofill like formulas over restricted properties of the row itself.
 */
async function readingRestrictedRelated(props: Property[]): Promise<string[]> {
  const databaseIds = relatedDatabases(props);
  if (!databaseIds.length) return [];
  const [schemas, rules] = await Promise.all([relatedSchemasFor([props]), loadPropertyRules(databaseIds)]);
  // Restricted there: properties with rules, and the formulas reading them.
  const restricted = new Set(rules.keys());
  const related = databaseIds.flatMap((id) => schemas(id) ?? []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of related) {
      if (p.type !== "formula" || restricted.has(p.id)) continue;
      if (formulaReferences(p.options.formula?.expression ?? "").some((id) => restricted.has(id))) {
        restricted.add(p.id);
        grew = true;
      }
    }
  }
  const compiled = compileFormulas(props, schemas);
  return [...compiled.values()]
    .filter((f) => [...f.notes.reads.values()].some(({ field }) => field.id && restricted.has(field.id)))
    .map((f) => f.id);
}

/** Works out one value. Returns milliseconds to wait before retrying (workspace allowance), or 0. */
async function runJob(job: Job): Promise<number> {
  try {
    const { page: row, level } = await pageAccessOf(job.userId, job.rowId);
    if (!row || row.archivedAt || row.parentId !== job.databaseId || !hasLevel(level, "edit")) {
      throw new AiError("noAccess", "The row can't be changed by the person who asked");
    }
    if (!(await aiAvailable(job.workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
    const [all, access] = await Promise.all([databases.getProperties(job.databaseId), propertyAccessFor(job.userId, job.databaseId)]);
    const prop = all.find((p) => p.id === job.propertyId && p.type === "text" && p.options.ai);
    if (!prop) {
      await db.delete(aiPropertyState).where(and(eq(aiPropertyState.rowId, job.rowId), eq(aiPropertyState.propertyId, job.propertyId)));
      notify(job.databaseId, "rows");
      return 0;
    }
    // The value is written as the person who asked: only where they may change it (property access).
    if (!mayWrite(access, row, prop.id)) {
      // A follow-up of someone's edit leaves the value (and its state) alone; a request fails.
      if (!job.force) return 0;
      throw new AiError("noAccess", "The value can't be changed by the person who asked");
    }
    // Restricted properties never feed autofill, whoever asks: the value it writes can be read by
    // people the inputs are hidden from (the same reason search leaves them out).
    // Formulas reading them are left out too.
    const restricted = new Set((await loadPropertyRules([job.databaseId])).keys());
    for (const id of await readingRestrictedRelated(all)) restricted.add(id);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of all) {
        if (p.type !== "formula" || restricted.has(p.id)) continue;
        if (formulaReferences(p.options.formula?.expression ?? "").some((id) => restricted.has(id))) {
          restricted.add(p.id);
          grew = true;
        }
      }
    }
    const input = await rowInput(
      job.userId,
      row,
      access.visible(all).filter((p) => p.id === prop.id || !restricted.has(p.id)),
      prop,
    );
    if (!job.force) {
      const [state] = await db
        .select({ sourceHash: aiPropertyState.sourceHash, status: aiPropertyState.status })
        .from(aiPropertyState)
        .where(and(eq(aiPropertyState.rowId, job.rowId), eq(aiPropertyState.propertyId, job.propertyId)))
        .limit(1);
      if (state?.status === "done" && state.sourceHash === input.hash) return 0;
    }
    let value = "";
    if (input.prompt) {
      // Explicit requests were marked pending when asked for; automatic ones show it from here.
      if (!job.force) {
        await setState(job, { status: "pending" });
        notify(job.databaseId, "rows");
      }
      const wait = takeWorkspaceCapacity(job.workspaceId);
      if (wait > 0) return wait;
      const result = await complete({
        feature: `property.${input.config.mode}`,
        userId: job.userId,
        workspaceId: job.workspaceId,
        skipRateLimit: true,
        system: input.prompt.system,
        messages: [{ role: "user", content: input.prompt.prompt }],
        maxOutputTokens: 800,
      });
      value = cleanValue(result.text, MAX_AUTOFILL_VALUE);
      if (!value) throw new AiError("empty", "The model gave no value");
    }
    // Settings changed while the model worked: this answer is for the old ones.
    const [current] = await db
      .select({ options: databaseProperty.options })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.id, prop.id), isNull(databaseProperty.deletedAt)));
    // Deleted meanwhile, the property keeps the values it had.
    if (!current || JSON.stringify(current.options.ai) !== JSON.stringify(input.config)) return 0;
    const key = prop.id;
    await db
      .update(page)
      .set({
        properties: value
          ? sql`${page.properties} || jsonb_build_object(${key}::text, ${value}::text)`
          : sql`${page.properties} - ${key}::text`,
        updatedBy: job.userId,
      })
      .where(and(eq(page.id, job.rowId), eq(page.parentId, job.databaseId)));
    await setState(job, { status: "done", sourceHash: input.hash });
    notify(job.databaseId, "rows");
  } catch (error) {
    const code: AiErrorCode = isAiError(error) ? error.code : "provider";
    if (!isAiError(error)) console.error("[ai] autofill failed", error);
    await setState(job, { status: "error", error: code }).catch(() => {});
    notify(job.databaseId, "rows");
  }
  return 0;
}

// ------------------------------------------------------------------------------- requests

/**
 * Queues AI values of `rowIds` for an autofill property ("Refresh" on a row, "Update all rows" of a
 * view). Rows the person may not edit are skipped and counted. Throws AiError when AI is off or
 * the person asks too often, AutofillError when the property has no autofill.
 */
export async function requestAutofill(userId: string, propertyId: string, rowIds: string[]) {
  const [prop] = await db
    .select()
    .from(databaseProperty)
    .where(and(eq(databaseProperty.id, propertyId), isNull(databaseProperty.deletedAt)))
    .limit(1);
  if (!prop) throw new AccessError();
  const database = await databases.requireDatabase(userId, prop.databaseId, "view");
  // A property they can't know of doesn't exist for them (checked before anything tells its type).
  const access = await propertyAccessFor(userId, prop.databaseId);
  if (!access.visible([prop]).length) throw new AccessError();
  if (!(await aiAvailable(database.workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  if (prop.type !== "text" || !prop.options.ai) throw new AutofillError("invalidMode", "The property has no AI autofill");
  const ids = [...new Set(rowIds)];
  if (ids.length > MAX_AUTOFILL_ROWS) throw new AiError("tooLarge", `At most ${MAX_AUTOFILL_ROWS} rows at once`);
  // One request against the person's allowance per refresh; the values then share the workspace's.
  takeRateLimit({ userId });
  const found = await databases.rowsWithAccess(userId, prop.databaseId, ids, "edit");
  // Rows where property access keeps them from changing the value are skipped too.
  const rows = found.rows.filter((r) => mayWrite(access, r, prop.id));
  const queued = new Set(rows.map((r) => r.id));
  const skipped = ids.filter((id) => !queued.has(id));
  const jobs: Job[] = rows.map((r) => ({
    rowId: r.id,
    propertyId,
    databaseId: prop.databaseId,
    workspaceId: database.workspaceId,
    userId,
    force: true,
  }));
  // Queued before their pending state is written (so a reader never sees "pending" for a job this
  // process doesn't know), started after it (so "done" can't be overwritten by "pending").
  enqueue(jobs);
  for (const job of jobs) await setState(job, { status: "pending" });
  notify(prop.databaseId, "rows");
  pump();
  return { queued: jobs.length, skipped: skipped.length };
}

/**
 * Pending and failed values of a database's autofill properties, per row and property. A value
 * marked pending that no job of this process is working on (the server restarted meanwhile) shows
 * as failed ("interrupted"), so it can be refreshed.
 */
export async function autofillStates(properties: Property[]): Promise<Record<string, Record<string, AiCellState>>> {
  const ids = properties.filter((p) => p.type === "text" && p.options.ai).map((p) => p.id);
  if (!ids.length) return {};
  const found = await db
    .select({ rowId: aiPropertyState.rowId, propertyId: aiPropertyState.propertyId, status: aiPropertyState.status, error: aiPropertyState.error })
    .from(aiPropertyState)
    .where(and(inArray(aiPropertyState.propertyId, ids), inArray(aiPropertyState.status, ["pending", "error"])));
  const out: Record<string, Record<string, AiCellState>> = {};
  for (const s of found) {
    const state: AiCellState =
      s.status === "pending"
        ? isQueued(s.rowId, s.propertyId)
          ? { status: "pending" }
          : { status: "error", code: "interrupted" }
        : { status: "error", code: (s.error as AiErrorCode | null) ?? "provider" };
    (out[s.rowId] ??= {})[s.propertyId] = state;
  }
  return out;
}

// ---------------------------------------------------------------------------- auto update

/** How long a row must stay unchanged before values that follow it update. */
const SETTLE_MS = 4_000;

function scheduleFollowUp(change: RowChange) {
  if (!change.userId || !aiConfig().chat) return;
  const pending = queue.debounce.get(change.rowId);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    queue.debounce.delete(change.rowId);
    void followUp(change).catch((error) => console.error("[ai] autofill follow-up failed", error));
  }, SETTLE_MS);
  timer.unref?.();
  queue.debounce.set(change.rowId, timer);
}

async function followUp({ rowId, databaseId, userId }: RowChange) {
  const props = (await databases.getProperties(databaseId)).filter((p) => p.type === "text" && p.options.ai?.auto);
  if (!props.length || !userId) return;
  const [database] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, databaseId)).limit(1);
  if (!database || !(await aiAvailable(database.workspaceId))) return;
  enqueue(props.map((p) => ({ rowId, propertyId: p.id, databaseId, workspaceId: database.workspaceId, userId, force: false })));
  pump();
}

onRowChanged("ai-autofill", scheduleFollowUp);

/** Called once at startup (server.ts): logs the AI setup; importing this module starts listening. */
export function startAiProperties() {
  console.log(describeAiSetup());
}

/**
 * What the database UI needs about AI: whether it's available in the database's workspace, and
 * the pending and failed values of `rows` (the rows the person sees, as they got them), leaving out
 * those of values hidden from them.
 */
export async function databaseAi(databaseId: string, properties: Property[], rows: { id: string; hidden?: string[] }[]) {
  const [database] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, databaseId)).limit(1);
  const enabled = database ? await aiAvailable(database.workspaceId) : false;
  const all = await autofillStates(properties);
  const hiddenIn = new Map(rows.map((r) => [r.id, new Set(r.hidden)]));
  const states: typeof all = {};
  for (const [rowId, cells] of Object.entries(all)) {
    const hidden = hiddenIn.get(rowId);
    if (!hidden) continue;
    const shown = Object.entries(cells).filter(([propertyId]) => !hidden.has(propertyId));
    if (shown.length) states[rowId] = Object.fromEntries(shown);
  }
  return { enabled, states };
}
