// Client-safe: the settings' wizard uses the constants; the server builds the agents.
import type { PropertyType } from "@/db/schema/app";
import { MAX_AGENT_INSTRUCTIONS } from "./agents";

/**
 * Built-in agents: a few ready-made agents for a database. Most are started by an automation when a
 * row is added; the wins logger by a trigger on a connection's events, adding a row for each one
 * that is a win. The company researcher looks each new row's company up on the web (it gets web
 * access) and fills the row's empty properties. Picking one (Settings > Agents > Start from a template) creates an ordinary agent
 * with instructions filled in with the database's own property and option names, and the
 * automation or trigger that runs it (see server/agents/builtin.ts `installBuiltinAgent`). The
 * structure is here; the texts, instructions included, are in
 * `i18n/messages/<locale>/agentTemplates.json`, so an agent speaks the language of whoever set it up.
 */

export const BUILTIN_AGENT_KEYS = ["ticket-router", "request-answerer", "duplicate-finder", "wins-logger", "company-details"] as const;
export type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number];

export const isBuiltinAgentKey = (value: unknown): value is BuiltinAgentKey =>
  typeof value === "string" && (BUILTIN_AGENT_KEYS as readonly string[]).includes(value);

export const BUILTIN_AGENT_ICONS: Record<BuiltinAgentKey, string> = {
  "ticket-router": "🧭",
  "request-answerer": "💬",
  "duplicate-finder": "🔁",
  "wins-logger": "🏆",
  "company-details": "🏢",
};

/** Agents a connection's events start (through a trigger) rather than an automation on new rows. */
export const EVENT_AGENT_KEYS = ["wins-logger"] as const satisfies readonly BuiltinAgentKey[];
export type EventAgentKey = (typeof EVENT_AGENT_KEYS)[number];
export const isEventAgentKey = (key: BuiltinAgentKey): key is EventAgentKey =>
  (EVENT_AGENT_KEYS as readonly string[]).includes(key);

/** Agents that fill the database's own properties and bring none of their own. */
export const FILLING_AGENT_KEYS = ["wins-logger", "company-details"] as const satisfies readonly BuiltinAgentKey[];
/** Agents whose setup offers to create a property of their own (see `newPropertyNames`). */
export type OwnPropertyKey = Exclude<BuiltinAgentKey, (typeof FILLING_AGENT_KEYS)[number]>;
export const bringsOwnProperty = (key: BuiltinAgentKey): key is OwnPropertyKey => !(FILLING_AGENT_KEYS as readonly string[]).includes(key);

/** Properties the ticket router may set: one value from a known list, or a person. */
export const ROUTER_PROPERTY_TYPES = ["select", "status", "person"] as const satisfies PropertyType[];
/** The property the request answerer marks answered or not. */
export const ANSWER_PROPERTY_TYPES = ["select", "status"] as const satisfies PropertyType[];
/** The property the duplicate finder ticks. */
export const FLAG_PROPERTY_TYPES = ["checkbox"] as const satisfies PropertyType[];

export const MAX_ROUTER_PROPERTIES = 5;
export const MAX_ROUTER_RULES = 4_000;
export const MAX_KNOWLEDGE_PAGES = 20;
/** The most of a log's properties the wins logger's instructions describe (see `logPropertiesOf`). */
export const MAX_LOG_PROPERTIES = 12;
/** Properties the wins logger fills, as far as the event says; others are left alone. */
export const LOG_PROPERTY_TYPES = ["select", "multi_select", "status", "date", "url", "person", "text", "number", "email"] as const satisfies PropertyType[];
/** Properties the company researcher may fill: what a company's own site or a register says. */
export const COMPANY_PROPERTY_TYPES = ["text", "url", "email", "phone", "number", "select", "multi_select"] as const satisfies PropertyType[];
/** The most properties one company researcher fills. */
export const MAX_COMPANY_PROPERTIES = 15;

/**
 * Whether the company researcher may fill a property: one of its types, not one AI autofill
 * already fills, and for a list, one with options to choose from.
 */
export function isCompanyProperty(p: { type: string; options: readonly unknown[]; ai?: boolean }) {
  if (!(COMPANY_PROPERTY_TYPES as readonly string[]).includes(p.type) || p.ai) return false;
  return p.options.length > 0 || (p.type !== "select" && p.type !== "multi_select");
}

/** In place of a property or option id: create the template's own (with its name in the language). */
export const NEW_PROPERTY = "new";

/**
 * What the wizard chose. Properties and options are ids of the database's own, or NEW_PROPERTY;
 * `pages` are the pages the answerer may read (shared with it to view). The wins logger's events
 * come from `connectionId`, of `eventType` (null or empty for any); its trigger starts untrusted,
 * and each row it adds waits for an owner either way. The company researcher's `properties` are
 * those it may fill (see `isCompanyProperty`). `name` replaces the template's name when given.
 */
export type BuiltinAgentSetup = { databaseId: string; name?: string } & (
  | { key: "ticket-router"; properties: string[]; rules: string }
  | { key: "request-answerer"; property: string; answered: string; needsPerson: string; pages: string[] }
  | { key: "duplicate-finder"; property: string }
  | { key: "wins-logger"; connectionId: string; eventType?: string | null }
  | { key: "company-details"; properties: string[] }
);

/** The texts of one language (server/agents/builtin.ts `builtinAgentTexts` loads them). */
export type BuiltinAgentTexts = typeof import("@/i18n/messages/en/agentTemplates.json");

/** The names a new property (and its options) of a template gets, in the texts' language. */
export function newPropertyNames(texts: BuiltinAgentTexts, key: OwnPropertyKey) {
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
 * wins logger and the company researcher, which fill the database's own).
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
    newProperty: bringsOwnProperty(key) ? newPropertyNames(texts, key) : null,
  }));
}

/** One property the ticket router sets, with the values it may choose from (none for people). */
export type RouterProperty = { name: string; type: (typeof ROUTER_PROPERTY_TYPES)[number]; options: string[] };

/** One property of the wins log, with its options when it has a list of them. */
export type LogProperty = { name: string; type: (typeof LOG_PROPERTY_TYPES)[number]; options: string[] };

/**
 * One property the company researcher fills, with its options when it is a list, and the
 * description the database gives it (what it holds and how to fill it), if any.
 */
export type CompanyProperty = { name: string; type: (typeof COMPANY_PROPERTY_TYPES)[number]; options: string[]; description: string | null };

/** Fills first: a list to choose from and the day say most about a win; free text least. */
const logRank = (p: LogProperty) => (p.options.length || p.type === "date" ? 0 : p.type === "person" || p.type === "url" ? 1 : 2);

/**
 * The properties of a log the wins logger fills (`fills`, at most MAX_LOG_PROPERTIES, the most
 * telling first, in the database's order within each kind), and the names of those of its types it
 * leaves out (`left`), for the wizard to say so.
 */
export function logPropertiesOf(properties: { name: string; type: string; options: string[] }[]): { fills: LogProperty[]; left: string[] } {
  const fitting = properties
    .filter((p): p is LogProperty => (LOG_PROPERTY_TYPES as readonly string[]).includes(p.type))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => logRank(a.p) - logRank(b.p) || a.i - b.i)
    .map(({ p }) => ({ name: p.name, type: p.type, options: p.options }));
  return { fills: fitting.slice(0, MAX_LOG_PROPERTIES), left: fitting.slice(MAX_LOG_PROPERTIES).map((p) => p.name) };
}

/** The names that go into an agent's texts, once the wizard's choices are resolved. */
export type BuiltinAgentNames = { database: string } & (
  | { key: "ticket-router"; properties: RouterProperty[]; rules: string }
  | { key: "request-answerer"; property: string; answered: string; needsPerson: string; pages: string[] }
  | { key: "duplicate-finder"; property: string }
  | { key: "wins-logger"; databaseId: string; properties: LogProperty[]; connection: string }
  | { key: "company-details"; properties: CompanyProperty[] }
);

/** `{name}` placeholders filled in one pass, so a value that has braces of its own stays as it is. */
export function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? values[name] : match));
}

/**
 * The agent a template makes for a database: its name, icon, description and instructions, the
 * task its automation gives it, the automation's name, and whether it reads the web.
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
  } else if (names.key === "company-details") {
    const researcher = texts["company-details"];
    const lines = names.properties.map((p) => {
      const options = p.options.map(quote).join(", ");
      const line = fill(researcher.line, {
        property: quote(p.name),
        value: p.options.length ? fill(p.type === "multi_select" ? researcher.someOf : researcher.oneOf, { options }) : researcher.values[p.type],
      });
      // A description on one line, so it can't pass for an instruction of its own.
      const description = p.description?.replace(/\s+/g, " ").trim();
      return description ? fill(researcher.describedLine, { line, description }) : line;
    });
    const write = () => fill(researcher.instructions, { database: quote(database), properties: lines.join("\n") });
    // Many properties with long descriptions: the last are left out rather than the agent refused.
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
    webAccess: names.key === "company-details",
  };
}
