// Client-safe: shared by the AI server code (src/server/ai*) and the editor and database UI.

import { parseFormula } from "./formula";

export const AI_ERROR_CODES = [
  /** The server has no AI provider, or the workspace turned AI off. */
  "disabled",
  /** The page or row doesn't exist or the person may not change it. */
  "noAccess",
  /** More text than one request may send (AI_MAX_INPUT_CHARS). */
  "tooLarge",
  "rateLimited",
  "timeout",
  /** Cancelled by the person (or their connection closed). */
  "aborted",
  /** The provider refused or failed (bad key, unknown model, outage). */
  "provider",
  /** The model answered with nothing usable. */
  "empty",
  /** The request itself is malformed (unknown action, missing text). */
  "invalid",
  /** A background value was being worked out when the server restarted. */
  "interrupted",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export const isAiErrorCode = (code: unknown): code is AiErrorCode =>
  typeof code === "string" && (AI_ERROR_CODES as readonly string[]).includes(code);

/**
 * Writing actions in the editor. Actions on a selection rewrite it; "continue" writes on from the
 * cursor, "summarize" sums up the whole page, "custom" follows the person's own instruction (on
 * the selection, or writing new text without one).
 */
export const EDITOR_ACTIONS = ["improve", "shorten", "fix", "translate", "continue", "summarize", "custom"] as const;
export type EditorAction = (typeof EDITOR_ACTIONS)[number];

/** Actions that rewrite selected text (their result can replace it). */
export const SELECTION_ACTIONS: readonly EditorAction[] = ["improve", "shorten", "fix", "translate"];

/**
 * Target languages offered for translation (BCP 47). The prompt names them in English; the UI
 * names them in the reader's language with Intl.DisplayNames.
 */
export const AI_LANGUAGES = ["en", "tr", "de", "fr", "es", "it", "pt", "nl", "pl", "ru", "uk", "ar", "he", "fa", "ja", "ko", "zh"] as const;
export type AiLanguage = (typeof AI_LANGUAGES)[number];

export const isAiLanguage = (value: unknown): value is AiLanguage =>
  typeof value === "string" && (AI_LANGUAGES as readonly string[]).includes(value);

/** A language code's English name, for prompts. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// ----------------------------------------------------------------------------------- autofill

/**
 * AI autofill of a text property (#42), stored in the property's options. Values are ordinary text
 * values, so filters, sorts, exports, the REST API and MCP treat them like any other text.
 * - `summary`: sums up the row's page content (and title).
 * - `translation`: translates one source (a property, the title or the page content) into `language`.
 * - `custom`: follows `prompt`, where `{Property name}` stands for that property's value of the row,
 *   `{title}` for the row's title; with `includeBody` the page content goes along too.
 * Values are worked out on request (a row's refresh, "update all"); with `auto` also after the row's
 * other values or content change.
 *
 * Other AI values, and formulas reading them, go into a prompt only where the settings name them
 * (the translated property, a `{Property}` placeholder): see autofillReads. So what an autofill
 * reads of other autofills is always spelled out, and settings that would read themselves through
 * other autofills are refused (`cycle`).
 */
export type AiAutofillMode = "summary" | "translation" | "custom";
export const AI_AUTOFILL_MODES: readonly AiAutofillMode[] = ["summary", "translation", "custom"];

export type AiAutofillConfig = {
  mode: AiAutofillMode;
  /** translation: the target language (see AI_LANGUAGES). */
  language?: string;
  /** translation: a property id, "title" or "body". */
  source?: string;
  /** custom: the instruction, with `{Property}` placeholders. */
  prompt?: string;
  /** custom: send the row's page content along. */
  includeBody?: boolean;
  /** Work the value out again (debounced) when the row's other values or content change. */
  auto?: boolean;
};

export const AUTOFILL_TITLE = "title";
export const AUTOFILL_BODY = "body";
export const MAX_AUTOFILL_PROMPT = 2000;
/** Longest value an autofill writes; longer answers are cut. */
export const MAX_AUTOFILL_VALUE = 5000;
/** Rows one "update all" may queue. */
export const MAX_AUTOFILL_ROWS = 500;

/** The names in a prompt's `{…}` placeholders, in order, each once. */
export function promptPlaceholders(prompt: string): string[] {
  const names = [...prompt.matchAll(/\{([^{}\n]{1,100})\}/g)].map((m) => m[1].trim()).filter(Boolean);
  return [...new Set(names)];
}

export const AUTOFILL_ERROR_CODES = [
  "invalidMode",
  "unknownLanguage",
  "unknownSource",
  "promptRequired",
  "promptTooLong",
  "unknownPlaceholder",
  /** The value would read itself through other AI values (`name`: the one it reads). */
  "cycle",
  /** The settings name a property that never goes into a prompt (`name`, see autofillHiddenInputs). */
  "hiddenInput",
] as const;
export type AutofillErrorCode = (typeof AUTOFILL_ERROR_CODES)[number];
export type AutofillCheck = { ok: true; config: AiAutofillConfig } | { ok: false; code: AutofillErrorCode; params?: Record<string, string> };

/** What autofill needs to know of a database property; `type` and `options` matter for what reads what. */
export type AutofillProperty = {
  id: string;
  name: string;
  type?: string;
  options?: { ai?: AiAutofillConfig | null; formula?: { expression?: string } | null };
};

/** The properties settings name as inputs: the translated property, the prompt's placeholders. */
export function autofillNamedInputs(config: AiAutofillConfig, properties: AutofillProperty[], selfId?: string): string[] {
  const others = properties.filter((p) => p.id !== selfId);
  if (config.mode === "translation") return others.some((p) => p.id === config.source) ? [config.source!] : [];
  if (config.mode !== "custom") return [];
  const names = new Set(promptPlaceholders(config.prompt ?? "").map((name) => name.toLowerCase()));
  return others.filter((p) => names.has(p.name.trim().toLowerCase())).map((p) => p.id);
}

const isAutofill = (p: AutofillProperty) => p.type === "text" && Boolean(p.options?.ai);
const formulaRefs = (p: AutofillProperty) => (p.type === "formula" ? parseFormula(p.options?.formula?.expression ?? "").refs : []);

/** AI values and the formulas reading them, as far as that goes: what prompts take in only when named. */
export function aiDerivedProperties(properties: AutofillProperty[]): Set<string> {
  const derived = new Set(properties.filter(isAutofill).map((p) => p.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of properties) {
      if (derived.has(p.id) || !formulaRefs(p).some((id) => derived.has(id))) continue;
      derived.add(p.id);
      grew = true;
    }
  }
  return derived;
}

/**
 * Property types whose values come from related rows or name people: relations, rollups, people,
 * and who added or last edited the row. They show each reader only the related rows and people
 * that reader may see, while an AI value is plain text that everyone who reads the row sees: they
 * never go into a prompt, named or not (as semantic-text.ts keeps them out of the shared index).
 */
const HIDDEN_INPUT_TYPES = new Set(["relation", "rollup", "person", "created_by", "last_edited_by"]);

/** Properties that never go into a prompt: those types, and formulas reading them (through other formulas too). */
export function autofillHiddenInputs(properties: AutofillProperty[]): Set<string> {
  const hidden = new Set(properties.filter((p) => HIDDEN_INPUT_TYPES.has(p.type ?? "")).map((p) => p.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of properties) {
      if (hidden.has(p.id) || !formulaRefs(p).some((id) => hidden.has(id))) continue;
      hidden.add(p.id);
      grew = true;
    }
  }
  return hidden;
}

/**
 * The AI values settings read: the AI properties they name, and those the formulas they name read
 * (through other formulas too). What an AI property reads further is its own input, not theirs.
 */
export function autofillReads(config: AiAutofillConfig, properties: AutofillProperty[], selfId?: string): string[] {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const reads = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string) => {
    const p = byId.get(id);
    if (!p || seen.has(id)) return;
    seen.add(id);
    if (isAutofill(p)) reads.add(id);
    else formulaRefs(p).forEach(visit);
  };
  autofillNamedInputs(config, properties, selfId).forEach(visit);
  reads.delete(selfId ?? "");
  return [...reads];
}

/**
 * The AI property through which settings for `selfId` would read their own value (directly or via
 * other AI values), or null. Settings stored before this was checked are left as they are; the
 * automatic updates never go round in circles anyway (ai-properties.ts `followUpTargets`).
 */
export function autofillCycle(config: AiAutofillConfig, properties: AutofillProperty[], selfId: string): AutofillProperty | null {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const readsOf = (id: string) => {
    const p = byId.get(id);
    return p?.options?.ai && isAutofill(p) ? autofillReads(p.options.ai, properties, id) : [];
  };
  const seen = new Set<string>();
  const reaches = (id: string): boolean => {
    if (id === selfId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return readsOf(id).some(reaches);
  };
  // Self's settings are the new ones; what it reads is checked against what the others read now.
  const first = autofillReads(config, properties, selfId).find((id) => reaches(id));
  return first ? byId.get(first)! : null;
}

/**
 * Checks autofill settings against the database's properties (`selfId`: the property being set up,
 * which can't be its own input) and returns them cleaned: only the fields the mode uses.
 */
export function checkAutofill(input: unknown, properties: AutofillProperty[], selfId?: string): AutofillCheck {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const mode = raw.mode as AiAutofillMode;
  if (!AI_AUTOFILL_MODES.includes(mode)) return { ok: false, code: "invalidMode" };
  const auto = raw.auto === true;
  const others = properties.filter((p) => p.id !== selfId);
  const hidden = autofillHiddenInputs(properties);
  if (mode === "summary") return { ok: true, config: { mode, auto } };
  if (mode === "translation") {
    if (!isAiLanguage(raw.language)) return { ok: false, code: "unknownLanguage" };
    const source = typeof raw.source === "string" ? raw.source : AUTOFILL_TITLE;
    if (source !== AUTOFILL_TITLE && source !== AUTOFILL_BODY && !others.some((p) => p.id === source)) {
      return { ok: false, code: "unknownSource" };
    }
    if (hidden.has(source)) return { ok: false, code: "hiddenInput", params: { name: others.find((p) => p.id === source)!.name } };
    return withoutCycle({ mode, language: raw.language, source, auto }, properties, selfId);
  }
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return { ok: false, code: "promptRequired" };
  if (prompt.length > MAX_AUTOFILL_PROMPT) return { ok: false, code: "promptTooLong", params: { max: String(MAX_AUTOFILL_PROMPT) } };
  const known = new Set([AUTOFILL_TITLE, ...others.map((p) => p.name.trim().toLowerCase())]);
  const unknown = promptPlaceholders(prompt).find((name) => !known.has(name.toLowerCase()));
  if (unknown) return { ok: false, code: "unknownPlaceholder", params: { name: unknown } };
  const names = new Set(promptPlaceholders(prompt).map((name) => name.toLowerCase()));
  const named = others.find((p) => hidden.has(p.id) && names.has(p.name.trim().toLowerCase()));
  if (named) return { ok: false, code: "hiddenInput", params: { name: named.name } };
  return withoutCycle({ mode, prompt, includeBody: raw.includeBody === true, auto }, properties, selfId);
}

function withoutCycle(config: AiAutofillConfig, properties: AutofillProperty[], selfId?: string): AutofillCheck {
  const through = selfId ? autofillCycle(config, properties, selfId) : null;
  return through ? { ok: false, code: "cycle", params: { name: through.name } } : { ok: true, config };
}

/** Where a background value stands, per row and property; values without an entry are done. */
export type AiCellState = { status: "pending" } | { status: "error"; code: AiErrorCode };
