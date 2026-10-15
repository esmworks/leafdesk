/**
 * Built-in agents (see lib/builtin-agents.ts): sets one up on a database in a single step. Checks
 * everything first (the database, the properties and options chosen, the pages to read, the
 * connection), then creates what is missing (a property, an option), the agent with its
 * instructions in the owner's language, shares the pages it reads with it (view), and adds the
 * automation that runs it on every new row, which shares the database with it (edit). The wins
 * logger gets the database shared (edit) and a trigger on the connection instead: untrusted unless
 * the owner says otherwise, so each row it adds from an event waits for an owner's approval.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { connection, connectionTrigger, databaseAutomation, workspaceAgent } from "@/db/schema";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { loadLocaleFile, withFallback } from "@/i18n/messages";
import source from "@/i18n/messages/en/agentTemplates.json";
import { MAX_AGENTS, type AgentView } from "@/lib/agents";
import { MAX_AUTOMATIONS } from "@/lib/automations";
import { MAX_CONNECTION_TRIGGERS, MAX_TRIGGER_EVENT } from "@/lib/connections";
import {
  ANSWER_PROPERTY_TYPES,
  buildBuiltinAgent,
  builtinAgentGallery,
  FLAG_PROPERTY_TYPES,
  isBuiltinAgentKey,
  isEventAgentKey,
  LOG_PROPERTY_TYPES,
  MAX_KNOWLEDGE_PAGES,
  MAX_LOG_PROPERTIES,
  MAX_ROUTER_PROPERTIES,
  MAX_ROUTER_RULES,
  NEW_PROPERTY,
  newPropertyNames,
  ROUTER_PROPERTY_TYPES,
  type BuiltinAgentKey,
  type BuiltinAgentNames,
  type BuiltinAgentSetup,
  type BuiltinAgentTexts,
  type LogProperty,
  type RouterProperty,
} from "@/lib/builtin-agents";
import { PropertyValueError } from "@/lib/properties";
import { pageAccessOf, requireMembership } from "@/server/access";
import { AgentError, archiveAgent, createAgent, setAgentAccess } from "@/server/agents/manage";
import { createAutomation } from "@/server/automations/manage";
import { ConnectionError, createTrigger } from "@/server/connections/manage";
import { addProperty, ensureOption, getProperties, requireDatabase } from "@/server/databases";

/** The texts in the given UI language; English for any other, and for texts a language lacks. */
export async function builtinAgentTexts(locale: string | undefined): Promise<BuiltinAgentTexts> {
  if (!isLocale(locale) || locale === DEFAULT_LOCALE) return source;
  return withFallback(source, await loadLocaleFile(locale, "agentTemplates"));
}

export async function builtinAgents(locale: string | undefined) {
  return builtinAgentGallery(await builtinAgentTexts(locale));
}

type Property = Awaited<ReturnType<typeof getProperties>>[number];

const invalid = (reason: string, message: string) => new AgentError("invalid", message, { reason });

const optionsOf = (prop: Property) => prop.options.options ?? [];

/** An existing property of the database of one of `types`, or NEW_PROPERTY. */
function pick(properties: Property[], ref: unknown, types: readonly string[]): Property | typeof NEW_PROPERTY {
  if (ref === NEW_PROPERTY) return NEW_PROPERTY;
  const found = properties.find((p) => p.id === ref);
  if (!found || !types.includes(found.type)) throw invalid("property", "Choose a property of the right type");
  return found;
}

/** An option of `prop`, or NEW_PROPERTY to add the template's own. */
function pickOption(prop: Property, ref: unknown) {
  if (ref === NEW_PROPERTY) return NEW_PROPERTY;
  const found = optionsOf(prop).find((o) => o.id === ref);
  if (!found) throw invalid("option", "Choose an option of the property");
  return found.name;
}

/** `name`, or `name 2`, `name 3`… when the database has a property called that. */
function freeName(properties: Property[], name: string) {
  const taken = new Set(properties.map((p) => p.name.trim().toLowerCase()));
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${name} ${i}`;
  return candidate;
}

/** Adds the template's own property to the database, named in the texts' language. */
async function addOwnProperty(
  userId: string,
  databaseId: string,
  properties: Property[],
  texts: BuiltinAgentTexts,
  key: Exclude<BuiltinAgentKey, "wins-logger">,
) {
  const own = newPropertyNames(texts, key);
  const created = await addProperty(userId, databaseId, { name: freeName(properties, own.name), type: own.type, options: own.options });
  return created as Property;
}

/** The properties of a log the wins logger fills, as its instructions list them. */
function logProperties(properties: Property[]): LogProperty[] {
  return properties
    .filter((p) => (LOG_PROPERTY_TYPES as readonly string[]).includes(p.type))
    .slice(0, MAX_LOG_PROPERTIES)
    .map((p) => ({ name: p.name, type: p.type as LogProperty["type"], options: optionsOf(p).map((o) => o.name) }));
}

/**
 * Sets up a built-in agent on a database (owners, with full access to the database). Returns the
 * agent and the automation that runs it, or for the wins logger the connection's trigger.
 */
export async function installBuiltinAgent(
  userId: string,
  workspaceId: string,
  setup: BuiltinAgentSetup,
  { locale }: { locale?: string } = {},
): Promise<{ agent: AgentView; automationId: string | null; triggerId: string | null }> {
  await requireMembership(userId, workspaceId, "owner");
  if (!setup || !isBuiltinAgentKey(setup.key)) throw invalid("template", "Unknown built-in agent");
  const database = await requireDatabase(userId, String(setup.databaseId ?? ""), "full");
  if (database.workspaceId !== workspaceId) throw invalid("database", "The database is in another workspace");
  const databaseId = database.id;
  if (!isEventAgentKey(setup.key)) {
    const [{ n }] = await db.select({ n: count() }).from(databaseAutomation).where(eq(databaseAutomation.databaseId, databaseId));
    if (n >= MAX_AUTOMATIONS) {
      throw new PropertyValueError(`A database has at most ${MAX_AUTOMATIONS} automations`, "tooManyAutomations", { max: String(MAX_AUTOMATIONS) });
    }
  }
  const texts = await builtinAgentTexts(locale);
  const properties = await getProperties(databaseId);

  // Everything is checked before anything is made.
  let names: BuiltinAgentNames;
  const pages: { id: string; title: string }[] = [];
  let create: () => Promise<void> = async () => {};
  let trigger: { connectionId: string; eventType: string | null; trusted: boolean } | null = null;
  if (setup.key === "wins-logger") {
    const [conn] = await db
      .select({ id: connection.id, name: connection.name })
      .from(connection)
      .where(and(eq(connection.id, String(setup.connectionId ?? "")), eq(connection.workspaceId, workspaceId)));
    if (!conn) throw new ConnectionError("notFound", "Connection not found");
    const [{ triggers }] = await db.select({ triggers: count() }).from(connectionTrigger).where(eq(connectionTrigger.connectionId, conn.id));
    if (triggers >= MAX_CONNECTION_TRIGGERS) {
      throw new ConnectionError("tooMany", `A connection has at most ${MAX_CONNECTION_TRIGGERS} triggers`, { max: String(MAX_CONNECTION_TRIGGERS) });
    }
    const eventType = typeof setup.eventType === "string" ? setup.eventType.trim().slice(0, MAX_TRIGGER_EVENT) : "";
    trigger = { connectionId: conn.id, eventType: eventType || null, trusted: setup.trusted === true };
    names = { key: "wins-logger", database: database.title, databaseId, properties: logProperties(properties), connection: conn.name };
  } else if (setup.key === "ticket-router") {
    const refs = Array.isArray(setup.properties) ? [...new Set(setup.properties)] : [];
    if (!refs.length || refs.length > MAX_ROUTER_PROPERTIES) throw invalid("property", `Choose 1 to ${MAX_ROUTER_PROPERTIES} properties`);
    const picked = refs.map((ref) => pick(properties, ref, ROUTER_PROPERTY_TYPES));
    if (picked.some((p) => p !== NEW_PROPERTY && p.type !== "person" && !optionsOf(p).length)) {
      throw invalid("property", "A select or status property to set needs options");
    }
    const rules = typeof setup.rules === "string" ? setup.rules.trim() : "";
    if (!rules || rules.length > MAX_ROUTER_RULES) throw invalid("rules", `Write the rules (at most ${MAX_ROUTER_RULES} characters)`);
    const chosen: RouterProperty[] = [];
    create = async () => {
      for (const p of picked) {
        const prop = p === NEW_PROPERTY ? await addOwnProperty(userId, databaseId, properties, texts, setup.key) : p;
        chosen.push({ name: prop.name, type: prop.type as RouterProperty["type"], options: optionsOf(prop).map((o) => o.name) });
      }
    };
    names = { key: "ticket-router", database: database.title, properties: chosen, rules };
  } else if (setup.key === "request-answerer") {
    const picked = pick(properties, setup.property, ANSWER_PROPERTY_TYPES);
    const answered = picked === NEW_PROPERTY ? NEW_PROPERTY : pickOption(picked, setup.answered);
    const needsPerson = picked === NEW_PROPERTY ? NEW_PROPERTY : pickOption(picked, setup.needsPerson);
    if (answered !== NEW_PROPERTY && answered === needsPerson) throw invalid("option", "Choose two different options");
    const refs = Array.isArray(setup.pages) ? [...new Set(setup.pages.map(String))] : [];
    if (!refs.length || refs.length > MAX_KNOWLEDGE_PAGES) throw invalid("pages", `Choose 1 to ${MAX_KNOWLEDGE_PAGES} pages`);
    for (const ref of refs) {
      const { page: found, level } = await pageAccessOf(userId, ref);
      // Sharing a page with the agent takes full access to it, as with anyone.
      if (!found || found.workspaceId !== workspaceId || found.archivedAt || level !== "full") throw new AgentError("notAPage", "Page not found");
      pages.push({ id: found.id, title: found.title });
    }
    const own = newPropertyNames(texts, "request-answerer");
    const resolved = { key: "request-answerer" as const, database: database.title, property: "", answered: "", needsPerson: "", pages: pages.map((p) => p.title) };
    create = async () => {
      if (picked === NEW_PROPERTY) {
        const prop = await addOwnProperty(userId, databaseId, properties, texts, setup.key);
        Object.assign(resolved, { property: prop.name, answered: own.options[0], needsPerson: own.options[1] });
        return;
      }
      const option = async (value: string, fallback: string) =>
        value === NEW_PROPERTY ? (await ensureOption(userId, picked.id, fallback)).name : value;
      Object.assign(resolved, {
        property: picked.name,
        answered: await option(answered, own.options[0]),
        needsPerson: await option(needsPerson, own.options[1]),
      });
    };
    names = resolved;
  } else {
    const picked = pick(properties, setup.property, FLAG_PROPERTY_TYPES);
    const resolved = { key: "duplicate-finder" as const, database: database.title, property: picked === NEW_PROPERTY ? "" : picked.name };
    create = async () => {
      if (picked === NEW_PROPERTY) resolved.property = (await addOwnProperty(userId, databaseId, properties, texts, setup.key)).name;
    };
    names = resolved;
  }

  // Room for one more agent, before anything is made (createAgent checks it again).
  const [{ agents }] = await db
    .select({ agents: count() })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)));
  if (agents >= MAX_AGENTS) throw new AgentError("tooMany", `A workspace has at most ${MAX_AGENTS} agents`, { max: String(MAX_AGENTS) });

  await create();
  const built = buildBuiltinAgent(texts, names);
  const name = typeof setup.name === "string" && setup.name.trim() ? setup.name : built.name;
  const agent = await createAgent(userId, workspaceId, { name, icon: built.icon, description: built.description, instructions: built.instructions });
  try {
    for (const page of pages) await setAgentAccess(userId, agent.id, page.id, "view");
    if (trigger) {
      // It adds rows to the log; a trigger shares nothing by itself.
      await setAgentAccess(userId, agent.id, databaseId, "edit");
      const created = await createTrigger(userId, trigger.connectionId, { agentId: agent.id, eventType: trigger.eventType, prompt: built.task, trusted: trigger.trusted });
      return { agent, automationId: null, triggerId: created.id };
    }
    const automation = await createAutomation(userId, databaseId, {
      name: built.automation!(agent.name),
      trigger: { type: "row_created" },
      actions: [{ type: "run_agent", agent: agent.id, prompt: built.task }],
    });
    return { agent, automationId: automation.id, triggerId: null };
  } catch (error) {
    // No half-made agent left running: it's archived, which also takes back what was shared.
    await archiveAgent(userId, agent.id).catch(() => {});
    throw error;
  }
}
