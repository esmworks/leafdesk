import { propertyDescription } from "./property-description";
import type { FormConfig, PropertyOptions, PropertyType } from "@/db/schema/app";
import { normalizeValue, PropertyValueError, type DatabaseErrorCode } from "./properties";
import { atLeast } from "./property-access";
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

/** A question the form really asks: its property (null for the row's name) and its texts. */
export type ResolvedQuestion<P extends PropertyDef = PropertyDef> = {
  propertyId: string;
  prop: P | null;
  required: boolean;
  label: string;
  description: string;
};

/**
 * The help a question shows: its own description, else its property's (what the property holds
 * and how to fill it, see lib/property-description).
 */
export function questionHelp(q: { description: string; prop: { options: { description?: unknown } } | null }): string {
  return q.description || (q.prop ? propertyDescription(q.prop) : "");
}

/**
 * The questions a form asks, in order: those whose property still exists and can be asked
 * (publicly, with `public`). Repeated questions are asked once.
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
    out.push({
      propertyId: q.propertyId,
      prop,
      required: q.required === true,
      label: q.label?.trim() ?? "",
      description: q.description?.trim() ?? "",
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
  if (form.questions !== undefined) {
    if (!Array.isArray(form.questions)) return "form.questions must be a list";
    if (form.questions.length > MAX_FORM_QUESTIONS) return `A form can ask at most ${MAX_FORM_QUESTIONS} questions`;
    const seen = new Set<string>();
    for (const q of form.questions as unknown[]) {
      if (!isRecord(q) || typeof q.propertyId !== "string" || !q.propertyId) return "Every question needs a property id";
      if (seen.has(q.propertyId)) return "A form can ask for each property once";
      seen.add(q.propertyId);
      if (q.required !== undefined && typeof q.required !== "boolean") return "required must be true or false";
      const error =
        textError(q.label, "A question's label", MAX_QUESTION_LABEL) ??
        textError(q.description, "A question's description", MAX_QUESTION_DESCRIPTION);
      if (error) return error;
    }
  }
  if (form.defaults !== undefined) {
    if (!isRecord(form.defaults)) return "form.defaults must map property ids to values";
    if (Object.keys(form.defaults).length > MAX_FORM_DEFAULTS) return `A form can set at most ${MAX_FORM_DEFAULTS} default values`;
    if (FORM_TITLE in form.defaults) return "The name can't have a default value";
  }
  return null;
}

/** Why an answer was refused: a code the UI translates (`form.errors.*` or `database.errors.*`). */
export type AnswerErrorCode = "required" | "tooLong" | "tooMany" | "invalidText" | DatabaseErrorCode;
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
 * values (option ids for selects). Keys that aren't questions are ignored. Strings are trimmed;
 * required questions need an answer; long texts and lists are refused. Every question is checked,
 * so the form can mark all mistakes at once.
 */
export function checkAnswers(questions: ResolvedQuestion[], answers: Record<string, unknown>): CheckedAnswers {
  const errors: AnswerError[] = [];
  const properties: Record<string, unknown> = {};
  let title = "";
  for (const q of questions) {
    const name = q.label || q.prop?.name || "";
    const fail = (code: AnswerErrorCode, params: Record<string, string> = {}) =>
      // Messages name the question as the form shows it, not the property behind it.
      errors.push({ propertyId: q.propertyId, code, params: { ...params, property: name } });
    let value = Object.hasOwn(answers, q.propertyId) ? answers[q.propertyId] : undefined;
    if (typeof value === "string") value = value.trim();
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
      if (isBlankAnswer(normalized)) {
        if (q.required) fail("required");
      } else properties[q.prop.id] = normalized;
    } catch (error) {
      if (!(error instanceof PropertyValueError) || !error.code) throw error;
      fail(error.code, error.params);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, title, properties };
}
