/**
 * Agents working as a team (rules in lib/agent-team.ts): the agents a run may ask (its chosen ones,
 * or all those the person who chose "all" may use, and always the agents that report to it), the
 * check made when an agent is put under a manager, and where a person's chat or mention of an
 * agent working only through its manager goes.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agentHelper, workspaceAgent } from "@/db/schema";
import { MAX_REPORTING_DEPTH, reportingProblem, routeTo } from "@/lib/agent-team";
import { hasAgentLevel, type AgentLevel } from "@/lib/agent-sharing";
import { AgentError } from "./errors";
import { agentLevels } from "./sharing";

type Agent = typeof workspaceAgent.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** An agent another may ask, as the ask_agent tool names it. */
export type AskableAgent = { id: string; name: string; description: string; reportsToAsker: boolean };

/** The live agents that report to this one, by name. */
export async function teamOf(agentId: string, tx: Tx | typeof db = db) {
  return tx
    .select({ id: workspaceAgent.id, name: workspaceAgent.name, icon: workspaceAgent.icon, enabled: workspaceAgent.enabled, viaManagerOnly: workspaceAgent.viaManagerOnly })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.reportsTo, agentId), isNull(workspaceAgent.archivedAt)))
    .orderBy(asc(workspaceAgent.name));
}

/**
 * The agents a run of `agent` may ask, as they are now: those that report to it first, then its
 * chosen ones (in the order they were chosen) or, with "all", the workspace's other live agents
 * that whoever chose "all" may still use (none once they left it). Never itself.
 */
export async function askableAgents(agent: Pick<Agent, "id" | "workspaceId" | "helpersMode" | "helpersSetBy">): Promise<AskableAgent[]> {
  const columns = { id: workspaceAgent.id, name: workspaceAgent.name, description: workspaceAgent.description, reportsTo: workspaceAgent.reportsTo };
  const team = await db
    .select(columns)
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.reportsTo, agent.id), eq(workspaceAgent.workspaceId, agent.workspaceId), isNull(workspaceAgent.archivedAt)))
    .orderBy(asc(workspaceAgent.name));
  let others: typeof team = [];
  if (agent.helpersMode === "chosen") {
    others = await db
      .select(columns)
      .from(agentHelper)
      .innerJoin(workspaceAgent, eq(workspaceAgent.id, agentHelper.helperId))
      .where(and(eq(agentHelper.agentId, agent.id), eq(workspaceAgent.workspaceId, agent.workspaceId), isNull(workspaceAgent.archivedAt)))
      .orderBy(asc(agentHelper.createdAt));
  } else if (agent.helpersMode === "all" && agent.helpersSetBy) {
    const all = await db
      .select(columns)
      .from(workspaceAgent)
      .where(and(eq(workspaceAgent.workspaceId, agent.workspaceId), isNull(workspaceAgent.archivedAt)))
      .orderBy(asc(workspaceAgent.name));
    const levels = await agentLevels(agent.helpersSetBy, agent.workspaceId, all.map((a) => a.id));
    others = all.filter((a) => levels.get(a.id) !== "none");
  }
  const seen = new Set<string>([agent.id]);
  const askable: AskableAgent[] = [];
  for (const a of [...team, ...others]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    askable.push({ id: a.id, name: a.name, description: a.description, reportsToAsker: a.reportsTo === agent.id });
  }
  return askable;
}

/**
 * `value` as the agent's manager, chosen by `userId` (`agentId` null: an agent being created): null,
 * or another live agent of the workspace they may use, that doesn't make a loop or too long a chain.
 * Throws AgentError `invalid` otherwise (reason `manager`, or `managerLoop` for a loop or a chain too long). `kept`: its manager now, which stays
 * even when no longer shared with them.
 */
export async function checkManager(userId: string, workspaceId: string, agentId: string | null, value: unknown, kept: string | null = null): Promise<string | null> {
  if (value === null) return null;
  const invalid = (message: string, reason: "manager" | "managerLoop" = "manager"): never => {
    throw new AgentError("invalid", message, { reason });
  };
  if (typeof value !== "string" || !value) return invalid("An agent reports to another agent of its workspace, or to none");
  const agents = await db
    .select({ id: workspaceAgent.id, reportsTo: workspaceAgent.reportsTo, archivedAt: workspaceAgent.archivedAt })
    .from(workspaceAgent)
    .where(eq(workspaceAgent.workspaceId, workspaceId));
  const manager = agents.find((a) => a.id === value);
  if (!manager || manager.archivedAt) return invalid("An agent reports to another agent of its workspace that isn't archived");
  if (value !== kept) {
    const levels = await agentLevels(userId, workspaceId, [value]);
    if (levels.get(value) === "none") return invalid("An agent may report only to an agent shared with you");
  }
  const chain = new Map(agents.filter((a) => !a.archivedAt).map((a) => [a.id, a.reportsTo]));
  const problem = reportingProblem(agentId ?? "", value, chain);
  if (problem === "self") return invalid("An agent can't report to itself", "managerLoop");
  if (problem === "loop") return invalid("That agent reports to this one already, directly or through others", "managerLoop");
  if (problem === "tooDeep") return invalid(`A chain of managers has at most ${MAX_REPORTING_DEPTH} links`, "managerLoop");
  return value;
}

/** The agents that report to `agentId` report to no one any more (it was archived). */
export const leaveManager = (tx: Tx, agentId: string) =>
  tx.update(workspaceAgent).set({ reportsTo: null, viaManagerOnly: false }).where(eq(workspaceAgent.reportsTo, agentId));

/**
 * Where `userId`'s messages for each of these agents go (see lib/agent-team.ts routeTo): the agent
 * itself, its manager (live, and shared with them), or nowhere (null). `levels` are the person's
 * on the agents asked about; the managers' are looked up here.
 */
export async function routeForPerson(
  userId: string,
  workspaceId: string,
  agents: Pick<Agent, "id" | "reportsTo" | "viaManagerOnly">[],
  levels: ReadonlyMap<string, AgentLevel>,
): Promise<Map<string, string | null>> {
  const managerIds = [...new Set(agents.flatMap((a) => (a.viaManagerOnly && a.reportsTo ? [a.reportsTo] : [])))];
  const live = new Set(
    managerIds.length
      ? (
          await db
            .select({ id: workspaceAgent.id })
            .from(workspaceAgent)
            .where(and(inArray(workspaceAgent.id, managerIds), eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)))
        ).map((a) => a.id)
      : [],
  );
  const managerLevels = managerIds.length ? await agentLevels(userId, workspaceId, managerIds) : new Map<string, AgentLevel>();
  const reachable = (id: string) => live.has(id) && (managerLevels.get(id) ?? "none") !== "none";
  return new Map(agents.map((a) => [a.id, routeTo(a, hasAgentLevel(levels.get(a.id) ?? "none", "edit"), reachable)]));
}

/** The manager's name and icon, for the chat telling someone to write to it instead. */
export async function managerOf(agent: Pick<Agent, "reportsTo">) {
  if (!agent.reportsTo) return null;
  const [found] = await db
    .select({ id: workspaceAgent.id, name: workspaceAgent.name, icon: workspaceAgent.icon, archivedAt: workspaceAgent.archivedAt })
    .from(workspaceAgent)
    .where(eq(workspaceAgent.id, agent.reportsTo));
  return found && !found.archivedAt ? { id: found.id, name: found.name, icon: found.icon } : null;
}
