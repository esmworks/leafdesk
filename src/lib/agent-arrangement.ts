/**
 * How a person arranges the agents' list in the sidebar: groups of their own, in their order, and the
 * order of the agents in each and of those in none. Kept with the rest of their sidebar layout
 * (lib/sidebar-sections.ts `agents`), so it is theirs alone and changes no one else's list. Ids of
 * agents no longer shown (archived, unshared) are skipped where shown and dropped by the next save.
 */

export type AgentGroup = { id: string; name: string; agents: string[]; folded?: boolean };
export type AgentArrangement = { groups: AgentGroup[]; loose: string[] };

export const MAX_AGENT_GROUPS = 30;
export const MAX_AGENT_GROUP_NAME = 60;
const MAX_IDS = 300;
const MAX_ID = 64;

export const EMPTY_ARRANGEMENT: AgentArrangement = { groups: [], loose: [] };

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

/** An arrangement from untrusted input: each agent once, at most the limits, null when it isn't one. */
export function cleanAgentArrangement(input: unknown): AgentArrangement | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { groups, loose } = input as Record<string, unknown>;
  if (!Array.isArray(groups) || !Array.isArray(loose)) return null;
  const seen = new Set<string>();
  const take = (ids: unknown): string[] => {
    if (!Array.isArray(ids)) return [];
    const out: string[] = [];
    for (const id of ids) {
      if (!isId(id) || seen.has(id) || seen.size >= MAX_IDS) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const groupIds = new Set<string>();
  const cleanGroups: AgentGroup[] = [];
  for (const g of groups) {
    if (cleanGroups.length >= MAX_AGENT_GROUPS) break;
    if (!g || typeof g !== "object") continue;
    const { id, name, agents, folded } = g as Record<string, unknown>;
    if (!isId(id) || groupIds.has(id) || typeof name !== "string") continue;
    const trimmed = name.trim().slice(0, MAX_AGENT_GROUP_NAME);
    if (!trimmed) continue;
    groupIds.add(id);
    cleanGroups.push({ id, name: trimmed, agents: take(agents), ...(folded === true ? { folded: true } : {}) });
  }
  return { groups: cleanGroups, loose: take(loose) };
}

/** The agents in the person's arrangement: each group with its agents, then those in no group (new ones last). */
export function arrangeAgents<A extends { id: string }>(agents: A[], arrangement: AgentArrangement | undefined) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const placed = new Set<string>();
  const pick = (ids: string[]) =>
    ids.flatMap((id) => {
      const agent = byId.get(id);
      if (!agent || placed.has(id)) return [];
      placed.add(id);
      return [agent];
    });
  const groups = (arrangement?.groups ?? []).map((group) => ({ group, agents: pick(group.agents) }));
  const loose = pick(arrangement?.loose ?? []);
  for (const agent of agents) if (!placed.has(agent.id)) loose.push(agent);
  return { groups, loose };
}

/** The arrangement written out for the agents shown now: every one placed, ids of others dropped. */
export function settled(agents: { id: string }[], arrangement: AgentArrangement | undefined): AgentArrangement {
  const { groups, loose } = arrangeAgents(agents, arrangement);
  return { groups: groups.map(({ group, agents }) => ({ ...group, agents: agents.map((a) => a.id) })), loose: loose.map((a) => a.id) };
}

/** Where an agent goes: into a group (null: none) before the agent at `index` there (past the end: last). */
export type AgentPlace = { group: string | null; index: number };

/** The arrangement with an agent moved to `place`. */
export function moveAgent(arrangement: AgentArrangement, agentId: string, place: AgentPlace): AgentArrangement {
  const without = (ids: string[]) => ids.filter((id) => id !== agentId);
  const insert = (ids: string[], list: string[]) => {
    // The index counts the list as it was shown, with the moved agent still in it.
    const at = Math.max(0, Math.min(place.index - (list.slice(0, place.index).includes(agentId) ? 1 : 0), ids.length));
    return [...ids.slice(0, at), agentId, ...ids.slice(at)];
  };
  if (place.group !== null && !arrangement.groups.some((g) => g.id === place.group)) return arrangement;
  return {
    groups: arrangement.groups.map((g) => (g.id === place.group ? { ...g, agents: insert(without(g.agents), g.agents) } : { ...g, agents: without(g.agents) })),
    loose: place.group === null ? insert(without(arrangement.loose), arrangement.loose) : without(arrangement.loose),
  };
}

/** The arrangement with a group moved before the group at `index` (past the end: last). */
export function moveGroup(arrangement: AgentArrangement, groupId: string, index: number): AgentArrangement {
  const from = arrangement.groups.findIndex((g) => g.id === groupId);
  if (from < 0) return arrangement;
  const groups = arrangement.groups.filter((g) => g.id !== groupId);
  const at = Math.max(0, Math.min(index - (from < index ? 1 : 0), groups.length));
  groups.splice(at, 0, arrangement.groups[from]);
  return { ...arrangement, groups };
}

/** The arrangement with a new, empty group last, or with the agent given moved into it. */
export function addGroup(arrangement: AgentArrangement, id: string, name: string, agentId?: string): AgentArrangement {
  const trimmed = name.trim().slice(0, MAX_AGENT_GROUP_NAME);
  if (!trimmed || arrangement.groups.length >= MAX_AGENT_GROUPS) return arrangement;
  const added = { ...arrangement, groups: [...arrangement.groups, { id, name: trimmed, agents: [] }] };
  return agentId ? moveAgent(added, agentId, { group: id, index: 0 }) : added;
}

export function renameGroup(arrangement: AgentArrangement, groupId: string, name: string): AgentArrangement {
  const trimmed = name.trim().slice(0, MAX_AGENT_GROUP_NAME);
  if (!trimmed) return arrangement;
  return { ...arrangement, groups: arrangement.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)) };
}

/** The arrangement without a group; its agents go to the top of those in no group, in their order. */
export function removeGroup(arrangement: AgentArrangement, groupId: string): AgentArrangement {
  const group = arrangement.groups.find((g) => g.id === groupId);
  if (!group) return arrangement;
  return { groups: arrangement.groups.filter((g) => g.id !== groupId), loose: [...group.agents, ...arrangement.loose] };
}

export function foldGroup(arrangement: AgentArrangement, groupId: string, folded: boolean): AgentArrangement {
  return {
    ...arrangement,
    groups: arrangement.groups.map((g) => {
      if (g.id !== groupId) return g;
      const { folded: _, ...rest } = g;
      return folded ? { ...rest, folded: true } : rest;
    }),
  };
}

/** The arrangement with each group's agents, and those in none, in alphabetical order of their names. */
export function sortByName(arrangement: AgentArrangement, names: Map<string, string>, locale?: string): AgentArrangement {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const sort = (ids: string[]) => [...ids].sort((a, b) => collator.compare(names.get(a) ?? "", names.get(b) ?? ""));
  return { groups: arrangement.groups.map((g) => ({ ...g, agents: sort(g.agents) })), loose: sort(arrangement.loose) };
}
