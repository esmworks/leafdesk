import { propertyDescription } from "./property-description";
import type { FormCondition, FormConfig, FormQuestion, PropertyOptions, PropertyType } from "@/db/schema/app";
import { normalizeValue, PropertyValueError, type DatabaseErrorCode } from "./properties";
import { atLeast } from "./property-access";
import { holdsOptions } from "./property-types";
import type { PropertyAccess } from "./property-access-rows";

/**
 * Form views (pure, client-safe): which questions a form asks, checking its settings, and
 * checking answers. The app, the public form page and the server all use these, so a form shows
 * the same questions and complains about the same answers everywhere.
 */

/** Question id of the row's name; every other question is a property id. */
export const FORM_TITLE = "title";

export const MAX_FORM_QUESTIONS = 100;
export const MAX_FORM_TITLE = 200;
export const MAX_FORM_DESCRIPTION = 2000;
export const MAX_QUESTION_LABEL = 200;
export const MAX_QUESTION_DESCRIPTION = 1000;
export const MAX_CONFIRMATION = 1000;
export const MAX_FORM_DEFAULTS = 100;
/** Longest text answer; the row's name gets less, like a title. */
export const MAX_TEXT_ANSWER = 5000;
export const MAX_TITLE_ANSWER = 500;
/** Most entries in one list answer (tags, checklist items). */
export const MAX_LIST_ANSWER = 100;
/** Largest submission, as JSON, the server reads. */
export const MAX_SUBMISSION_BYTES = 64 * 1024;
/** Most options one condition names, and the longest text it looks for. */
export const MAX_CONDITION_VALUES = 50;
export const MAX_CONDITION_TEXT = 200;
/** Most of their own answers to one form someone is shown, newest first. */
export const MAX_OWN_SUBMISSIONS = 50;

/**
 * Property types a form can ask for. Values Leafdesk fills in itself (created by, last edited…)
 * never are; types added later stay out until they are listed here.
 */
const ASKABLE: readonly PropertyType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "checklist",
  "files",
  "relation",
  "person",
];

export function isAskable(type: PropertyType) {
  return ASKABLE.includes(type);
}

/**
 * Types a form can give a default value: what it can ask, except files, whose uploads belong to
 * one row each (a default would attach the same file to every answer).
 */
export function canDefault(type: PropertyType) {
  return isAskable(type) && type !== "files";
}

/**
 * Types a public form can ask for: not relations or people, whose choices would show rows and
 * members of the workspace to anyone with the link.
 */
export function isPublicAskable(type: PropertyType) {
  return isAskable(type) && type !== "relation" && type !== "person";
}

type PropertyDef = { id: string; name: string; type: PropertyType; options: PropertyOptions };

/**
 * A question the form really asks: its property (null for the row's name), its texts, and when it
 * is asked and how many choices it takes, as far as they still hold (see formQuestions).
 */
export type ResolvedQuestion<P extends PropertyDef = PropertyDef> = {
  propertyId: string;
  prop: P | null;
  required: boolean;
  label: string;
  description: string;
  showIf?: FormCondition;
  minChoices?: number;
  maxChoices?: number;
};

// ---------------------------------------------------------------------------------------------
// Conditions: a question asked only when an earlier question's answer meets one.

export type ConditionOp = FormCondition["op"];
const CONDITION_OPS: readonly ConditionOp[] = ["is", "isNot", "contains", "notContains", "checked", "unchecked", "empty", "notEmpty"];
const TEXT_TYPES: readonly string[] = ["title", "text", "url", "email", "phone"];

/** What a condition can ask of the answer to a question of `type` ("title" for the name). */
export function conditionOps(type: PropertyType | "title"): ConditionOp[] {
  if (TEXT_TYPES.includes(type)) return ["contains", "notContains", "empty", "notEmpty"];
  if (type === "select" || type === "status") return ["is", "isNot", "empty", "notEmpty"];
  if (type === "multi_select") return ["contains", "notContains", "empty", "notEmpty"];
  if (type === "checkbox") return ["checked", "unchecked"];
  return ["empty", "notEmpty"];
}

/** Whether `op` compares the answer with the condition's values (options, or a text). */
export const conditionTakesValues = (op: ConditionOp) => op === "is" || op === "isNot" || op === "contains" || op === "notContains";

/**
 * Whether the answer to a question of `type` meets the condition. Takes answers as the form holds
 * them and as checkAnswers stores them alike: option ids, texts, ticks, lists. A text contains
 * another ignoring case; a multi-select contains any of the options named.
 */
export function conditionHolds(condition: Pick<FormCondition, "op" | "values">, type: PropertyType | "title", answer: unknown): boolean {
  const value = typeof answer === "string" ? answer.trim() : answer;
  const blank = isBlankAnswer(value);
  const values = condition.values ?? [];
  switch (condition.op) {
    case "empty":
      return blank;
    case "notEmpty":
      return !blank;
    case "checked":
      return value === true;
    case "unchecked":
      return value !== true;
    case "is":
    case "isNot": {
      const is = typeof value === "string" && values.includes(value);
      return condition.op === "is" ? is : !is;
    }
    case "contains":
    case "notContains": {
      let contains = false;
      if (type === "multi_select") contains = Array.isArray(value) && value.some((v) => values.includes(v as string));
      else if (typeof value === "string" && values[0]) contains = value.toLowerCase().includes(values[0].trim().toLowerCase());
      return condition.op === "contains" ? contains : !contains;
    }
  }
}

/**
 * The questions not asked, given the answers so far: those whose condition isn't met, and those
 * whose condition is about a question that isn't asked itself (its answer doesn't count).
 */
export function hiddenQuestions(
  questions: Pick<ResolvedQuestion, "propertyId" | "prop" | "showIf">[],
  answers: Record<string, unknown>,
): Set<string> {
  const hidden = new Set<string>();
  for (const q of questions) {
    const condition = q.showIf;
    if (!condition) continue;
    const source = questions.find((s) => s.propertyId === condition.propertyId);
    if (!source || hidden.has(source.propertyId) || !conditionHolds(condition, source.prop?.type ?? "title", answers[source.propertyId])) {
      hidden.add(q.propertyId);
    }
  }
  return hidden;
}

/** Types whose answers are lists a form can ask a number of choices from. */
export function takesChoiceLimits(type: PropertyType | "title") {
  return type === "multi_select" || type === "person" || type === "relation" || type === "files";
}

/**
 * The condition as it still holds for a question asked after `earlier`: about one of them, with
 * an operator its type takes and the options it names that still exist. Undefined when it no
 * longer holds (its question was deleted, moved after this one, can't be asked here, or changed
 * type): the question is then always asked.
 */
function liveCondition(condition: FormCondition | undefined, earlier: ResolvedQuestion[]): FormCondition | undefined {
  if (!condition || typeof condition !== "object") return undefined;
  const source = earlier.find((q) => q.propertyId === condition.propertyId);
  if (!source) return undefined;
  const type = source.prop?.type ?? "title";
  if (!conditionOps(type).includes(condition.op)) return undefined;
  if (!conditionTakesValues(condition.op)) return { propertyId: condition.propertyId, op: condition.op };
  const given = Array.isArray(condition.values) ? condition.values.filter((v): v is string => typeof v === "string") : [];
  const values = holdsOptions(type)
    ? given.filter((id) => source.prop?.options.options?.some((o) => o.id === id))
    : given.slice(0, 1).filter((text) => text.trim());
  return values.length ? { propertyId: condition.propertyId, op: condition.op, values } : undefined;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LIST_ANSWER;

/**
 * The help a question shows: its own description, else its property's (what the property holds
 * and how to fill it, see lib/property-description).
 */
export function questionHelp(q: { description: string; prop: { options: { description?: unknown } } | null }): string {
  return q.description || (q.prop ? propertyDescription(q.prop) : "");
}

/**
 * The questions a form asks, in order: those whose property still exists and can be asked
 * (publicly, with `public`). Repeated questions are asked once. A condition that no longer holds
 * (see liveCondition) is left out, and so are choice limits on a question that isn't a list.
 */
export function formQuestions<P extends PropertyDef>(
  form: FormConfig | undefined,
  properties: P[],
  { public: isPublic = false }: { public?: boolean } = {},
): ResolvedQuestion<P>[] {
  const seen = new Set<string>();
  const out: ResolvedQuestion<P>[] = [];
  for (const q of form?.questions ?? []) {
    if (seen.has(q.propertyId)) continue;
    const prop = q.propertyId === FORM_TITLE ? null : properties.find((p) => p.id === q.propertyId);
    if (prop === undefined) continue;
    if (prop && !(isPublic ? isPublicAskable(prop.type) : isAskable(prop.type))) continue;
    seen.add(q.propertyId);
    const showIf = liveCondition(q.showIf, out);
    const limits = prop !== null && takesChoiceLimits(prop.type);
    out.push({
      propertyId: q.propertyId,
      prop,
      required: q.required === true,
      label: q.label?.trim() ?? "",
      description: q.description?.trim() ?? "",
      ...(showIf ? { showIf } : {}),
      ...(limits && isCount(q.minChoices) ? { minChoices: q.minChoices } : {}),
      ...(limits && isCount(q.maxChoices) ? { maxChoices: q.maxChoices } : {}),
    });
  }
  return out;
}

/**
 * The properties a form may ask about and set defaults for, when it writes with the standing of
 * someone with `access` to the database (property access, see lib/property-access): those whose
 * values they may change (`edit_values` and up) in a new row created by `createdBy`. Questions
 * and defaults for the others are left out, not refused: the form still takes answers.
 */
export function writableProperties<P extends { id: string }>(
  access: Pick<PropertyAccess, "open" | "levelOf" | "visible">,
  properties: P[],
  createdBy: string | null,
): P[] {
  if (access.open) return properties;
  const row = { properties: {}, createdBy };
  return access.visible(properties).filter((p) => atLeast(access.levelOf(p.id, row), "edit_values"));
}

/** A new form asks for the name (required) and every property it can ask for. */
export function defaultFormConfig(properties: { id: string; type: PropertyType }[]): FormConfig {
  return {
    questions: [
      { propertyId: FORM_TITLE, required: true },
      ...properties.filter((p) => isAskable(p.type)).map((p) => ({ propertyId: p.id })),
    ],
  };
}

/**
 * The default values that apply: for properties that exist, can be written and aren't asked (an
 * answer always wins over a default).
 */
export function formDefaults(form: FormConfig | undefined, properties: PropertyDef[]): Record<string, unknown> {
  const asked = new Set((form?.questions ?? []).map((q) => q.propertyId));
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(form?.defaults ?? {})) {
    const prop = properties.find((p) => p.id === id);
    if (prop && canDefault(prop.type) && !asked.has(id) && value !== null && value !== undefined) out[id] = value;
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function textError(value: unknown, name: string, max: number) {
  if (value === undefined) return null;
  if (typeof value !== "string") return `${name} must be text`;
  return value.length > max ? `${name} can be at most ${max} characters` : null;
}

/**
 * Why a form config is malformed, or null. Like other view settings, property ids aren't checked
 * against the schema here: questions about deleted properties are skipped when the form is shown.
 * Default values are checked by the server, which knows the properties.
 */
export function formConfigError(form: unknown): string | null {
  if (form === undefined) return null;
  if (!isRecord(form)) return "form must be an object";
  const texts: [string, number][] = [
    ["title", MAX_FORM_TITLE],
    ["description", MAX_FORM_DESCRIPTION],
    ["confirmation", MAX_CONFIRMATION],
  ];
  for (const [key, max] of texts) {
    const error = textError(form[key], `form.${key}`, max);
    if (error) return error;
  }
  if (form.allowAnother !== undefined && typeof form.allowAnother !== "boolean") return "form.allowAnother must be true or false";
  if (form.showOwnAnswers !== undefined && typeof form.showOwnAnswers !== "boolean") return "form.showOwnAnswers must be true or false";
  if (form.questions !== undefined) {
    if (!Array.isArray(form.questions)) return "form.questions must be a list";
    if (form.questions.length > MAX_FORM_QUESTIONS) return `A form can ask at most ${MAX_FORM_QUESTIONS} questions`;
    const seen = new Set<string>();
    const earlier = new Set<string>();
    for (const q of form.questions as unknown[]) {
      if (!isRecord(q) || typeof q.propertyId !== "string" || !q.propertyId) return "Every question needs a property id";
      if (seen.has(q.propertyId)) return "A form can ask for each property once";
      seen.add(q.propertyId);
      if (q.required !== undefined && typeof q.required !== "boolean") return "required must be true or false";
      const error =
        textError(q.label, "A question's label", MAX_QUESTION_LABEL) ??
        textError(q.description, "A question's description", MAX_QUESTION_DESCRIPTION) ??
        conditionShapeError(q.showIf, q.propertyId, earlier) ??
        limitsError(q.minChoices, q.maxChoices);
      if (error) return error;
      earlier.add(q.propertyId);
    }
  }
  if (form.defaults !== undefined) {
    if (!isRecord(form.defaults)) return "form.defaults must map property ids to values";
    if (Object.keys(form.defaults).length > MAX_FORM_DEFAULTS) return `A form can set at most ${MAX_FORM_DEFAULTS} default values`;
    if (FORM_TITLE in form.defaults) return "The name can't have a default value";
  }
  return null;
}

/** Why a question's condition is malformed, or null; `earlier` holds the questions before it. */
function conditionShapeError(condition: unknown, propertyId: string, earlier: ReadonlySet<string>): string | null {
  if (condition === undefined) return null;
  if (!isRecord(condition) || typeof condition.propertyId !== "string" || !condition.propertyId) return "A condition needs a question";
  if (condition.propertyId === propertyId || !earlier.has(condition.propertyId)) return "A condition can only be about an earlier question";
  const op = condition.op as ConditionOp;
  if (typeof op !== "string" || !CONDITION_OPS.includes(op)) return `A condition can't check "${String(op)}"`;
  const values = condition.values;
  if (!conditionTakesValues(op)) return values === undefined ? null : `A condition that checks "${op}" takes no values`;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > MAX_CONDITION_VALUES ||
    !values.every((v) => typeof v === "string" && v.trim())
  ) {
    return `A condition's values must be a list of 1 to ${MAX_CONDITION_VALUES} options or texts`;
  }
  if (values.some((v: string) => v.length > MAX_CONDITION_TEXT)) return `A condition's text can be at most ${MAX_CONDITION_TEXT} characters`;
  return null;
}

function limitsError(min: unknown, max: unknown): string | null {
  for (const [name, value] of [
    ["minChoices", min],
    ["maxChoices", max],
  ] as const) {
    if (value !== undefined && !isCount(value)) return `${name} must be a whole number from 1 to ${MAX_LIST_ANSWER}`;
  }
  return typeof min === "number" && typeof max === "number" && min > max ? "minChoices can't be more than maxChoices" : null;
}

/**
 * Why a form's conditions and choice limits don't fit the database's properties, or null: a
 * condition must be about a property that exists and can be asked, check what its type takes and
 * name only its options; limits go on list questions only. Checked when a form is saved, for the
 * questions whose condition or limits change from `stored` (what later changes to the properties
 * broke in the others is tolerated, as when the form is shown: see formQuestions), skipping
 * questions about deleted properties.
 */
export function formSchemaError(form: FormConfig | undefined, properties: PropertyDef[], stored?: FormConfig): string | null {
  const settings = (q: FormQuestion | undefined) => JSON.stringify([q?.showIf ?? null, q?.minChoices ?? null, q?.maxChoices ?? null]);
  for (const q of form?.questions ?? []) {
    const prop = q.propertyId === FORM_TITLE ? null : properties.find((p) => p.id === q.propertyId);
    if (prop === undefined) continue;
    if (settings(q) === settings(stored?.questions?.find((s) => s.propertyId === q.propertyId))) continue;
    const name = q.label?.trim() || prop?.name || FORM_TITLE;
    if ((q.minChoices !== undefined || q.maxChoices !== undefined) && !(prop && takesChoiceLimits(prop.type))) {
      return `"${name}" doesn't take a number of choices`;
    }
    const condition = q.showIf;
    if (!condition) continue;
    const source = condition.propertyId === FORM_TITLE ? null : properties.find((p) => p.id === condition.propertyId);
    if (source === undefined || (source && !isAskable(source.type))) {
      return `The condition of "${name}" is about a property the form can't ask`;
    }
    const type = source?.type ?? "title";
    if (!conditionOps(type).includes(condition.op)) return `The condition of "${name}" can't check "${condition.op}" of a ${type} answer`;
    if (source && holdsOptions(type) && condition.values?.some((id) => !source.options.options?.some((o) => o.id === id))) {
      return `The condition of "${name}" names an option "${source.name}" doesn't have`;
    }
    if (!holdsOptions(type) && (condition.values?.length ?? 0) > 1) return `The condition of "${name}" looks for one text`;
  }
  return null;
}

/** Why an answer was refused: a code the UI translates (`form.errors.*` or `database.errors.*`). */
export type AnswerErrorCode = "required" | "tooLong" | "tooMany" | "tooFew" | "invalidText" | DatabaseErrorCode;
export type AnswerError = { propertyId: string; code: AnswerErrorCode; params: Record<string, string> };
export type CheckedAnswers =
  | { ok: true; title: string; properties: Record<string, unknown> }
  | { ok: false; errors: AnswerError[] };

/** No answer: nothing typed, nothing picked, or an unticked checkbox. */
export function isBlankAnswer(value: unknown) {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string") return !value.trim();
  return Array.isArray(value) && value.length === 0;
}

/**
 * Checks the answers to a form's questions and turns them into a row: its title and property
 * values (option ids for selects). Keys that aren't questions are ignored, and so are answers to
 * questions that aren't asked (see hiddenQuestions; worked out here from the answers as they are
 * checked, in order): those are neither required nor kept. Strings are trimmed; required questions
 * need an answer; long texts and lists, and lists outside a question's choice limits, are refused.
 * Every question is checked, so the form can mark all mistakes at once.
 */
export function checkAnswers(questions: ResolvedQuestion[], answers: Record<string, unknown>): CheckedAnswers {
  const errors: AnswerError[] = [];
  const properties: Record<string, unknown> = {};
  let title = "";
  // The answers so far as they are stored (option names turned into ids), for later conditions.
  const given: Record<string, unknown> = {};
  const hidden = new Set<string>();
  for (const q of questions) {
    const condition = q.showIf;
    if (condition) {
      const source = questions.find((s) => s.propertyId === condition.propertyId);
      if (!source || hidden.has(source.propertyId) || !conditionHolds(condition, source.prop?.type ?? "title", given[source.propertyId])) {
        hidden.add(q.propertyId);
        continue;
      }
    }
    const name = q.label || q.prop?.name || "";
    const fail = (code: AnswerErrorCode, params: Record<string, string> = {}) =>
      // Messages name the question as the form shows it, not the property behind it.
      errors.push({ propertyId: q.propertyId, code, params: { ...params, property: name } });
    let value = Object.hasOwn(answers, q.propertyId) ? answers[q.propertyId] : undefined;
    if (typeof value === "string") value = value.trim();
    given[q.propertyId] = value;
    if (isBlankAnswer(value)) {
      if (q.required) fail("required");
      continue;
    }
    if (!q.prop) {
      if (typeof value !== "string") fail("invalidText");
      else if (value.length > MAX_TITLE_ANSWER) fail("tooLong", { max: String(MAX_TITLE_ANSWER) });
      else title = value;
      continue;
    }
    if (typeof value === "string" && value.length > MAX_TEXT_ANSWER) {
      fail("tooLong", { max: String(MAX_TEXT_ANSWER) });
      continue;
    }
    if (Array.isArray(value) && value.length > MAX_LIST_ANSWER) {
      fail("tooMany", { max: String(MAX_LIST_ANSWER) });
      continue;
    }
    try {
      const normalized = normalizeValue(q.prop, value);
      given[q.propertyId] = normalized;
      const count = Array.isArray(normalized) ? normalized.length : 0;
      if (isBlankAnswer(normalized)) {
        if (q.required) fail("required");
      } else if (q.minChoices !== undefined && count < q.minChoices) fail("tooFew", { min: String(q.minChoices) });
      else if (q.maxChoices !== undefined && count > q.maxChoices) fail("tooMany", { max: String(q.maxChoices) });
      else properties[q.prop.id] = normalized;
    } catch (error) {
      if (!(error instanceof PropertyValueError) || !error.code) throw error;
      fail(error.code, error.params);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, title, properties };
}
