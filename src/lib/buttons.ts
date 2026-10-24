// Client-safe: shared by the button block (components/page/button-block.tsx), its settings, the
// server that runs it (server/buttons.ts) and the Markdown and editor schemas.

import { isDynamicValue, MAX_NOTIFY_PEOPLE, MAX_STEP_MESSAGE, MAX_WEBHOOK_URL, type StepValues } from "./automations";
import type { FilterCombinator, FilterEntry } from "@/db/schema/app";

/**
 * Buttons on pages: a block with a label (and an emoji) that does a few things in order when
 * someone clicks it. It runs on the server as whoever clicked it, each step with that person's
 * access, and its changes are that person's edits: row changes start the database's automations as
 * theirs would, and the row's activity says they came through a button. What it does is the
 * block's own setting, written by people who may edit the page; the server reads it from the page
 * when the button is clicked, never from the browser.
 */

/** The page block. */
export const BUTTON_BLOCK = "button";

export const buttonBlockConfig = {
  type: BUTTON_BLOCK,
  // `config`: the steps and "ask first" as JSON (ButtonConfig, see parseButtonConfig).
  propSchema: { label: { default: "" }, icon: { default: "" }, config: { default: "" } },
  content: "none",
} as const;

/** Where inserted blocks go: the page's top, its end, or right below the button. */
export const INSERT_PLACES = ["below", "top", "bottom"] as const;
export type InsertPlace = (typeof INSERT_PLACES)[number];

/**
 * One thing a button does. Text in `markdown`, `title`, `message` and text values may hold
 * `{{today}}`, `{{now}}` and `{{me}}` (see buttonScope); values may also be `{ $: "now" }` (the
 * day) and `{ $: "actor" }` (whoever clicked), as automations' are.
 */
export type ButtonStep =
  /** Blocks written in Markdown, put on the button's page. */
  | { type: "insert"; at: InsertPlace; markdown: string }
  /** Adds a row to a database, with these values (property ids). */
  | { type: "add_row"; databaseId: string; title: string; values: StepValues }
  /** Sets these values on the rows of a database the filters match (at most MAX_BUTTON_ROWS). */
  | { type: "update_rows"; databaseId: string; filters: FilterEntry[]; filterCombinator: FilterCombinator; values: StepValues }
  /** An inbox notification to these people, about the page, with a message. */
  | { type: "notify"; userIds: string[]; message: string }
  /** A signed JSON POST of the page to this address, as automations' webhooks are signed. */
  | { type: "webhook"; url: string }
  /** Opens a web address or a page of the workspace (lib/image-links parseImageLink) once the rest is done. */
  | { type: "open"; target: string };

export type ButtonStepType = ButtonStep["type"];
export const BUTTON_STEP_TYPES = ["insert", "add_row", "update_rows", "notify", "webhook", "open"] as const satisfies ButtonStepType[];

export type ButtonConfig = {
  /** Ask whoever clicks to confirm before it runs. */
  confirm: boolean;
  steps: ButtonStep[];
};

export const MAX_BUTTON_STEPS = 10;
export const MAX_BUTTON_LABEL = 100;
/** The longest Markdown an insert step holds. */
export const MAX_INSERT_MARKDOWN = 20_000;
/** The most rows an update step changes at once. */
export const MAX_BUTTON_ROWS = 100;
/** The most filter rules (at any depth) an update step has. */
const MAX_FILTER_ENTRIES = 50;
/** The most clicks of one button by one person a minute (server/buttons.ts). */
export const BUTTON_CLICKS_PER_MINUTE = 10;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const id = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 100 ? v : null);

/** Values by property id: stored values and the two dynamic ones, nothing else of an object's. */
function cleanValues(values: unknown): StepValues {
  if (!isRecord(values)) return {};
  const out: StepValues = {};
  for (const [key, value] of Object.entries(values).slice(0, 100)) {
    if (!id(key)) continue;
    if (isDynamicValue(value) || value === null || ["string", "number", "boolean"].includes(typeof value)) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.filter((v) => typeof v === "string").slice(0, 100);
  }
  return out;
}

function countEntries(entries: unknown[], depth = 0): number {
  return entries.reduce<number>((n, e) => n + 1 + (isRecord(e) && Array.isArray(e.rules) && depth < 4 ? countEntries(e.rules, depth + 1) : 0), 0);
}

function cleanStep(step: unknown): ButtonStep | null {
  if (!isRecord(step)) return null;
  switch (step.type) {
    case "insert": {
      const at = INSERT_PLACES.includes(step.at as InsertPlace) ? (step.at as InsertPlace) : "below";
      return { type: "insert", at, markdown: text(step.markdown, MAX_INSERT_MARKDOWN) };
    }
    case "add_row":
      return { type: "add_row", databaseId: id(step.databaseId) ?? "", title: text(step.title, MAX_STEP_MESSAGE), values: cleanValues(step.values) };
    case "update_rows": {
      const filters = Array.isArray(step.filters) && countEntries(step.filters) <= MAX_FILTER_ENTRIES ? (step.filters.filter(isRecord) as FilterEntry[]) : [];
      return {
        type: "update_rows",
        databaseId: id(step.databaseId) ?? "",
        filters,
        filterCombinator: step.filterCombinator === "or" ? "or" : "and",
        values: cleanValues(step.values),
      };
    }
    case "notify":
      return {
        type: "notify",
        userIds: Array.isArray(step.userIds) ? [...new Set(step.userIds.filter((v): v is string => id(v) !== null))].slice(0, MAX_NOTIFY_PEOPLE) : [],
        message: text(step.message, MAX_STEP_MESSAGE),
      };
    case "webhook":
      return { type: "webhook", url: text(step.url, MAX_WEBHOOK_URL) };
    case "open":
      return { type: "open", target: text(step.target, MAX_WEBHOOK_URL) };
    default:
      return null;
  }
}

/** A button's settings from its `config` prop: known steps and fields only, within the limits. */
export function parseButtonConfig(value: unknown): ButtonConfig {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = value ? JSON.parse(value) : {};
    } catch {
      raw = {};
    }
  }
  if (!isRecord(raw)) return { confirm: false, steps: [] };
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).slice(0, MAX_BUTTON_STEPS).flatMap((s) => cleanStep(s) ?? []);
  return { confirm: raw.confirm === true, steps };
}

export const serializeButtonConfig = (config: ButtonConfig) => JSON.stringify(parseButtonConfig(config));

/** A label as it is kept: one line, at most MAX_BUTTON_LABEL characters. */
export const cleanButtonLabel = (label: unknown) => text(label, 4 * MAX_BUTTON_LABEL).replace(/\s+/g, " ").trim().slice(0, MAX_BUTTON_LABEL);

/**
 * What `{{today}}`, `{{now}}` and `{{me}}` stand for when someone clicks: the day and moment in
 * their time zone, and them (`{{me.name}}`, `{{me.email}}` too).
 */
export function buttonScope(now: Date, timeZone: string, me: { id: string; name: string; email: string }) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return { today, now: `${today} ${part("hour")}:${part("minute")}`, me: { ...me, type: "person" } };
}

/**
 * In Markdown (stored for search and history, read and written by MCP) the block is one line with
 * its id and label; what it does stays in the page (restoreButtons), so Markdown can't make one.
 *
 *   <!-- leafdesk:button 5b1e… "Start the week" -->
 */
const BUTTON_LINE = /^ {0,3}<!--\s*leafdesk:button\s+([\w-]{1,64})(?:\s+("(?:[^"\\]|\\.)*"))?\s*-->\s*$/;

export const buttonLine = (blockId: string, label: string) =>
  `<!-- leafdesk:button ${blockId}${label ? ` ${JSON.stringify(label).replace(/>/g, "\\u003e")}` : ""} -->`;

export function parseButtonLine(line: string): { id: string; label: string } | null {
  const match = BUTTON_LINE.exec(line);
  if (!match) return null;
  let label = "";
  try {
    label = match[2] ? cleanButtonLabel(JSON.parse(match[2])) : "";
  } catch {
    label = "";
  }
  return { id: match[1], label };
}

type AnyBlock = { id?: string; type: string; props?: Record<string, unknown>; children?: AnyBlock[] };

/**
 * Buttons parsed from Markdown hold only their id and label: each becomes the page's button with
 * that id, its steps and all (a new label written in the line is taken), or goes when the page has
 * none (or it is named twice).
 */
export function restoreButtons<B extends AnyBlock>(blocks: B[], existing: B[]): B[] {
  const current = new Map<string, B>();
  const collect = (list: B[]) => {
    for (const block of list) {
      if (block.type === BUTTON_BLOCK && block.id) current.set(block.id, block);
      if (block.children?.length) collect(block.children as B[]);
    }
  };
  collect(existing);
  const used = new Set<string>();
  const walk = (list: B[]): B[] =>
    list.flatMap((block) => {
      if (block.type === BUTTON_BLOCK) {
        const blockId = block.id ?? "";
        const match = current.get(blockId);
        if (!match || used.has(blockId)) return [];
        used.add(blockId);
        const label = String(block.props?.label ?? "") || String(match.props?.label ?? "");
        return [{ ...block, id: blockId, props: { ...match.props, label }, children: [] } as B];
      }
      return block.children?.length ? [{ ...block, children: walk(block.children as B[]) }] : [block];
    });
  return walk(blocks);
}

/** A button's text for search and plain-text reads: its icon and label. */
export const buttonPlainText = (props: { label?: unknown; icon?: unknown } | undefined) =>
  [typeof props?.icon === "string" ? props.icon : "", typeof props?.label === "string" ? props.label : ""].filter(Boolean).join(" ");
