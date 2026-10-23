/**
 * Writing a formula from a description (the formula editor's "Describe it" box): the AI is told
 * the formula language (lib/formula/reference, made from the engine's functions) and the database's
 * properties the person may know of, names and types only, never row values. What it writes is
 * checked like a formula the person typed (databases.checkFormula); a formula that fails goes back
 * once with the error, and one that fails again comes back with its error, not as a suggestion.
 * A good one comes with what it gives on the first few rows. Nothing is saved: the person takes
 * the formula into the editor and saves it as usual.
 *
 * The request counts as "formula.write" in the workspace's AI usage and is held to its limits.
 */
import { baseType } from "@/lib/derived";
import type { FormulaError, FormulaResultType } from "@/lib/formula";
import { formulaReference } from "@/lib/formula/reference";
import { holdsOptions } from "@/lib/property-types";
import { AiError, complete, type AiMessage } from "@/server/ai";
import { formulaAnswer, formulaPrompt, type FormulaPromptProperty } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { checkFormula, knownProperties, previewFormula, requireDatabase, type DatabaseProperty, type FormulaPreviewRow } from "@/server/databases";

export const MAX_FORMULA_REQUEST = 500;
/** Rows a suggestion is shown on. */
export const FORMULA_PREVIEW_ROWS = 3;
/** Properties (and options of each, and properties of a related database) a prompt names at most. */
const MAX_PROMPT_PROPERTIES = 150;
const MAX_PROMPT_OPTIONS = 30;
const MAX_RELATED_PROPERTIES = 25;
const MAX_RELATIONS = 5;

export type FormulaRequest = {
  databaseId: string;
  /** The formula property being edited; null while adding one. */
  propertyId: string | null;
  /** Its name (a new property's name). */
  name: string;
  description: string;
  /** The Name column's label in the person's language, which also means the row's title. */
  titleName?: string;
};

/**
 * The AI's formula, as written (with property names, for the editor), and either its result type
 * and what it gives on the first rows, or the check's error after the second try.
 */
export type FormulaSuggestion =
  | { expression: string; type: FormulaResultType; error: null; preview: FormulaPreviewRow[] }
  | { expression: string; type: null; error: FormulaError; preview: [] };

/** A made-up id for a property being added, as the editor uses one. */
const NEW_ID = "\u0000new";

async function promptProperties(userId: string, properties: DatabaseProperty[]): Promise<FormulaPromptProperty[]> {
  const relations = properties.filter((p) => p.type === "relation" && p.options.relation?.databaseId).slice(0, MAX_RELATIONS);
  // A related database's properties only when the person may open it, and only those they may know of.
  const related = new Map(
    await Promise.all(
      relations.map(async (p) => {
        const id = p.options.relation!.databaseId;
        const props = await requireDatabase(userId, id, "view")
          .then(() => knownProperties(userId, id))
          .catch(() => []);
        return [p.id, props.slice(0, MAX_RELATED_PROPERTIES).map((r) => ({ name: r.name, type: r.type }))] as const;
      }),
    ),
  );
  return properties.slice(0, MAX_PROMPT_PROPERTIES).map((p) => {
    const reads = p.type === "formula" ? (p.options.formula?.type ?? "text") : baseType(p);
    const options = holdsOptions(p.type) ? (p.options.options ?? []).slice(0, MAX_PROMPT_OPTIONS).map((o) => o.name) : [];
    const rows = related.get(p.id) ?? [];
    return { name: p.name, type: p.type, reads, ...(options.length ? { options } : {}), ...(rows.length ? { related: rows } : {}) };
  });
}

/**
 * A formula doing what `description` says, for someone who may change the database's properties.
 * Throws AccessError when they may not, AiError when the workspace has no AI, the description is
 * empty or the request fails.
 */
export async function suggestFormula(userId: string, input: FormulaRequest, { signal, now = new Date() }: { signal?: AbortSignal; now?: Date } = {}): Promise<FormulaSuggestion> {
  const description = typeof input.description === "string" ? input.description.trim().slice(0, MAX_FORMULA_REQUEST) : "";
  if (!description) throw new AiError("invalid", "Describe what the formula should work out");
  const database = await requireDatabase(userId, input.databaseId, "edit");
  if (!(await aiAvailable(database.workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  const name = (typeof input.name === "string" ? input.name.trim() : "").slice(0, 200) || "Formula";
  const self = { id: input.propertyId ?? NEW_ID, name };
  const known = await knownProperties(userId, input.databaseId);
  const others = known.filter((p) => p.id !== self.id);
  const titleNames = input.titleName?.trim() ? [input.titleName.trim().slice(0, 100)] : [];

  const prompt = formulaPrompt({
    description,
    name,
    properties: await promptProperties(userId, others),
    reference: formulaReference(),
    today: now.toISOString().slice(0, 10),
  });
  const messages: AiMessage[] = [{ role: "user", content: prompt.prompt }];
  let expression = "";
  let error: FormulaError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete({ feature: "formula.write", userId, workspaceId: database.workspaceId, system: prompt.system, messages, signal });
    expression = formulaAnswer(result.text);
    if (!expression) throw new AiError("empty", "The AI's answer held no formula");
    const checked = await checkFormula(userId, expression, known, self, titleNames);
    if (!checked.error) {
      const preview = await previewFormula(userId, input.databaseId, self, checked.stored, checked.type, FORMULA_PREVIEW_ROWS);
      return { expression, type: checked.type, error: null, preview };
    }
    error = checked.error;
    messages.push(result.message, {
      role: "user",
      content: `That formula doesn't work: ${checked.error.message}. Write it again so that it works, with the same rules: the formula alone.`,
    });
  }
  return { expression, type: null, error: error!, preview: [] };
}
