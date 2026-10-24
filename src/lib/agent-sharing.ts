// Client-safe: shared by server/agents/sharing.ts, the agent dialog's Share section, MCP and REST.

import type { WorkspaceRole } from "@/db/schema/app";
import { contentRole } from "@/lib/workspace-roles";

/**
 * Sharing an agent: like a page, an agent has a list of who may use it. Each entry names a person,
 * a group or everyone in the workspace (owners and members, never guests) with a level:
 *
 * - `full`: everything a workspace owner can do with the agent (its settings, instructions,
 *   skills, schedules, the pages shared with it, the agents it can ask, its versions, archiving and
 *   restoring it, all its runs within the usual run visibility), and sharing it;
 * - `edit`: the same, except sharing and archiving it;
 * - `interact`: seeing it and its settings (read-only), chatting with it and mentioning it.
 *
 * Workspace owners always have full access to every agent. Which connections' tools an agent may
 * use and its monthly token limit stay with the owners: they cost money or reach services the
 * owners connected. A person's own entry decides for them; without one, the highest of their
 * groups'; without those, the entry for everyone. No entry at all: no access.
 */

export const AGENT_SHARE_LEVELS = ["full", "edit", "interact"] as const;
export type AgentShareLevel = (typeof AGENT_SHARE_LEVELS)[number];
/** A person's level on an agent; `none`: not shared with them. */
export type AgentLevel = AgentShareLevel | "none";

export const isAgentShareLevel = (value: unknown): value is AgentShareLevel => (AGENT_SHARE_LEVELS as readonly unknown[]).includes(value);

const RANK: Record<AgentLevel, number> = { none: 0, interact: 1, edit: 2, full: 3 };

/** Whether `level` is at least `min`. */
export const hasAgentLevel = (level: AgentLevel, min: AgentLevel) => RANK[level] >= RANK[min];

/**
 * A person's level on an agent from their role in the workspace and the agent's entries that
 * reach them: their own, their groups', everyone's.
 */
export function resolveAgentLevel(input: {
  role: WorkspaceRole | null;
  person?: AgentShareLevel | null;
  groups?: readonly AgentShareLevel[];
  everyone?: AgentShareLevel | null;
}): AgentLevel {
  if (input.role === "owner") return "full";
  // A membership admin is a member here (lib/workspace-roles.ts contentRole).
  if (!input.role || contentRole(input.role) !== "member") return "none";
  if (input.person) return input.person;
  const groups = input.groups ?? [];
  if (groups.length) return groups.reduce<AgentShareLevel>((best, level) => (RANK[level] > RANK[best] ? level : best), groups[0]);
  return input.everyone ?? "none";
}

/** Who an agent is shared with, as its Share section and get_agent show it. */
export type AgentShareEntry =
  | { kind: "person"; userId: string; name: string; email: string; image: string | null; level: AgentShareLevel }
  | { kind: "group"; groupId: string; name: string; memberCount: number; level: AgentShareLevel }
  | { kind: "everyone"; level: AgentShareLevel };

/** Who a share change names: a person, a group, or everyone in the workspace. */
export type AgentShareTarget = { kind: "person"; userId: string } | { kind: "group"; groupId: string } | { kind: "everyone" };

export type AgentSharingView = {
  /** The viewer's level: only `full` changes the list. */
  level: AgentLevel;
  entries: AgentShareEntry[];
  /** People and groups the list may add (members and owners of the workspace; owners always have full access). */
  members: { userId: string; name: string; email: string; image: string | null; owner: boolean }[];
  groups: { groupId: string; name: string; memberCount: number }[];
};

/** Who may create agents in a workspace (its `agentCreation` setting). */
export type AgentCreation = "owners" | "members";
