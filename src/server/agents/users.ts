/**
 * Telling agents' users (see server/agents/manage.ts) apart from people. An agent acts as a user
 * of its own, a guest of its workspace, but it is no person: lists of people, member counts,
 * notifications and emails leave it out, and nobody can make it a member, an owner or a guest
 * elsewhere. Lists of what someone did (last edited by, comments, history, the audit log) show it,
 * marked as an agent.
 *
 * A leaf module: workspaces, access and audit code use it, and agents/manage.ts imports those.
 */
import { eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { user, workspaceAgent } from "@/db/schema";
import { isAgentEmail } from "@/lib/agents";

/** SQL: the user (an id column or expression) is a person, not an agent's user. */
export const notAgentUser = (userId: AnyColumn | SQL) =>
  sql`not exists (select 1 from ${workspaceAgent} where ${workspaceAgent.userId} = ${userId})`;

/** Which of `userIds` are agents' users. */
export async function agentUserIds(userIds: readonly (string | null | undefined)[]): Promise<Set<string>> {
  const ids = [...new Set(userIds)].filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!ids.length) return new Set();
  const rows = await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(inArray(workspaceAgent.userId, ids));
  return new Set(rows.map((r) => r.userId));
}

export async function isAgentUser(userId: string): Promise<boolean> {
  return (await agentUserIds([userId])).has(userId);
}

/**
 * Whether the user is an agent's: has an agent, or an agent's address (the cheap check, which
 * also holds should the agent's row be gone). For sign-in, which must never let one through.
 */
export async function isAgentAccount(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ email: user.email, agentId: workspaceAgent.id })
    .from(user)
    .leftJoin(workspaceAgent, eq(workspaceAgent.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  return Boolean(row && (row.agentId || isAgentEmail(row.email)));
}

/** `userIds` without agents' users, in the same order. */
export async function withoutAgentUsers(userIds: readonly string[]): Promise<string[]> {
  const agents = await agentUserIds(userIds);
  return agents.size ? userIds.filter((id) => !agents.has(id)) : [...userIds];
}

/** How a user summary marks an agent: its icon (an emoji) when it has one. */
export type AgentMark = { isAgent: boolean; agentIcon: string | null };

/** The agents among `userIds`, with their icons, for marking them in user summaries. */
export async function agentMarks(userIds: readonly (string | null | undefined)[]): Promise<Map<string, AgentMark>> {
  const ids = [...new Set(userIds)].filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!ids.length) return new Map();
  const rows = await db
    .select({ userId: workspaceAgent.userId, icon: workspaceAgent.icon })
    .from(workspaceAgent)
    .where(inArray(workspaceAgent.userId, ids));
  return new Map(rows.map((r) => [r.userId, { isAgent: true, agentIcon: r.icon }]));
}

const NOT_AN_AGENT: AgentMark = { isAgent: false, agentIcon: null };

/** The mark of one user, from `agentMarks`. */
export const markOf = (marks: Map<string, AgentMark>, userId: string | null | undefined): AgentMark =>
  (userId ? marks.get(userId) : undefined) ?? NOT_AN_AGENT;
