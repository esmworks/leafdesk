// Client-safe: the draft the AI makes of an agent from an owner's description (see
// server/agents/draft.ts), read and checked here, and shown in the creation dialog.

import { isAgentAccessLevel, MAX_AGENT_DESCRIPTION, MAX_AGENT_INSTRUCTIONS, MAX_AGENT_NAME, MAX_SCHEDULE_TASK, type AgentAccessLevel } from "./agents";
import { MAX_DATE_PASSED_DAYS } from "./automations";
import { parseIcon } from "./icon";
import { parseRepeatRule, type RepeatRule } from "./schedule";

/** What an owner may write to describe an agent. */
export const MAX_AGENT_REQUEST = 2_000;
/** Pages a draft shares with the agent at most, and schedules and automations it suggests. */
export const MAX_DRAFT_PAGES = 10;
export const MAX_DRAFT_SCHEDULES = 3;
export const MAX_DRAFT_AUTOMATIONS = 3;

/**
 * A page or database the AI may suggest sharing: one the owner has full access to (sharing takes
 * it). Databases carry the properties an automation's trigger may name.
 */
export type DraftCandidate = {
  id: string;
  title: string;
  icon: string | null;
  kind: "page" | "database";
  properties?: { id: string; name: string; type: string }[];
};

/** A schedule's rule without its first day: the schedule starts on the day it is saved. */
export type DraftRule = Omit<RepeatRule, "start">;

/** The automation triggers a draft may suggest (a form's answers are rows added). */
export type DraftTrigger =
  | { type: "row_created" }
  | { type: "property_changed"; propertyId: string | null }
  /** `date`: a date property's id, "created_time" or "last_edited_time". */
  | { type: "date_passed"; date: string; days: number };

export type AgentDraftPage = { pageId: string; title: string; icon: string | null; kind: "page" | "database"; level: AgentAccessLevel };
export type AgentDraftSchedule = { rule: DraftRule; task: string; databaseId: string | null; databaseTitle: string | null };
export type AgentDraftAutomation = {
  databaseId: string;
  databaseTitle: string;
  trigger: DraftTrigger;
  /** The property the trigger names, for showing it. */
  propertyName: string | null;
  task: string;
};

/** An agent as drafted, not saved: the owner reviews it, and creating it sets up the rest. */
export type AgentDraft = {
  name: string;
  icon: string | null;
  description: string;
  instructions: string;
  pages: AgentDraftPage[];
  schedules: AgentDraftSchedule[];
  automations: AgentDraftAutomation[];
};

/** The JSON object in a model's answer: its own, or inside code fences or text around it. Null without one. */
export function readDraftJson(answer: string): unknown {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max).trim() : "");

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A list, or one item given on its own. */
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/**
 * An access level an agent may have: "full" comes down to edit (an agent never has more), anything
 * else unknown to `fallback`.
 */
export function clampAccessLevel(value: unknown, fallback: AgentAccessLevel = "view"): AgentAccessLevel {
  const level = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (isAgentAccessLevel(level)) return level;
  if (level === "full" || level === "owner" || level === "write") return "edit";
  return fallback;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function weekday(value: unknown): number | null {
  // 7 for Sunday, as some count the week.
  if (typeof value === "number") return value === 7 ? 0 : value;
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  const found = WEEKDAY_NAMES.findIndex((day) => name.length >= 3 && day.startsWith(name));
  return found >= 0 ? found : null;
}

/** "9:00" → "09:00"; the rule's own check does the rest. */
const time = (value: unknown) => (typeof value === "string" ? value.trim().replace(/^(\d):/, "0$1:") : value);

function readRule(input: Record<string, unknown>): DraftRule | null {
  const weekdays = list(input.weekdays).map(weekday);
  // Any first day will do to check the rule: the schedule gets its own when it is saved.
  const rule = parseRepeatRule({
    frequency: typeof input.frequency === "string" ? input.frequency.trim().toLowerCase() : input.frequency,
    interval: input.interval ?? 1,
    weekdays,
    time: time(input.time),
    start: "2026-01-05",
  });
  if (!rule) return null;
  const { start: _start, ...rest } = rule;
  return rest;
}

function readTrigger(input: Record<string, unknown>, database: DraftCandidate): { trigger: DraftTrigger; propertyName: string | null } | null {
  const type = typeof input.trigger === "string" ? input.trigger : (record(input.trigger)?.type ?? input.type);
  const properties = database.properties ?? [];
  if (type === "row_created" || type === "form_answer") return { trigger: { type: "row_created" }, propertyName: null };
  if (type === "property_changed") {
    const property = properties.find((p) => p.id === input.property_id);
    return { trigger: { type: "property_changed", propertyId: property?.id ?? null }, propertyName: property?.name ?? null };
  }
  if (type === "date_passed") {
    const days = typeof input.days === "number" ? input.days : 0;
    if (!Number.isInteger(days) || days < 0 || days > MAX_DATE_PASSED_DAYS) return null;
    const date = input.date ?? input.property_id;
    if (date === "created_time" || date === "last_edited_time") return { trigger: { type: "date_passed", date, days }, propertyName: null };
    const property = properties.find((p) => p.id === date && p.type === "date");
    return property ? { trigger: { type: "date_passed", date: property.id, days }, propertyName: property.name } : null;
  }
  return null;
}

/**
 * The draft in a model's answer (`raw`, its JSON), checked: texts cut to their limits, access
 * levels an agent may have, pages and databases only from `candidates` (anything else is left
 * out), schedules with a valid rule and a task, automations on a candidate database with a trigger
 * that exists. What doesn't pass is dropped, not refused. Null when there is no agent in it at all
 * (neither a name nor instructions); a missing name then comes from `fallbackName`.
 */
export function validateAgentDraft(raw: unknown, candidates: DraftCandidate[], fallbackName = ""): AgentDraft | null {
  const input = record(raw);
  if (!input) return null;
  const instructions = text(input.instructions, MAX_AGENT_INSTRUCTIONS);
  const name = text(input.name, MAX_AGENT_NAME) || (instructions ? text(fallbackName, MAX_AGENT_NAME) : "");
  if (!name && !instructions) return null;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const access = clampAccessLevel(input.access);

  const pages: AgentDraftPage[] = [];
  const share = (candidate: DraftCandidate, level: AgentAccessLevel) => {
    if (pages.some((p) => p.pageId === candidate.id) || pages.length >= MAX_DRAFT_PAGES) return;
    pages.push({ pageId: candidate.id, title: candidate.title, icon: candidate.icon, kind: candidate.kind, level });
  };
  for (const item of list(input.pages)) {
    const entry = record(item);
    const id = typeof item === "string" ? item : entry?.id;
    const candidate = typeof id === "string" ? byId.get(id) : undefined;
    if (candidate) share(candidate, clampAccessLevel(entry?.access ?? entry?.level, access));
  }

  const database = (id: unknown) => {
    const found = typeof id === "string" ? byId.get(id) : undefined;
    return found?.kind === "database" ? found : undefined;
  };

  const schedules: AgentDraftSchedule[] = [];
  for (const item of list(input.schedules ?? input.schedule)) {
    const entry = record(item);
    if (!entry || schedules.length >= MAX_DRAFT_SCHEDULES) continue;
    const rule = readRule(record(entry.rule) ?? entry);
    const task = text(entry.task, MAX_SCHEDULE_TASK);
    if (!rule || !task) continue;
    const on = database(entry.database_id ?? entry.databaseId);
    // Its runs skip a database the agent can't open: one it looks after is shared with it too.
    if (on) share(on, access);
    schedules.push({ rule, task, databaseId: on?.id ?? null, databaseTitle: on?.title ?? null });
  }

  const automations: AgentDraftAutomation[] = [];
  for (const item of list(input.automations ?? input.automation)) {
    const entry = record(item);
    if (!entry || automations.length >= MAX_DRAFT_AUTOMATIONS) continue;
    const on = database(entry.database_id ?? entry.databaseId);
    const task = text(entry.task, MAX_SCHEDULE_TASK);
    const read = on && readTrigger(entry, on);
    if (!on || !read || !task) continue;
    automations.push({ databaseId: on.id, databaseTitle: on.title, ...read, task });
  }

  return {
    name,
    icon: parseIcon(input.icon),
    description: text(input.description, MAX_AGENT_DESCRIPTION),
    instructions,
    pages,
    schedules,
    automations,
  };
}
