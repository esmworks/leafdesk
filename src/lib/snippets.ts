/**
 * Snippets: reusable pieces of content people insert into a page while typing (server/snippets.ts
 * keeps them). This module is shared by the browser and the server: the limits, triggers, how
 * the `;` menu matches what was typed, the placeholders filled in on insert, and the import and
 * export files.
 */
import { searchFold } from "./search-fold";

/** Per person (their personal snippets) and per workspace (its shared ones). */
export const MAX_SNIPPETS = 300;
export const MAX_SNIPPET_BODY = 20_000;
export const MAX_SNIPPET_TRIGGER = 32;
export const MAX_SNIPPET_TITLE = 120;
/** An import file is read whole; a full export of one scope fits with room to spare. */
export const MAX_SNIPPET_IMPORT_BYTES = 8 * 1024 * 1024;

/**
 * Opens the snippet menu in the editor. `/`, `@`, `[[` and `:` (emoji) are taken; `;` isn't
 * Markdown syntax, and the menu only opens at the start of a line or after a space, so a
 * semicolon written after a word never pops it up.
 */
export const SNIPPET_TRIGGER_CHARACTER = ";";

/** Sent on `window` when snippets were added or changed, so open editors read them again. */
export const SNIPPETS_EVENT = "leafdesk:snippets";

export type SnippetScope = "personal" | "workspace";

/** A snippet as the editor's menus list it; the body is fetched when it is inserted. */
export type SnippetSummary = { id: string; scope: SnippetScope; trigger: string; title: string; updatedAt: string };
/** A snippet as settings show it. */
export type SnippetView = SnippetSummary & { body: string };
export type SnippetInput = { trigger: string; title: string; body: string };

export type SnippetErrorCode =
  | "triggerRequired"
  | "triggerInvalid"
  | "triggerTaken"
  | "titleTooLong"
  | "bodyRequired"
  | "bodyTooLong"
  | "tooMany"
  | "notFound"
  | "ownersOnly"
  | "importInvalid"
  | "importTooLarge";

/** An expected failure the UI translates by `code`; the English message is for logs and the API. */
export class SnippetError extends Error {
  constructor(
    readonly code: SnippetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SnippetError";
  }
}

const TRIGGER = /^[a-z0-9_-]{1,32}$/;

export const isSnippetTrigger = (value: unknown): value is string => typeof value === "string" && TRIGGER.test(value);

/** A typed trigger as stored: trimmed and lower-cased, spaces as `-`. May still be invalid. */
export function cleanTrigger(value: unknown): string {
  return (typeof value === "string" ? value : "").trim().toLowerCase().replace(/\s+/g, "-");
}

/** A trigger made from a title, for the form to suggest: "Toplantı notları" → "toplanti-notlari". */
export function triggerFromTitle(title: string): string {
  return searchFold(title)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SNIPPET_TRIGGER)
    .replace(/-+$/, "");
}

/**
 * Checks a snippet against the rules (trigger pattern, title and body length). Throws
 * SnippetError. The title falls back to the trigger.
 */
export function checkSnippetInput(input: Partial<SnippetInput> | null | undefined): SnippetInput {
  const trigger = cleanTrigger(input?.trigger);
  if (!trigger) throw new SnippetError("triggerRequired", "Give the snippet a trigger");
  if (!isSnippetTrigger(trigger)) {
    throw new SnippetError("triggerInvalid", `A trigger is up to ${MAX_SNIPPET_TRIGGER} lowercase letters, digits, "-" and "_"`);
  }
  const title = (typeof input?.title === "string" ? input.title : "").replace(/\s+/g, " ").trim() || trigger;
  if (title.length > MAX_SNIPPET_TITLE) throw new SnippetError("titleTooLong", `A title is up to ${MAX_SNIPPET_TITLE} characters`);
  const body = (typeof input?.body === "string" ? input.body : "").replace(/\r\n?/g, "\n");
  if (!body.trim()) throw new SnippetError("bodyRequired", "The snippet is empty");
  if (body.length > MAX_SNIPPET_BODY) throw new SnippetError("bodyTooLong", `A snippet is up to ${MAX_SNIPPET_BODY} characters`);
  return { trigger, title, body };
}

// ------------------------------------------------------------------------------------- matching

/**
 * The snippets for what was typed after `;`, best first: the trigger itself, triggers starting
 * with it, triggers containing it, then titles starting with or containing it. The query is
 * matched as a whole, so `-` and digits are part of it ("standup-2" finds "standup-2025").
 */
export function matchSnippets<T extends { trigger: string; title: string }>(query: string, snippets: readonly T[]): T[] {
  const q = searchFold(query.trim());
  const rank = (s: T) => {
    if (!q) return 0;
    const title = searchFold(s.title);
    if (s.trigger === q) return 0;
    if (s.trigger.startsWith(q)) return 1;
    if (s.trigger.includes(q)) return 2;
    if (title.startsWith(q)) return 3;
    if (title.includes(q)) return 4;
    return -1;
  };
  return snippets
    .map((s) => ({ s, r: rank(s) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || a.s.trigger.localeCompare(b.s.trigger))
    .map(({ s }) => s);
}

// --------------------------------------------------------------------------------- placeholders

export const SNIPPET_PLACEHOLDERS = ["date", "time", "datetime", "me", "page", "cursor"] as const;
export type SnippetPlaceholder = (typeof SNIPPET_PLACEHOLDERS)[number];

export type PlaceholderContext = {
  now: Date;
  locale: string;
  timeZone: string;
  /** The name of the person inserting the snippet. */
  me: string;
  /** The title of the page it goes into. */
  page: string;
};

const PLACEHOLDER = /\{\{\s*(date|time|datetime|me|page|cursor)\s*\}\}/gi;

/** What each placeholder but `cursor` stands for, in the person's language and time zone. */
export function placeholderValues(ctx: PlaceholderContext): Record<Exclude<SnippetPlaceholder, "cursor">, string> {
  const format = (options: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat(ctx.locale, { ...options, timeZone: ctx.timeZone }).format(ctx.now);
    } catch {
      // An unknown zone: the browser's own.
      return new Intl.DateTimeFormat(ctx.locale, options).format(ctx.now);
    }
  };
  return {
    date: format({ dateStyle: "long" }),
    time: format({ timeStyle: "short" }),
    datetime: format({ dateStyle: "long", timeStyle: "short" }),
    me: ctx.me,
    page: ctx.page,
  };
}

/**
 * A snippet's body ready to become blocks. Each placeholder becomes a token of letters and digits
 * (`nonce` keeps them apart from anything typed), which Markdown leaves alone wherever it stands
 * (in a heading, bold, a table cell, code); `fillPlaceholders` then puts the values into the
 * blocks' text, so a name with `*` or `#` in it is never read as Markdown. The first `{{cursor}}`
 * becomes `cursor`, where the caret goes; the others are dropped.
 */
export function preparePlaceholders(body: string, ctx: PlaceholderContext, nonce: string) {
  const values = placeholderValues(ctx);
  const tokens = new Map<string, string>();
  const cursor = `ldsnip${nonce}c`;
  let cursorUsed = false;
  const markdown = body.replace(PLACEHOLDER, (_, raw: string) => {
    const name = raw.toLowerCase() as SnippetPlaceholder;
    if (name === "cursor") {
      if (cursorUsed) return "";
      cursorUsed = true;
      return cursor;
    }
    const token = `ldsnip${nonce}${name}x`;
    tokens.set(token, values[name]);
    return token;
  });
  return { markdown, tokens, cursor: cursorUsed ? cursor : null };
}

/** The blocks with every placeholder token in their text replaced by its value (in place). */
export function fillPlaceholders<T>(blocks: T, tokens: Map<string, string>): T {
  if (!tokens.size) return blocks;
  const pattern = new RegExp([...tokens.keys()].join("|"), "g");
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      for (const [key, inner] of Object.entries(node)) {
        if (key === "text" && typeof inner === "string") node.text = inner.replace(pattern, (token) => tokens.get(token) ?? "");
        else if (key !== "props") walk(inner);
      }
    }
  };
  walk(blocks);
  return blocks;
}

// ------------------------------------------------------------------------------- import, export

export const SNIPPET_EXPORT_VERSION = 1;

export type SnippetExport = { version: typeof SNIPPET_EXPORT_VERSION; snippets: SnippetInput[] };

export function snippetExport(snippets: readonly SnippetInput[]): SnippetExport {
  return { version: SNIPPET_EXPORT_VERSION, snippets: snippets.map(({ trigger, title, body }) => ({ trigger, title, body })) };
}

export type SkipReason =
  | "triggerRequired"
  | "triggerInvalid"
  | "titleTooLong"
  | "bodyRequired"
  | "bodyTooLong"
  | "duplicate"
  | "exists"
  | "tooMany";

export type SkippedSnippet = { trigger: string; reason: SkipReason };

export type ParsedImport = { snippets: SnippetInput[]; skipped: SkippedSnippet[] };

/**
 * The snippets in an import file: Leafdesk's own export (`{ version: 1, snippets: [{ trigger,
 * title, body }] }`), or a plain array of `{ id, label }` objects (the id is the trigger and the
 * title, the label the body). Entries that break the rules, or repeat a trigger of the file, are
 * skipped with the reason. Throws SnippetError("importInvalid") for a file of neither shape.
 */
export function parseSnippetImport(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new SnippetError("importInvalid", "The file isn't JSON");
  }
  let entries: { trigger: unknown; title: unknown; body: unknown }[];
  if (Array.isArray(data)) {
    if (!data.every((item) => item && typeof item === "object" && !Array.isArray(item) && "id" in item)) {
      throw new SnippetError("importInvalid", "Each entry of the list needs an id and a label");
    }
    entries = data.map((item: { id: unknown; label?: unknown }) => ({ trigger: item.id, title: item.id, body: item.label }));
  } else if (data && typeof data === "object" && (data as { version?: unknown }).version === SNIPPET_EXPORT_VERSION) {
    const list = (data as { snippets?: unknown }).snippets;
    if (!Array.isArray(list) || !list.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      throw new SnippetError("importInvalid", "The file's snippets aren't a list");
    }
    entries = list.map((item: Record<string, unknown>) => ({ trigger: item.trigger, title: item.title, body: item.body }));
  } else {
    throw new SnippetError("importInvalid", "Not a snippets file");
  }

  const snippets: SnippetInput[] = [];
  const skipped: SkippedSnippet[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const shown = typeof entry.trigger === "string" || typeof entry.trigger === "number" ? String(entry.trigger).slice(0, 80) : "";
    try {
      const snippet = checkSnippetInput({
        trigger: typeof entry.trigger === "number" ? String(entry.trigger) : (entry.trigger as string),
        title: typeof entry.title === "number" ? String(entry.title) : (entry.title as string),
        body: entry.body as string,
      });
      if (seen.has(snippet.trigger)) {
        skipped.push({ trigger: snippet.trigger, reason: "duplicate" });
        continue;
      }
      seen.add(snippet.trigger);
      snippets.push(snippet);
    } catch (error) {
      if (!(error instanceof SnippetError)) throw error;
      skipped.push({ trigger: shown, reason: error.code as SkipReason });
    }
  }
  return { snippets, skipped };
}
