// Client-safe: the settings' wizard uses the constants; the server builds the agents.
import type { PropertyType } from "@/db/schema/app";

/**
 * Built-in agents: a few ready-made agents for a database, each started by an automation when a
 * row is added. Picking one (Settings > Agents > Start from a template) creates an ordinary agent
 * with instructions filled in with the database's own property and option names, and the
 * automation that runs it (see server/agents/builtin.ts `installBuiltinAgent`). The structure is
 * here; the texts, instructions included, are in `i18n/messages/<locale>/agentTemplates.json`, so
 * an agent speaks the language of whoever set it up.
 */

export const BUILTIN_AGENT_KEYS = ["ticket-router", "request-answerer", "duplicate-finder"] as const;
export type BuiltinAgentKey = (typeof BUILTIN_AGENT_KEYS)[number];

export const isBuiltinAgentKey = (value: unknown): value is BuiltinAgentKey =>
  typeof value === "string" && (BUILTIN_AGENT_KEYS as readonly string[]).includes(value);

export const BUILTIN_AGENT_ICONS: Record<BuiltinAgentKey, string> = {
  "ticket-router": "🧭",
  "request-answerer": "💬",
  "duplicate-finder": "🔁",
};

/** Properties the ticket router may set: one value from a known list, or a person. */
export const ROUTER_PROPERTY_TYPES = ["select", "status", "person"] as const satisfies PropertyType[];
/** The property the request answerer marks answered or not. */
export const ANSWER_PROPERTY_TYPES = ["select", "status"] as const satisfies PropertyType[];
/** The property the duplicate finder ticks. */
export const FLAG_PROPERTY_TYPES = ["checkbox"] as const satisfies PropertyType[];

export const MAX_ROUTER_PROPERTIES = 5;
export const MAX_ROUTER_RULES = 4_000;
export const MAX_KNOWLEDGE_PAGES = 20;

/** In place of a property or option id: create the template's own (with its name in the language). */
export const NEW_PROPERTY = "new";

/**
 * What the wizard chose. Properties and options are ids of the database's own, or NEW_PROPERTY;
 * `pages` are the pages the answerer may read (shared with it to view). `name` replaces the
 * template's name when given.
 */
export type BuiltinAgentSetup = { databaseId: string; name?: string } & (
  | { key: "ticket-router"; properties: string[]; rules: string }
  | { key: "request-answerer"; property: string; answered: string; needsPerson: string; pages: string[] }
  | { key: "duplicate-finder"; property: string }
);

/** The texts of one language (server/agents/builtin.ts `builtinAgentTexts` loads them). */
export type BuiltinAgentTexts = typeof import("@/i18n/messages/en/agentTemplates.json");

/** The names a new property (and its options) of a template gets, in the texts' language. */
export function newPropertyNames(texts: BuiltinAgentTexts, key: BuiltinAgentKey) {
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

/** A template as the gallery lists it, with the property its setup offers to create. */
export type BuiltinAgentSummary = {
  key: BuiltinAgentKey;
  icon: string;
  name: string;
  description: string;
  newProperty: ReturnType<typeof newPropertyNames>;
};

export function builtinAgentGallery(texts: BuiltinAgentTexts): BuiltinAgentSummary[] {
  return BUILTIN_AGENT_KEYS.map((key) => ({
    key,
    icon: BUILTIN_AGENT_ICONS[key],
    name: texts[key].name,
    description: texts[key].description,
    newProperty: newPropertyNames(texts, key),
  }));
}

/** One property the ticket router sets, with the values it may choose from (none for people). */
export type RouterProperty = { name: string; type: (typeof ROUTER_PROPERTY_TYPES)[number]; options: string[] };

/** The names that go into an agent's texts, once the wizard's choices are resolved. */
export type BuiltinAgentNames = { database: string } & (
  | { key: "ticket-router"; properties: RouterProperty[]; rules: string }
  | { key: "request-answerer"; property: string; answered: string; needsPerson: string; pages: string[] }
  | { key: "duplicate-finder"; property: string }
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
  } else {
    instructions = fill(texts["duplicate-finder"].instructions, { database: quote(database), property: quote(names.property) });
  }
  return {
    name: t.name,
    icon: BUILTIN_AGENT_ICONS[names.key],
    description: t.description,
    instructions,
    task: t.task,
    automation: (agent: string) => fill(t.automation, { agent }),
  };
}
