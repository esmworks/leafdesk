// Client-safe: shared by server/agents/team.ts, the agent's settings, MCP and REST.

/**
 * Agents working as a team: which other agents an agent may ask (`helpersMode`), the agent it
 * reports to (its manager, `reportsTo`), and whether it works only through that manager
 * (`viaManagerOnly`).
 *
 * - `none`: it asks no one; `chosen`: the agents picked one by one (agent_helper, at most
 *   MAX_AGENT_HELPERS); `all`: every other agent of the workspace that isn't archived and that the
 *   person who chose "all" (`helpersSetBy`) may still use, worked out on each run, so agents added
 *   later are in it too.
 * - A manager may always ask the agents that report to it, whatever its own mode.
 * - An agent working only through its manager reports its runs' results to the manager instead of
 *   to people (the manager reads them with agent_tasks), and someone who can't edit it is sent to
 *   the manager when they chat with it or mention it.
 */

export const AGENT_HELPERS_MODES = ["none", "chosen", "all"] as const;
export type AgentHelpersMode = (typeof AGENT_HELPERS_MODES)[number];

export const isAgentHelpersMode = (value: unknown): value is AgentHelpersMode => (AGENT_HELPERS_MODES as readonly unknown[]).includes(value);

/** How many links a chain of managers may have (an agent → its manager → theirs …). */
export const MAX_REPORTING_DEPTH = 5;

/**
 * Whether `agentId` reporting to `managerId` would close a loop (or make a chain deeper than
 * MAX_REPORTING_DEPTH), given whom each agent reports to now (`reportsTo`).
 */
export function reportingProblem(agentId: string, managerId: string, reportsTo: ReadonlyMap<string, string | null>): "self" | "loop" | "tooDeep" | null {
  if (agentId === managerId) return "self";
  let depth = 1;
  let current: string | null = managerId;
  const seen = new Set<string>([agentId]);
  while (current) {
    if (seen.has(current)) return "loop";
    seen.add(current);
    current = reportsTo.get(current) ?? null;
    if (current) depth += 1;
    if (depth > MAX_REPORTING_DEPTH) return "tooDeep";
  }
  // Those under agentId come along: the deepest of them must still fit.
  const below = depthBelow(agentId, reportsTo);
  return depth + below > MAX_REPORTING_DEPTH ? "tooDeep" : null;
}

/** How many levels of agents report to `agentId`, down to the deepest. */
function depthBelow(agentId: string, reportsTo: ReadonlyMap<string, string | null>): number {
  const children = new Map<string, string[]>();
  for (const [id, manager] of reportsTo) if (manager) children.set(manager, [...(children.get(manager) ?? []), id]);
  const walk = (id: string, seen: Set<string>): number => {
    let deepest = 0;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue;
      deepest = Math.max(deepest, 1 + walk(child, new Set([...seen, child])));
    }
    return deepest;
  };
  return walk(agentId, new Set([agentId]));
}

/** What a team needs to know of an agent to route someone's message to it. */
export type RoutedAgent = { id: string; reportsTo: string | null; viaManagerOnly: boolean };

/**
 * Where someone's chat message or mention for `agent` goes: the agent itself, or, when it works
 * only through its manager and they can't edit it (`editsAgent`), its manager; null when it works
 * through a manager they can't reach (`reachable`: they may use it, and it is live).
 */
export function routeTo(agent: RoutedAgent, editsAgent: boolean, reachable: (managerId: string) => boolean): string | null {
  if (!agent.viaManagerOnly || !agent.reportsTo || editsAgent) return agent.id;
  return reachable(agent.reportsTo) ? agent.reportsTo : null;
}
