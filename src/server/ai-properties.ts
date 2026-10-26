/**
 * AI autofill properties (#42): properties whose values a model works out from the rest of the row
 * (see AiAutofillConfig in lib/ai): text, or a value of the property's type read from the answer
 * (prompts.ts autofillAnswer). Values are stored like any value of their type; what is pending or
 * failed lives in `ai_property_state`.
 *
 * Values are worked out in the background by a queue shared by the whole process: at most
 * AI_CONCURRENCY at a time, each workspace within its AI_WORKSPACE_RATE_LIMIT (jobs wait for their
 * turn instead of failing). A job runs as the person who asked for it, with their access at the
 * time it runs: rows they can no longer edit are skipped, and only values they can see go into the
 * prompt. They ask by refreshing a row, "Update all rows" for a view's rows, or, for properties set
 * to follow their row, by changing the row (debounced; nothing runs when its inputs are the same).
 *
 * A new value is saved like any row write (saveValue): the row's activity, search, automations and
 * the AI values that read it (and only those) see it. AI values start automations as the change
 * that set them off would: one an automation's change set off starts none, so automations and AI
 * values can't feed each other forever. A cascade of AI values updates each property at most once.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { aiPropertyState, databaseProperty, page, type PropertyOptions } from "@/db/schema";
import {
  aiDerivedProperties,
  autofillHiddenInputs,
  autofillNamedInputs,
  autofillReads,
  checkAutofill,
  hasAutofillValue,
  isAutofillType,
  MAX_AUTOFILL_ROWS,
  MAX_AUTOFILL_VALUE,
  type AiAutofillConfig,
  type AiCellState,
  type AiErrorCode,
  type AutofillErrorCode,
} from "@/lib/ai";
import { availableOptions, canDepend } from "@/lib/dependent-options";
import { normalizeValue, PropertyValueError } from "@/lib/properties";
import { propertyDescription } from "@/lib/property-description";
import { AccessError, hasLevel, pageAccessOf } from "@/server/access";
import { aiConfig, AiError, complete, contentChars, describeAiSetup, isAiError, isEnabled as aiMayBeOn, takeRateLimit, takeWorkspaceCapacity } from "@/server/ai";
import { autofillAnswer, autofillNeedsBody, autofillPrompt, formatValue, type AutofillOutput, type Prompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { getCollab } from "@/server/collab/bridge";
import * as databases from "@/server/databases";
import { displayProperties } from "@/server/mcp/query";
import { compileFormulas, relatedDatabases } from "@/lib/derived";
import { formulaReferences, restrictedProperties } from "@/lib/property-access";
import { loadProperties, relatedSchemasFor } from "@/server/derived";
import { loadPropertyRules, propertyAccessFor, type AccessRow, type PropertyAccess } from "@/server/property-access";
import { asAutomation, outsideAutomation, runningAutomation } from "@/server/automations/queue";
import { onRowChanged, rowChanged, type RowChange } from "@/server/row-events";
import { withUniqueValues } from "@/server/unique-values";

type Property = databases.DatabaseProperty;

/** Autofill settings that don't fit the database; `code` names the problem for the UI. */
export class AutofillError extends Error {
  constructor(
    readonly code: AutofillErrorCode | "unsupportedType" | "databaseLocked",
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
 * Turns autofill on (or changes it) for a property of a type it fills in, or off with `null`. Needs
 * edit access to an unlocked database, like other property settings, and AI on for the workspace.
 * Values already filled in stay; pending and failed states of the old settings are dropped.
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
  if (!isAutofillType(prop.type)) throw new AutofillError("unsupportedType", `AI autofill doesn't fill in ${prop.type} properties`);
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
  /** The AI properties of the row written in the cascade this job follows from (see followUpTargets). */
  chain: string[];
  /** Set off by an automation's change: runs as one, so its write starts no automations. */
  fromAutomation: boolean;
};

type Queue = {
  waiting: Job[];
  /** Keys of waiting jobs, jobs waiting for their workspace's allowance and running ones. */
  active: Set<string>;
  running: Map<string, { again?: Job }>;
  /** Automatic updates waiting for a row to settle, per row id. */
  followUps: Map<string, FollowUp>;
};

const KEY = "__leafdeskAiQueue";
const queue = ((globalThis as Record<string, unknown>)[KEY] ??= {
  waiting: [],
  active: new Set(),
  running: new Map(),
  followUps: new Map(),
} satisfies Queue) as Queue;
// A queue made by an older version of this module (dev reloads) lacks it.
queue.followUps ??= new Map();

const jobKey = (job: { rowId: string; propertyId: string }) => `${job.rowId}:${job.propertyId}`;

/** Whether a value is waiting or being worked out in this process. */
export const isQueued = (rowId: string, propertyId: string) => queue.active.has(jobKey({ rowId, propertyId }));

/**
 * One job for two requests of the same value: the newer one's person, run as an automation only if
 * both would be, and skipping what either cascade wrote already.
 */
const mergeJobs = (older: Job, newer: Job): Job => ({
  ...newer,
  force: older.force || newer.force,
  fromAutomation: older.fromAutomation && newer.fromAutomation,
  chain: [...new Set([...older.chain, ...newer.chain])],
});

/** Queues jobs (a job already waiting takes the newer request; a running one runs again after). */
function enqueue(jobs: Job[]) {
  for (const job of jobs) {
    const key = jobKey(job);
    const running = queue.running.get(key);
    if (running) {
      running.again = running.again ? mergeJobs(running.again, job) : job;
      continue;
    }
    const at = queue.waiting.findIndex((j) => jobKey(j) === key);
    if (at >= 0) queue.waiting[at] = mergeJobs(queue.waiting[at], job);
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
    // As the change that set it off, not as whatever code happened to call pump.
    void (job.fromAutomation ? asAutomation : outsideAutomation)(() => runJob(job)).then((retryIn) => {
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
 * What the value must be, with what the model needs to know to give it (options, percent). A select
 * depending on another (see lib/dependent-options) offers only the options that go with the row's
 * value of it, from `values` (by property id) among `props`.
 */
export function autofillOutput<P extends Pick<Property, "id" | "name" | "type" | "options">>(
  prop: P,
  props: readonly P[] = [prop],
  values: Record<string, unknown> = {},
): AutofillOutput {
  switch (prop.type) {
    case "select":
    case "status":
    case "multi_select": {
      const options = canDepend(prop.type) ? availableOptions(prop, props, values) : (prop.options.options ?? []);
      return { type: prop.type, options: options.map((o) => o.name) };
    }
    case "number":
      return { type: "number", ...(prop.options.number?.format === "percent" ? { percent: true } : {}) };
    case "checkbox":
      return { type: "checkbox" };
    default:
      return { type: "text" };
  }
}

/**
 * Whether the row has a value in every property the settings wait for (`requires`), as an input
 * of the prompt: one that can't go into it (related rows, people, restricted, hidden from the
 * person) counts as empty. Properties deleted since are no longer waited for.
 */
export function requirementsMet(
  requires: string[] | undefined,
  existing: Set<string>,
  inputs: Set<string>,
  values: Record<string, unknown>,
) {
  return (requires ?? []).every((id) => !existing.has(id) || (inputs.has(id) && hasAutofillValue(values[id])));
}

/**
 * The prompt for a row's value and a fingerprint of everything it depends on. `props`: the
 * properties the person may know of; values they may not see are left out by rowValues.
 * `existing`: the ids of the database's properties. `met`: false when a property the settings
 * wait for is empty, and the value is left as it is.
 */
async function rowInput(
  userId: string,
  row: databases.DatabaseRow & { createdBy: string | null; updatedBy: string | null; parentId: string | null },
  props: Property[],
  prop: Property,
  existing: Set<string>,
) {
  const config = prop.options.ai!;
  // Other AI values (and formulas over them) only where the settings name them: see AiAutofillConfig.
  const derived = aiDerivedProperties(props);
  const named = new Set(autofillNamedInputs(config, props, prop.id));
  // Never related rows or people, named or not (settings saved before that was checked too).
  const hidden = autofillHiddenInputs(props);
  const inputs = props.filter((p) => p.id !== prop.id && !hidden.has(p.id) && (!derived.has(p.id) || named.has(p.id)));
  const values = await databases.rowValues(userId, row, props);
  const met = requirementsMet(config.requires, existing, new Set(inputs.map((p) => p.id)), values);
  // As the person sees them: option names, people and related rows they can see, by name.
  const shown = displayProperties(inputs, values, await databases.getLookups(userId, props));
  const text = Object.fromEntries(
    Object.entries(shown)
      .map(([name, value]) => [name, formatValue(value)] as const)
      .filter(([, value]) => value.trim()),
  );
  const body = autofillNeedsBody(config) ? (await getCollab().readPage(row.id)).markdown : "";
  const maxContent = Math.max(1_000, contentChars(aiConfig().limits) - 3_000);
  const output = autofillOutput(prop, props, values);
  const prompt: Prompt | null = autofillPrompt(
    config,
    { title: row.title, values: text, names: Object.fromEntries(inputs.map((p) => [p.id, p.name])), body },
    maxContent,
    output,
    // What the database says the field holds: part of what the value depends on, like the prompt.
    { name: prop.name, description: propertyDescription(prop) },
  );
  // Values worked out before `requires` existed keep their fingerprint.
  const hash = createHash("sha256")
    .update(JSON.stringify({ config, prompt, ...(met ? {} : { met }) }))
    .digest("hex");
  return { config, prompt, hash, met, output };
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

/** How many databases down rollups over rollups are followed; deeper ones count as restricted. */
const ROLLUP_DEPTH = 3;

/**
 * Rollups over a restricted property of related rows: one with rules in the related database, a
 * formula there reading one (of its own rows or of rows it relates to), or a rollup there over one
 * (followed ROLLUP_DEPTH databases down). Left out of autofill like restricted properties of the
 * row itself: whoever's edit sets autofill off, the rollup is worked out with their view, and the
 * value written can be read by people the related value is hidden from.
 */
export async function rollupsOverRestricted(props: Property[], depth = 0): Promise<string[]> {
  const relationOf = new Map(props.filter((p) => p.type === "relation").map((p) => [p.id, p.options.relation?.databaseId]));
  const rollups = props.filter((p) => p.type === "rollup" && p.options.rollup);
  const databaseIds = [...new Set(rollups.flatMap((r) => relationOf.get(r.options.rollup!.relationPropertyId) ?? []))];
  if (!databaseIds.length) return [];
  // Too far down to follow: every rollup there counts as restricted.
  if (depth >= ROLLUP_DEPTH) return rollups.map((r) => r.id);
  const [schemas, rules] = await Promise.all([loadProperties(databaseIds), loadPropertyRules(databaseIds)]);
  const seed = new Set(rules.keys());
  for (const id of databaseIds) {
    const own = schemas.get(id) ?? [];
    for (const found of [...(await readingRestrictedRelated(own)), ...(await rollupsOverRestricted(own, depth + 1))]) seed.add(found);
  }
  const there = restrictedProperties(databaseIds.flatMap((id) => schemas.get(id) ?? []), seed);
  return rollups.filter((r) => there.has(r.options.rollup!.targetPropertyId)).map((r) => r.id);
}

/** Works out one value. Returns milliseconds to wait before retrying (workspace allowance), or 0. */
async function runJob(job: Job): Promise<number> {
  try {
    const { page: row, level } = await pageAccessOf(job.userId, job.rowId);
    if (!row || row.archivedAt || row.parentId !== job.databaseId || !hasLevel(level, "content")) {
      throw new AiError("noAccess", "The row can't be changed by the person who asked");
    }
    if (!(await aiAvailable(job.workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
    const [all, access] = await Promise.all([databases.getProperties(job.databaseId), propertyAccessFor(job.userId, job.databaseId)]);
    const prop = all.find((p) => p.id === job.propertyId && isAutofillType(p.type) && p.options.ai);
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
    // Formulas reading them are left out too, and so are formulas and rollups reading restricted
    // properties of related rows.
    const restricted = new Set((await loadPropertyRules([job.databaseId])).keys());
    for (const id of await readingRestrictedRelated(all)) restricted.add(id);
    for (const id of await rollupsOverRestricted(all)) restricted.add(id);
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
      new Set(all.map((p) => p.id)),
    );
    if (!job.force) {
      const [state] = await db
        .select({ sourceHash: aiPropertyState.sourceHash, status: aiPropertyState.status })
        .from(aiPropertyState)
        .where(and(eq(aiPropertyState.rowId, job.rowId), eq(aiPropertyState.propertyId, job.propertyId)))
        .limit(1);
      if (state?.status === "done" && state.sourceHash === input.hash) return 0;
    }
    // A row without what the value waits for keeps the value it has.
    if (!input.met) {
      await setState(job, { status: "done", sourceHash: input.hash });
      notify(job.databaseId, "rows");
      return 0;
    }
    let value: unknown = null;
    if (input.prompt) {
      // Explicit requests were marked pending when asked for; automatic ones show it from here.
      if (!job.force) {
        await setState(job, { status: "pending" });
        notify(job.databaseId, "rows");
      }
      const wait = takeWorkspaceCapacity(job.workspaceId);
      if (wait > 0) return wait;
      // On the fast model, without thinking where the model can stop (see ai/features.ts).
      const result = await complete({
        feature: `property.${input.config.mode}`,
        userId: job.userId,
        workspaceId: job.workspaceId,
        skipRateLimit: true,
        system: input.prompt.system,
        messages: [{ role: "user", content: input.prompt.prompt }],
        maxOutputTokens: 800,
      });
      if (!result.text.trim()) throw new AiError("empty", "The model gave no value");
      const answer = autofillAnswer(input.output, result.text, MAX_AUTOFILL_VALUE);
      if (!answer.ok) throw new AiError("empty", `The model's answer doesn't fit the ${prop.type} property`);
      if (input.output.type === "text" && !answer.value) throw new AiError("empty", "The model gave no value");
      try {
        // Option names to their ids, as any write stores them.
        value = normalizeValue(prop, answer.value);
      } catch (error) {
        if (!(error instanceof PropertyValueError)) throw error;
        throw new AiError("empty", error.message);
      }
    }
    // Settings changed while the model worked: this answer is for the old ones.
    const [current] = await db
      .select({ options: databaseProperty.options })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.id, prop.id), isNull(databaseProperty.deletedAt)));
    // Deleted meanwhile, the property keeps the values it had.
    if (!current || JSON.stringify(current.options.ai) !== JSON.stringify(input.config)) return 0;
    try {
      await saveValue(job, prop.id, value);
    } catch (error) {
      // An option that doesn't go with the row's value of the select it depends on, as for any write.
      if (!(error instanceof PropertyValueError)) throw error;
      throw new AiError("empty", error.message);
    }
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

/**
 * Saves a worked-out value (as stored: option ids, numbers…; null or an empty one clears it) when it
 * differs from the stored one, and sets off what any row write does: activity (as the AI's, for the
 * job's person), automations (unless the job runs as one), and the row listeners (search, the AI
 * values reading this one). Returns whether it changed anything.
 */
export async function saveValue(job: Pick<Job, "rowId" | "databaseId" | "userId" | "chain">, propertyId: string, value: unknown) {
  const empty = value === null || value === undefined || value === "";
  const props = await databases.getProperties(job.databaseId);
  const written = await withUniqueValues(() => db.transaction(async (tx) => {
    const [row] = await tx
      .select({ properties: page.properties, inTemplate: page.inTemplate })
      .from(page)
      .where(and(eq(page.id, job.rowId), eq(page.parentId, job.databaseId)))
      .for("update");
    const before = row?.properties[propertyId];
    if (!row || JSON.stringify(before === "" ? null : (before ?? null)) === JSON.stringify(empty ? null : value)) return null;
    // The row is locked until the end of the transaction: no other write of it gets lost.
    // Dependent selects hold as for any write (see databases.followOrRefuse): an option that
    // doesn't go with the row's value of the one it depends on is refused (a PropertyValueError),
    // and a new value of one others depend on clears what no longer goes with it.
    const follow = databases.followOrRefuse(props, props, row.properties, { [propertyId]: empty ? null : value });
    const after = { ...row.properties };
    for (const [id, next] of Object.entries({ ...follow, [propertyId]: empty ? null : value })) {
      if (next === null) delete after[id];
      else after[id] = next;
    }
    await tx.update(page).set({ properties: after, updatedBy: job.userId }).where(eq(page.id, job.rowId));
    return { before: row.properties, after, inTemplate: row.inTemplate };
  }));
  if (!written) return false;
  // Rows of a database kept as a template set nothing off (see databases.updateRowProperties).
  if (!written.inTemplate) {
    await databases.afterRowWrites(job.userId, job.databaseId, [{ rowId: job.rowId, before: written.before, after: written.after }], {
      ai: true,
    });
  }
  rowChanged({
    rowId: job.rowId,
    databaseId: job.databaseId,
    userId: job.userId,
    autofill: { propertyId, chain: [...new Set([...job.chain, propertyId])] },
  });
  return true;
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
  if (!isAutofillType(prop.type) || !prop.options.ai) throw new AutofillError("invalidMode", "The property has no AI autofill");
  const ids = [...new Set(rowIds)];
  if (ids.length > MAX_AUTOFILL_ROWS) throw new AiError("tooLarge", `At most ${MAX_AUTOFILL_ROWS} rows at once`);
  // One request against the person's allowance per refresh; the values then share the workspace's.
  takeRateLimit({ userId });
  const found = await databases.rowsWithAccess(userId, prop.databaseId, ids, "content");
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
    chain: [],
    fromAutomation: runningAutomation(),
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
  const ids = properties.filter((p) => isAutofillType(p.type) && p.options.ai).map((p) => p.id);
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

/** What a row's changes while it settles ask of its automatic values. */
export type FollowUpScope = {
  databaseId: string;
  /** Who made the latest change: the values are worked out as them. */
  userId: string;
  /** A change other than an AI value's: every automatic value updates. */
  broad: boolean;
  /**
   * Otherwise the AI values written, each with its cascade (RowChange `autofill`): the values
   * reading one update, unless its cascade wrote them already.
   */
  cascades: { propertyId: string; chain: string[] }[];
  /** Every change was an automation's (or followed from one): the values run as automations. */
  fromAutomation: boolean;
};

type FollowUp = FollowUpScope & { timer: ReturnType<typeof setTimeout> };

/** Adds a change to what a row's pending update asks for (`pending`: the changes before it). */
export function mergeFollowUp(
  pending: FollowUpScope | undefined,
  change: RowChange & { userId: string },
  fromAutomation: boolean,
): FollowUpScope {
  const broad = (pending?.broad ?? false) || !change.autofill;
  return {
    databaseId: change.databaseId,
    userId: change.userId,
    broad,
    // Kept apart: a value another cascade wrote meanwhile still updates after this one.
    cascades: broad ? [] : [...(pending?.cascades ?? []), change.autofill!],
    fromAutomation: (pending?.fromAutomation ?? true) && fromAutomation,
  };
}

/**
 * The automatic values a row's update works out, each with the cascade it continues: all of them
 * (starting one) after other changes; after AI values only those reading one (lib/ai
 * `autofillReads`), and never one that value's cascade wrote already, so values reading each other
 * (settings saved before such loops were refused, or renamed into one) stop after a round.
 */
export function followUpTargets(properties: Property[], scope: Pick<FollowUpScope, "broad" | "cascades">) {
  const auto = properties.filter((p) => isAutofillType(p.type) && p.options.ai?.auto);
  if (scope.broad) return auto.map((property) => ({ property, chain: [] as string[] }));
  return auto.flatMap((property) => {
    const reads = autofillReads(property.options.ai!, properties, property.id);
    const from = scope.cascades.filter((c) => reads.includes(c.propertyId) && !c.chain.includes(property.id));
    return from.length ? [{ property, chain: [...new Set(from.flatMap((c) => c.chain))] }] : [];
  });
}

function scheduleFollowUp(change: RowChange) {
  if (!change.userId || !aiMayBeOn()) return;
  const pending = queue.followUps.get(change.rowId);
  if (pending) clearTimeout(pending.timer);
  // Read now, while the code that made the change runs: the timer would carry its context on.
  const scope = mergeFollowUp(pending, { ...change, userId: change.userId }, runningAutomation());
  const timer = setTimeout(() => {
    queue.followUps.delete(change.rowId);
    void followUp(change.rowId, scope).catch((error) => console.error("[ai] autofill follow-up failed", error));
  }, SETTLE_MS);
  timer.unref?.();
  queue.followUps.set(change.rowId, { ...scope, timer });
}

async function followUp(rowId: string, scope: FollowUpScope) {
  const { databaseId, userId } = scope;
  const targets = followUpTargets(await databases.getProperties(databaseId), scope);
  if (!targets.length) return;
  const [database] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, databaseId)).limit(1);
  if (!database || !(await aiAvailable(database.workspaceId))) return;
  const { workspaceId } = database;
  const { fromAutomation } = scope;
  enqueue(targets.map(({ property, chain }) => ({ rowId, propertyId: property.id, databaseId, workspaceId, userId, force: false, chain, fromAutomation })));
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
