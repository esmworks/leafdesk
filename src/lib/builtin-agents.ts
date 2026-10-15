// Client-safe: the settings' wizard uses the constants; the server builds the agents.
import type { PropertyType } from "@/db/schema/app";
import { MAX_AGENT_INSTRUCTIONS } from "./agents";

/**
 * Built-in agents: a few ready-made agents for a database. Most are started by an automation when a
 * row is added; the wins logger by a trigger on a connection's events, adding a row for each one
 * that is a win. Picking one (Settings > Agents > Start from a template) creates an ordinary agent
 * with instructions filled in with the database's own property and option names, and the
 * automation or trigger that runs it (see server/agents/builtin.ts `installBuiltinAgent`). The
 * structure is here; the texts, instructions included, are in
 * `i18n/messages/<locale>/agentTemplates.json`, so an agent speaks the language of whoever set it up.
 */

export const BUILTIN_AGENT_KEYS = ["ticket-router", "request-answerer", "duplicate-finder", "wins-logger"] as const;
export type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number];

export const isBuiltinAgentKey = (value: unknown): value is BuiltinAgentKey =>
  typeof value === "string" && (BUILTIN_AGENT_KEYS as readonly string[]).includes(value);

export const BUILTIN_AGENT_ICONS: Record<BuiltinAgentKey, string> = {
  "ticket-router": "🧭",
  "request-answerer": "💬",
  "duplicate-finder": "🔁",
  "wins-logger": "🏆",
};

/** Agents a connection's events start (through a trigger) rather than an automation on new rows. */
export const EVENT_AGENT_KEYS = ["wins-logger"] as const satisfies readonly BuiltinAgentKey[];
export const isEventAgentKey = (key: BuiltinAgentKey): key is (typeof EVENT_AGENT_KEYS)[number] =>
  (EVENT_AGENT_KEYS as readonly string[]).includes(key);

/** Properties the ticket router may set: one value from a known list, or a person. */
export const ROUTER_PROPERTY_TYPES = ["select", "status", "person"] as const satisfies PropertyType[];
/** The property the request answerer marks answered or not. */
export const ANSWER_PROPERTY_TYPES = ["select", "status"] as const satisfies PropertyType[];
/** The property the duplicate finder ticks. */
export const FLAG_PROPERTY_TYPES = ["checkbox"] as const satisfies PropertyType[];

export const MAX_ROUTER_PROPERTIES = 5;
export const MAX_ROUTER_RULES = 4_000;
export const MAX_KNOWLEDGE_PAGES = 20;
/** The most of a log's properties the wins logger's instructions describe, in the database's order. */
export const MAX_LOG_PROPERTIES = 12;
/** Properties the wins logger fills, as far as the event says; others are left alone. */
export const LOG_PROPERTY_TYPES = ["select", "multi_select", "status", "date", "url", "person", "text", "number", "email"] as const satisfies PropertyType[];

/** In place of a property or option id: create the template's own (with its name in the language). */
export const NEW_PROPERTY = "new";

/**
 * What the wizard chose. Properties and options are ids of the database's own, or NEW_PROPERTY;
 * `pages` are the pages the answerer may read (shared with it to view). The wins logger's events
 * come from `connectionId`, of `eventType` (null or empty for any), its trigger `trusted` or not
 * (see lib/connections ConnectionTriggerView). `name` replaces the template's name when given.
 */
export type BuiltinAgentSetup = { databaseId: string; name?: string } & (
  | { key: "ticket-router"; properties: string[]; rules: string }
  | { key: "request-answerer"; property: string; answered: string; needsPerson: string; pages: string[] }
  | { key: "duplicate-finder"; property: string }
  | { key: "wins-logger"; connectionId: string; eventType?: string | null; trusted?: boolean }
);

/** The texts of one language (server/agents/builtin.ts `builtinAgentTexts` loads them). */
export type BuiltinAgentTexts = typeof import("@/i18n/messages/en/agentTemplates.json");

/** The names a new property (and its options) of a template gets, in the texts' language. */
export function newPropertyNames(texts: BuiltinAgentTexts, key: Exclude<BuiltinAgentKey, (typeof EVENT_AGENT_KEYS)[number]>) {
  if (key === "ticket-router") {
    const t = texts["ticket-router"];
    return { name: t.newProperty, type: "select" as const, options: Object.values(t.newOptions) };
  }
  if (key === "request-answerer") {
    const t = texts["request-answerer"];
    return { name: t.newProperty, type: "select" as const, options: [t.newAnswered, t.newNeedsPerson] };
  }
  return { name: texts["duplicate-finder"].newProperty, type: "checkbox" as const, options: [] };
}

/**
 * A template as the gallery lists it, with the property its setup offers to create (none for the
 * wins logger, which fills the log's own).
 */
export type BuiltinAgentSummary = {
  key: BuiltinAgentKey;
  icon: string;
  name: string;
  description: string;
  newProperty: ReturnType<typeof newPropertyNames> | null;
};

export function builtinAgentGallery(texts: BuiltinAgentTexts): BuiltinAgentSummary[] {
  return BUILTIN_AGENT_KEYS.map((key) => ({
    key,
    icon: BUILTIN_AGENT_ICONS[key],
    name: texts[key].name,
    description: texts[key].description,
    newProperty: isEventAgentKey(key) ? null : newPropertyNames(texts, key),
  }));
}

/** One property the ticket router sets, with the values it may choose from (none for people). */
export type RouterProperty = { name: string; type: (typeof ROUTER_PROPERTY_TYPES)[number]; options: string[] };

/** One property of the wins log, with its options when it has a list of them. */
export type LogProperty = { name: string; type: (typeof LOG_PROPERTY_TYPES)[number]; options: string[] };

/** The names that go into an agent's texts, once the wizard's choices are resolved. */
export type BuiltinAgentNames = { database: string } & (
  | { key: "ticket-router"; properties: RouterProperty[]; rules: string }
  | { key: "request-answerer"; property: string; answered: string; needsPerson: string; pages: string[] }
  | { key: "duplicate-finder"; property: string }
  | { key: "wins-logger"; databaseId: string; properties: LogProperty[]; connection: string }
);

/** `{name}` placeholders filled in one pass, so a value that has braces of its own stays as it is. */
export function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? values[name] : match));
}

/**
 * The agent a template makes for a database: its name, icon, description and instructions, the
 * task its automation gives it, and the automation's name.
 */
export function buildBuiltinAgent(texts: BuiltinAgentTexts, names: BuiltinAgentNames) {
  const quote = (value: string) => fill(texts.quoted, { value });
  const database = names.database.trim() || texts.untitled;
  const t = texts[names.key];
  let instructions: string;
  if (names.key === "ticket-router") {
    const router = texts["ticket-router"];
    const lines = names.properties.map((p) =>
      p.type === "person"
        ? fill(router.personLine, { property: quote(p.name) })
        : fill(router.optionsLine, { property: quote(p.name), options: p.options.map(quote).join(", ") }),
    );
    instructions = fill(router.instructions, { database: quote(database), properties: lines.join("\n"), rules: names.rules.trim() });
  } else if (names.key === "request-answerer") {
    const answerer = texts["request-answerer"];
    const pages = names.pages.map((title) => fill(answerer.pageLine, { page: quote(title.trim() || texts.untitled) }));
    instructions = fill(answerer.instructions, {
      database: quote(database),
      pages: pages.join("\n"),
      property: quote(names.property),
      answered: quote(names.answered),
      needsPerson: quote(names.needsPerson),
    });
  } else if (names.key === "wins-logger") {
    const logger = texts["wins-logger"];
    const lines = names.properties.map((p) => {
      const property = quote(p.name);
      if (p.options.length) return fill(logger.optionsLine, { property, options: p.options.map(quote).join(", ") });
      if (p.type === "date") return fill(logger.dateLine, { property });
      if (p.type === "url") return fill(logger.urlLine, { property });
      if (p.type === "person") return fill(logger.personLine, { property });
      return fill(logger.otherLine, { property });
    });
    const write = () =>
      fill(logger.instructions, {
        database: quote(database),
        databaseId: names.databaseId,
        connection: quote(names.connection.trim() || texts.untitled),
        properties: lines.join("\n"),
      });
    // A log with many long options: the last properties are left out rather than the agent refused.
    instructions = write();
    while (instructions.length > MAX_AGENT_INSTRUCTIONS && lines.length) {
      lines.pop();
      instructions = write();
    }
  } else {
    instructions = fill(texts["duplicate-finder"].instructions, { database: quote(database), property: quote(names.property) });
  }
  return {
    name: t.name,
    icon: BUILTIN_AGENT_ICONS[names.key],
    description: t.description,
    instructions,
    task: t.task,
    /** The name of the automation that runs it; null for agents a trigger runs. */
    automation: "automation" in t ? (agent: string) => fill(t.automation, { agent }) : null,
  };
}
