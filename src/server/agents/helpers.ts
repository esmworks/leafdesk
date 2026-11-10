/**
 * An agent's "Agents it can ask": other agents of its workspace its runs may hand part of a task to
 * (server/agents/handoff.ts), as `helpersMode` says (none, the ones ticked here, or all; worked out
 * on each run by team.ts `askableAgents`), and its manager ("Reports to"). Those who can edit the
 * agent choose them with its other settings (createAgent and updateAgent in manage.ts), from the
 * agents shared with them; archiving an agent takes it off every list (archiveAgent).
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agentHelper, workspaceAgent } from "@/db/schema";
import { MAX_AGENT_HELPERS } from "@/lib/agents";
import { reportingProblem, type AgentHelpersMode } from "@/lib/agent-team";
import { agentLevels, agentWithLevel, requireAgentCreator } from "./sharing";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The agents each of these agents may ask, in the order they were chosen. */
export async function helperIdsOf(agentIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(agentIds.map((id) => [id, []]));
  if (!agentIds.length) return map;
  const rows = await db
    .select({ agentId: agentHelper.agentId, helperId: agentHelper.helperId })
    .from(agentHelper)
    .where(inArray(agentHelper.agentId, agentIds))
    .orderBy(asc(agentHelper.createdAt), asc(agentHelper.helperId));
  for (const row of rows) map.get(row.agentId)?.push(row.helperId);
  return map;
}

/**
 * `value` as a list of helpers for an agent of the workspace (`agentId` null: one being created):
 * each another agent of the workspace, not archived, once; at most MAX_AGENT_HELPERS. Null when it
 * isn't one.
 */
export async function checkHelperIds(workspaceId: string, agentId: string | null, value: unknown): Promise<string[] | null> {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return null;
  const ids = [...new Set(value as string[])];
  if (ids.length > MAX_AGENT_HELPERS || (agentId && ids.includes(agentId))) return null;
  if (!ids.length) return [];
  const found = await db
    .select({ id: workspaceAgent.id })
    .from(workspaceAgent)
    .where(and(inArray(workspaceAgent.id, ids), eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)));
  return found.length === ids.length ? ids : null;
}

/** Replaces the agent's helpers, keeping when the ones it keeps were chosen (their order). */
export async function saveHelpers(tx: Tx, agentId: string, ids: string[]) {
  const before = (await tx.select({ helperId: agentHelper.helperId }).from(agentHelper).where(eq(agentHelper.agentId, agentId))).map((r) => r.helperId);
  const gone = before.filter((id) => !ids.includes(id));
  if (gone.length) await tx.delete(agentHelper).where(and(eq(agentHelper.agentId, agentId), inArray(agentHelper.helperId, gone)));
  const added = ids.filter((id) => !before.includes(id));
  // One after another, so the list keeps the order they were given in.
  const now = Date.now();
  if (added.length) await tx.insert(agentHelper).values(added.map((helperId, i) => ({ agentId, helperId, createdAt: new Date(now + i) })));
}

/** Takes an agent off every other agent's list (it was archived). */
export const dropHelper = (tx: Tx, agentId: string) => tx.delete(agentHelper).where(eq(agentHelper.helperId, agentId));

export type HelperChoice = { id: string; name: string; icon: string | null; enabled: boolean };

/** What the agent's "Agents it can ask" and "Reports to" settings show. */
export type HelperChoices = {
  /** The agents it may be given to ask, one by one. */
  agents: HelperChoice[];
  /** Those it asks now, with mode "chosen". */
  selected: string[];
  mode: AgentHelpersMode;
  /** The agents it may report to: no loop, and shared with the viewer (or its manager now). */
  managers: HelperChoice[];
  reportsTo: string | null;
  viaManagerOnly: boolean;
  /** The agents that report to it now. */
  team: HelperChoice[];
};

/**
 * What someone may choose from for an agent's "Agents it can ask" and "Reports to" (`agentId` null:
 * a new agent, for those who may create one): the workspace's other agents that aren't archived and
 * are shared with them, and those the agent has now (shared with them or not); as managers, only
 * those that wouldn't make a loop.
 */
export async function helperChoices(userId: string, workspaceId: string, agentId: string | null): Promise<HelperChoices> {
  let current: typeof workspaceAgent.$inferSelect | null = null;
  if (agentId) {
    const { agent } = await agentWithLevel(userId, agentId, "interact");
    if (agent.workspaceId !== workspaceId) return { agents: [], selected: [], mode: "none", managers: [], reportsTo: null, viaManagerOnly: false, team: [] };
    current = agent;
  } else await requireAgentCreator(userId, workspaceId);
  const all = await db
    .select({ id: workspaceAgent.id, name: workspaceAgent.name, icon: workspaceAgent.icon, enabled: workspaceAgent.enabled, reportsTo: workspaceAgent.reportsTo })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)))
    .orderBy(asc(workspaceAgent.createdAt));
  const selected = agentId ? ((await helperIdsOf([agentId])).get(agentId) ?? []) : [];
  const levels = await agentLevels(userId, workspaceId, all.map((a) => a.id));
  const choice = ({ id, name, icon, enabled }: (typeof all)[number]): HelperChoice => ({ id, name, icon, enabled });
  const agents = all.filter((a) => a.id !== agentId && (levels.get(a.id) !== "none" || selected.includes(a.id))).map(choice);
  const chain = new Map(all.map((a) => [a.id, a.reportsTo]));
  const reportsTo = current?.reportsTo ?? null;
  const managers = all
    .filter((a) => a.id !== agentId && (levels.get(a.id) !== "none" || a.id === reportsTo) && !reportingProblem(agentId ?? "", a.id, chain))
    .map(choice);
  return {
    agents,
    selected,
    mode: current?.helpersMode ?? "none",
    managers,
    reportsTo,
    viaManagerOnly: Boolean(current?.viaManagerOnly && reportsTo),
    team: agentId ? all.filter((a) => a.reportsTo === agentId).map(choice) : [],
  };
}
