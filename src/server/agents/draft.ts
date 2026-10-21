/**
 * Drafting an agent from what an owner says it should do: the AI writes its name, description and
 * instructions, picks the pages and databases it needs (only ones the owner may share, see
 * draftCandidates) at the least access that does the job, and suggests when it runs: schedules,
 * and automations on a database. Nothing is saved: the draft opens the creation dialog, where the
 * owner changes what they like, and creating it (createAgentFromDraft) makes the agent and sets up
 * the shares, schedules and automations they kept.
 *
 * The request counts as the agents' AI usage ("agent.draft") and is held to the workspace's AI
 * limits like any other.
 */
import { isAgentAccessLevel, type AgentView } from "@/lib/agents";
import {
  MAX_AGENT_REQUEST,
  MAX_DRAFT_AUTOMATIONS,
  MAX_DRAFT_PAGES,
  MAX_DRAFT_SCHEDULES,
  readDraftJson,
  validateAgentDraft,
  type AgentDraft,
  type DraftCandidate,
  type DraftTrigger,
} from "@/lib/agent-draft";
import { isTimeZone } from "@/lib/time-zone";
import { requireMembership } from "@/server/access";
import { AiError, complete } from "@/server/ai";
import { agentDraftPrompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { createAutomation, deleteAutomation, type AutomationInput } from "@/server/automations/manage";
import { knownProperties } from "@/server/databases";
import { fullTextSearch, getTree, recentPages } from "@/server/pages";
import { AgentError, archiveAgent, createAgent, setAgentAccess, type AgentInput } from "./manage";
import { removeAgentSchedule, setAgentSchedule } from "./schedules";

/** Pages and databases offered to the AI at most, and databases whose properties it is told. */
const MAX_CANDIDATES = 40;
const MAX_CANDIDATE_DATABASES = 8;
const MAX_CANDIDATE_PROPERTIES = 25;

const firstWords = (text: string, words = 6) => text.trim().split(/\s+/).slice(0, words).join(" ");

/**
 * The pages and databases a draft may share: those of the workspace the owner has full access to
 * (sharing takes it, as with anyone), never rows, templates or archived pages. The ones a search for
 * the description finds come first, then those edited lately, then the top-level ones.
 */
export async function draftCandidates(userId: string, workspaceId: string, description: string): Promise<DraftCandidate[]> {
  const [tree, hits, recent] = await Promise.all([
    getTree(userId, workspaceId),
    // Words only: a semantic search would be another AI request on the workspace's account.
    fullTextSearch(userId, description, { workspaceId, limit: 20, anyWord: true }).catch(() => []),
    recentPages(userId, workspaceId, 20),
  ]);
  const shareable = new Map(tree.filter((n) => n.level === "full" && (n.kind === "page" || n.kind === "database")).map((n) => [n.id, n]));
  const ids = [...new Set([...hits.map((h) => h.id), ...recent.map((r) => r.id), ...tree.filter((n) => !n.parentId).map((n) => n.id)])];
  const picked = ids.flatMap((id) => {
    const node = shareable.get(id);
    return node ? [node] : [];
  }).slice(0, MAX_CANDIDATES);
  const databases = picked.filter((n) => n.kind === "database").slice(0, MAX_CANDIDATE_DATABASES);
  const properties = new Map(
    await Promise.all(
      databases.map(async (d) => {
        const known = await knownProperties(userId, d.id).catch(() => []);
        return [d.id, known.slice(0, MAX_CANDIDATE_PROPERTIES).map((p) => ({ id: p.id, name: p.name, type: p.type }))] as const;
      }),
    ),
  );
  return picked.map((n) => ({
    id: n.id,
    title: n.title,
    icon: n.icon,
    kind: n.kind === "database" ? "database" : "page",
    ...(properties.has(n.id) ? { properties: properties.get(n.id) } : {}),
  }));
}

/**
 * Asks the AI for a draft over `candidates` and checks it (validateAgentDraft). Throws AiError: the
 * AI layer's, and "empty" when the answer holds no agent.
 */
export async function draftAgentWith(request: {
  userId: string;
  workspaceId: string;
  description: string;
  candidates: DraftCandidate[];
  signal?: AbortSignal;
}): Promise<AgentDraft> {
  const prompt = agentDraftPrompt(request.description, request.candidates);
  const result = await complete({
    feature: "agent.draft",
    userId: request.userId,
    workspaceId: request.workspaceId,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.prompt }],
    signal: request.signal,
  });
  const draft = validateAgentDraft(readDraftJson(result.text), request.candidates, firstWords(request.description));
  if (!draft) throw new AiError("empty", "The AI's answer held no agent");
  return draft;
}

/**
 * A draft of an agent doing what `description` says, for an owner of the workspace (those who may
 * create agents). Throws AccessError for anyone else, AiError when the workspace has no AI or the
 * request fails.
 */
export async function draftAgent(userId: string, workspaceId: string, description: string, { signal }: { signal?: AbortSignal } = {}): Promise<AgentDraft> {
  await requireMembership(userId, workspaceId, "owner");
  const text = typeof description === "string" ? description.trim().slice(0, MAX_AGENT_REQUEST) : "";
  if (!text) throw new AiError("invalid", "Describe what the agent should do");
  if (!(await aiAvailable(workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  const candidates = await draftCandidates(userId, workspaceId, text);
  return draftAgentWith({ userId, workspaceId, description: text, candidates, signal });
}

/** A drafted agent as the owner creates it, with what they kept of the draft's suggestions. */
export type DraftedAgentInput = AgentInput & {
  pages?: { pageId: string; level: string }[];
  schedules?: { rule: unknown; task: string; databaseId: string | null }[];
  automations?: { databaseId: string; trigger: DraftTrigger; task: string }[];
  /** The owner's time zone: schedules run and "date passed" automations count days in it. */
  timeZone?: string;
};

const items = <T>(value: T[] | undefined, max: number): T[] => (Array.isArray(value) ? value.slice(0, max) : []);

function triggerInput(trigger: DraftTrigger | undefined): AutomationInput["trigger"] {
  switch (trigger?.type) {
    case "row_created":
      return { type: "row_created" };
    case "property_changed":
      return { type: "property_changed", property: typeof trigger.propertyId === "string" ? trigger.propertyId : null };
    case "date_passed":
      return { type: "date_passed", date: String(trigger.date ?? ""), days: trigger.days };
    default:
      // The automation's own check refuses it.
      return trigger as never;
  }
}

/**
 * Creates an agent from a reviewed draft: the agent, then the pages shared with it, its schedules
 * and the automations that run it (`automationName` names each, from the agent's name). Each step
 * checks as it does on its own (sharing takes full access to the page, an automation full access
 * to its database). When one fails, what was made is taken back (the agent archived) and the
 * error goes to the owner.
 */
export async function createAgentFromDraft(
  userId: string,
  workspaceId: string,
  input: DraftedAgentInput,
  { automationName }: { automationName: (agentName: string) => string },
): Promise<AgentView> {
  const pages = items(input.pages, MAX_DRAFT_PAGES);
  if (pages.some((p) => typeof p?.pageId !== "string" || !isAgentAccessLevel(p.level))) {
    throw new AgentError("invalid", "An agent can view, comment on or edit a page", { reason: "level" });
  }
  const schedules = items(input.schedules, MAX_DRAFT_SCHEDULES);
  const automations = items(input.automations, MAX_DRAFT_AUTOMATIONS);
  const timeZone = isTimeZone(input.timeZone) ? input.timeZone : "UTC";
  const { pages: _p, schedules: _s, automations: _a, timeZone: _t, ...fields } = input;
  const agent = await createAgent(userId, workspaceId, fields);
  const made = { schedules: [] as string[], automations: [] as string[] };
  try {
    for (const p of pages) await setAgentAccess(userId, agent.id, p.pageId, p.level as never);
    for (const s of schedules) {
      const created = await setAgentSchedule(userId, agent.id, null, { rule: s?.rule, timeZone, task: s?.task, databaseId: s?.databaseId ?? null });
      made.schedules.push(created.id);
    }
    for (const a of automations) {
      const created = await createAutomation(userId, String(a?.databaseId ?? ""), {
        name: automationName(agent.name),
        timeZone,
        trigger: triggerInput(a?.trigger),
        actions: [{ type: "run_agent", agent: agent.id, prompt: typeof a?.task === "string" ? a.task : "" }],
      });
      made.automations.push(created.id);
    }
    return agent;
  } catch (error) {
    for (const id of made.automations) await deleteAutomation(userId, id).catch(() => {});
    for (const id of made.schedules) await removeAgentSchedule(userId, agent.id, id).catch(() => {});
    // Archiving also takes back every page shared with it.
    await archiveAgent(userId, agent.id).catch(() => {});
    throw error;
  }
}
