import * as z from "zod";
import type { FormCondition, ViewConfig, ViewType } from "@/db/schema/app";
import {
  FORM_TITLE,
  canDefault,
  conditionOps,
  conditionTakesValues,
  formConfigError,
  formSchemaError,
  isAskable,
  MAX_CONFIRMATION,
  MAX_FORM_DEFAULTS,
  MAX_FORM_DESCRIPTION,
  MAX_FORM_QUESTIONS,
  MAX_FORM_TITLE,
  MAX_QUESTION_DESCRIPTION,
  MAX_QUESTION_LABEL,
} from "@/lib/forms";
import { holdsOptions } from "@/lib/property-types";
import * as forms from "@/server/forms";
import { rowValue } from "@/server/operations";
import { checked, see } from "./docs";
import { ToolInputError } from "./format";
import { resolvePropertyKey, type PropertyDef } from "./query";

/**
 * A form view's settings as tools take them (MCP's create_database_view and update_database_view,
 * the AI chat's create_form): checked and turned into the view's stored form, and its public link.
 */

/** Form settings, shared by create_database_view and update_database_view. */
export const formInputs = {
  questions: z
    .array(
      z.object({
        property: z.string().min(1).describe('Property name or id, or "title" for the row\'s name.'),
        required: z.boolean().optional().describe("The form can't be sent without an answer (for a checkbox: a tick)."),
        label: z.string().max(MAX_QUESTION_LABEL).optional().describe("Question text shown instead of the property name."),
        description: z.string().max(MAX_QUESTION_DESCRIPTION).optional().describe("Help text under the question."),
      }),
    )
    .max(MAX_FORM_QUESTIONS)
    .optional()
    .describe(
      'Form only: the questions, in order; replaces the current ones. A new form asks for the title (required) and every property a form can ask for. created_by, created_time, last_edited_by, last_edited_time, formula and rollup properties can\'t be asked; relation and person questions are asked in the app only, never on the public link.',
    ),
  form_title: z.string().max(MAX_FORM_TITLE).optional().describe("Form only: heading of the form (the database title when empty)."),
  form_description: z.string().max(MAX_FORM_DESCRIPTION).optional().describe("Form only: text under the heading."),
  confirmation_message: z
    .string()
    .max(MAX_CONFIRMATION)
    .optional()
    .describe("Form only: shown after an answer is sent (a generic thank-you when empty)."),
  allow_another: z.boolean().optional().describe("Form only: offer to send another answer after one is sent (true by default)."),
  defaults: checked(
    z.record(z.string(), rowValue),
    "object",
    `Form only: values every row sent through the form gets for properties it doesn't ask, keyed by property name or id, in the same form as row values; replaces the current ones. Example: {"Status": "New"}. ${see("properties")}`,
  ).optional(),
  public: z
    .boolean()
    .optional()
    .describe(
      "Form only: true opens the form to anyone with the link (needs full access to the database and a workspace that lets the user publish); false turns the link off. Turning it on again makes a new link.",
    ),
  anonymous: z
    .boolean()
    .optional()
    .describe(
      "Form with a public link: true takes answers without signing in and records nobody as creator; false (the default) asks people to sign in and records them.",
    ),
};

/**
 * When a question is asked: an earlier question (by property name, or "title"), the check
 * (lib/forms conditionOps) and, for checks that compare, option names or one text.
 */
export type ConditionInput = { question: string; check: string; values?: string[] };

/**
 * `show_when`, `min_choices`, `max_choices`, `show_own_answers` and `one_by_one` aren't MCP inputs (its tool
 * list has no room for them): the AI chat's create_form sets them, and MCP keeps what the app set.
 */
export type FormInput = {
  questions?: {
    property: string;
    required?: boolean;
    label?: string;
    description?: string;
    show_when?: ConditionInput;
    min_choices?: number;
    max_choices?: number;
  }[];
  form_title?: string;
  form_description?: string;
  confirmation_message?: string;
  allow_another?: boolean;
  show_own_answers?: boolean;
  one_by_one?: boolean;
  defaults?: Record<string, unknown>;
  public?: boolean;
  anonymous?: boolean;
};

const FORM_SETTINGS = [
  "questions",
  "form_title",
  "form_description",
  "confirmation_message",
  "allow_another",
  "show_own_answers",
  "one_by_one",
  "defaults",
  "public",
  "anonymous",
] as const;

/** A condition by name as stored: the question's property id, the check, option ids or the text. */
function conditionFrom(props: PropertyDef[], earlier: ReadonlySet<string>, input: ConditionInput): FormCondition {
  const { key, prop } = resolvePropertyKey(props, input.question);
  if (!earlier.has(key)) throw new ToolInputError(`A question can only depend on one asked before it; "${input.question}" isn't.`);
  const type = prop?.type ?? "title";
  const checks = conditionOps(type);
  const op = checks.find((c) => c === input.check);
  if (!op) throw new ToolInputError(`"${input.question}" can be checked with ${checks.join(", ")}, not "${input.check}".`);
  if (!conditionTakesValues(op)) return { propertyId: key, op };
  const given = (input.values ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (!given.length) throw new ToolInputError(`The check "${op}" of "${input.question}" needs values.`);
  if (!prop || !holdsOptions(prop.type)) return { propertyId: key, op, values: given.slice(0, 1) };
  const options = prop.options.options ?? [];
  const values = given.map((name) => {
    const option = options.find((o) => o.id === name || o.name.trim().toLowerCase() === name.toLowerCase());
    if (!option) throw new ToolInputError(`"${name}" is not an option of "${prop.name}". Options: ${options.map((o) => o.name).join(", ") || "none"}`);
    return option.id;
  });
  return { propertyId: key, op, values: [...new Set(values)] };
}

/** The form settings the caller asked to change, merged into the view's form. Names become ids. */
export function formConfigPatch(props: PropertyDef[], type: ViewType, current: ViewConfig, input: FormInput): ViewConfig {
  const given = FORM_SETTINGS.filter((key) => input[key] !== undefined);
  if (!given.length) return {};
  if (type !== "form") throw new ToolInputError(`${given.join(", ")} only apply to form views.`);
  const form = { ...current.form };
  if (input.questions) {
    const seen = new Set<string>();
    const before = new Map((current.form?.questions ?? []).map((q) => [q.propertyId, q]));
    form.questions = input.questions.map((q) => {
      const { key, prop } = resolvePropertyKey(props, q.property);
      if (!prop && key !== FORM_TITLE) throw new ToolInputError(`"${q.property}" can't be asked in a form.`);
      if (prop && !isAskable(prop.type)) throw new ToolInputError(`"${prop.name}" is ${prop.type}, which a form can't ask for.`);
      if (seen.has(key)) throw new ToolInputError(`"${q.property}" is asked twice.`);
      // A question asked before keeps the condition and choice limits it had unless new ones are
      // given, as long as its condition is still about a question asked before it.
      const was = before.get(key);
      const showIf = q.show_when
        ? conditionFrom(props, seen, q.show_when)
        : was?.showIf && seen.has(was.showIf.propertyId)
          ? was.showIf
          : undefined;
      const minChoices = q.min_choices ?? was?.minChoices;
      const maxChoices = q.max_choices ?? was?.maxChoices;
      seen.add(key);
      return {
        propertyId: key,
        ...(q.required ? { required: true } : {}),
        ...(q.label?.trim() ? { label: q.label.trim() } : {}),
        ...(q.description?.trim() ? { description: q.description.trim() } : {}),
        ...(showIf ? { showIf } : {}),
        ...(minChoices !== undefined ? { minChoices } : {}),
        ...(maxChoices !== undefined ? { maxChoices } : {}),
      };
    });
  }
  if (input.show_own_answers !== undefined) form.showOwnAnswers = input.show_own_answers ? true : undefined;
  if (input.one_by_one !== undefined) form.oneByOne = input.one_by_one ? true : undefined;
  if (input.form_title !== undefined) form.title = input.form_title.trim() || undefined;
  if (input.form_description !== undefined) form.description = input.form_description.trim() || undefined;
  if (input.confirmation_message !== undefined) form.confirmation = input.confirmation_message.trim() || undefined;
  if (input.allow_another !== undefined) form.allowAnother = input.allow_another ? undefined : false;
  if (input.defaults) {
    const asked = new Set((form.questions ?? []).map((q) => q.propertyId));
    const entries = Object.entries(input.defaults);
    if (entries.length > MAX_FORM_DEFAULTS) throw new ToolInputError(`A form can set at most ${MAX_FORM_DEFAULTS} default values.`);
    // Values stay as given (option names, emails, "me"…): updateView checks and stores them as ids.
    form.defaults = Object.fromEntries(
      entries.map(([ref, value]) => {
        const prop = requireProperty(props, ref);
        if (!canDefault(prop.type)) throw new ToolInputError(`"${prop.name}" is ${prop.type}; it can't have a default value.`);
        if (asked.has(prop.id)) throw new ToolInputError(`"${prop.name}" is a question; its answer is what the row gets.`);
        return [prop.id, value];
      }),
    );
  }
  // Conditions and choice limits as the app checks them, so a tool hears what is wrong by name.
  const error = formConfigError(form) ?? formSchemaError(form, props, current.form);
  if (error) throw new ToolInputError(`${error}.`);
  return { form };
}

/** Opens or closes a form's public link as asked; returns the link, if any. */
export async function applyFormLink(userId: string, viewId: string, input: FormInput) {
  try {
    if (input.public === false) {
      if (input.anonymous !== undefined) throw new ToolInputError("anonymous only applies while the form has a public link.");
      await forms.unpublishForm(userId, viewId);
    } else if (input.public || input.anonymous !== undefined) {
      const current = (await forms.formPublicationsOf([viewId])).get(viewId);
      if (!input.public && !current) throw new ToolInputError("anonymous only applies while the form has a public link; pass public: true.");
      await forms.publishForm(userId, viewId, { anonymous: input.anonymous ?? current?.anonymous ?? false });
    }
  } catch (error) {
    if (error instanceof forms.FormError) throw new ToolInputError(`${error.message}.`);
    throw error;
  }
  return (await forms.formPublicationsOf([viewId])).get(viewId) ?? null;
}

/** Resolves a property by name or id; title / created_at / updated_at are not editable properties. */
export function requireProperty<P extends PropertyDef>(props: P[], ref: string): P {
  const { prop } = resolvePropertyKey(props, ref);
  if (!prop) throw new ToolInputError(`"${ref}" is a built-in field, not a database property.`);
  return prop as P;
}
