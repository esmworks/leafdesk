/**
 * Sharing an agent (lib/agent-sharing.ts): who may use an agent and how (`agent_share`), the levels
 * people have on agents, and who may create agents (the workspace's `agentCreation` setting).
 *
 * A new agent is shared with everyone in the workspace (can view and interact) and with whoever
 * created it (full access); workspace owners have full access to every agent without an entry.
 * Only those with full access change the list, and every change goes to the audit log.
 *
 * Imports no agent module but errors.ts: manage.ts and the others check levels through it.
 */
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentShare, memberGroup, memberGroupMember, user, workspaceAgent } from "@/db/schema";
import {
  hasAgentLevel,
  isAgentShareLevel,
  resolveAgentLevel,
  type AgentLevel,
  type AgentShareEntry,
  type AgentShareLevel,
  type AgentShareTarget,
  type AgentSharingView,
} from "@/lib/agent-sharing";
import { AccessError, ConnectedAppReadOnlyError, findMembership, requireMember, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { workspacePeople, workspaceSettings } from "@/server/workspaces";
import { AgentError } from "./errors";

type Agent = typeof workspaceAgent.$inferSelect;
type Role = "owner" | "member" | "guest";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The person's level on each of these agents of the workspace (every agent of it when `agentIds` is
 * null), by agent id. Their standing as it is now, without the sign-in policies of a session: the
 * run worker asks too. `role` saves looking the membership up again (null: not in the workspace).
 */
export async function agentLevels(userId: string, workspaceId: string, agentIds: string[] | null, role?: Role | null): Promise<Map<string, AgentLevel>> {
  const standing = role === undefined ? ((await findMembership(userId, workspaceId))?.role ?? null) : role;
  const ids =
    agentIds ?? (await db.select({ id: workspaceAgent.id }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.id);
  const levels = new Map<string, AgentLevel>(ids.map((id) => [id, resolveAgentLevel({ role: standing })]));
  if (standing !== "member" || !ids.length) return levels;
  const groupIds = (
    await db
      .select({ groupId: memberGroupMember.groupId })
      .from(memberGroupMember)
      .where(and(eq(memberGroupMember.userId, userId), eq(memberGroupMember.workspaceId, workspaceId)))
  ).map((g) => g.groupId);
  const rows = await db
    .select({ agentId: agentShare.agentId, userId: agentShare.userId, groupId: agentShare.groupId, level: agentShare.level })
    .from(agentShare)
    .where(
      and(
        eq(agentShare.workspaceId, workspaceId),
        inArray(agentShare.agentId, ids),
        or(
          eq(agentShare.userId, userId),
          groupIds.length ? inArray(agentShare.groupId, groupIds) : undefined,
          and(isNull(agentShare.userId), isNull(agentShare.groupId)),
        ),
      ),
    );
  for (const id of ids) {
    const mine = rows.filter((r) => r.agentId === id);
    levels.set(
      id,
      resolveAgentLevel({
        role: standing,
        person: mine.find((r) => r.userId === userId)?.level ?? null,
        groups: mine.filter((r) => r.groupId !== null).map((r) => r.level),
        everyone: mine.find((r) => r.userId === null && r.groupId === null)?.level ?? null,
      }),
    );
  }
  return levels;
}

/** The person's level on one agent (see agentLevels). */
export async function agentLevel(userId: string, agent: Pick<Agent, "id" | "workspaceId">, role?: Role | null): Promise<AgentLevel> {
  return (await agentLevels(userId, agent.workspaceId, [agent.id], role)).get(agent.id) ?? "none";
}

/**
 * The agent with this id, for someone with at least `min` on it: their level, and whether they own
 * the workspace. Not found when it isn't shared with them at all (or they aren't in its
 * workspace); notAllowed when it is, at a lower level.
 */
export async function agentWithLevel(userId: string, agentId: string, min: AgentLevel) {
  const [found] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, agentId)).limit(1);
  if (!found) throw new AgentError("notFound", "Agent not found");
  const membership = await requireMembership(userId, found.workspaceId).catch((error) => {
    // A workspace that lets connected apps only read says so, rather than hiding the agent.
    if (error instanceof AccessError && !(error instanceof ConnectedAppReadOnlyError)) throw new AgentError("notFound", "Agent not found");
    throw error;
  });
  const level = await agentLevel(userId, found, membership.role);
  if (level === "none") throw new AgentError("notFound", "Agent not found");
  if (!hasAgentLevel(level, min)) throw new AgentError("notAllowed", "You don't have the access to this agent this needs", { level });
  return { agent: found, level: level as AgentShareLevel, owner: membership.role === "owner" };
}

// ---------------------------------------------------------------------------------- creating

/** Whether the person may create agents in the workspace: owners, and members when its setting lets them. */
export async function canCreateAgents(userId: string, workspaceId: string): Promise<boolean> {
  const membership = await requireMember(userId, workspaceId).catch(() => null);
  if (!membership) return false;
  return membership.role === "owner" || (await workspaceSettings(workspaceId)).agentCreation === "members";
}

/** Throws AccessError unless the person may create agents in the workspace. */
export async function requireAgentCreator(userId: string, workspaceId: string) {
  const membership = await requireMember(userId, workspaceId);
  if (membership.role !== "owner" && (await workspaceSettings(workspaceId)).agentCreation !== "members") throw new AccessError();
  return membership;
}

/** A new agent's list: everyone in the workspace can view and interact; its creator has full access. */
export async function shareNewAgent(tx: Tx, agent: Pick<Agent, "id" | "workspaceId">, creatorId: string) {
  await tx.insert(agentShare).values([
    { agentId: agent.id, workspaceId: agent.workspaceId, level: "interact", createdBy: creatorId },
    { agentId: agent.id, workspaceId: agent.workspaceId, userId: creatorId, level: "full", createdBy: creatorId },
  ]);
}

// ----------------------------------------------------------------------------------- the list

const principal = (target: AgentShareTarget) =>
  target.kind === "person"
    ? and(eq(agentShare.userId, target.userId), isNull(agentShare.groupId))
    : target.kind === "group"
      ? and(isNull(agentShare.userId), eq(agentShare.groupId, target.groupId))
      : and(isNull(agentShare.userId), isNull(agentShare.groupId));

/** Who the agent is shared with; for those with full access, also who it may be shared with. */
export async function agentSharing(userId: string, agentId: string): Promise<AgentSharingView> {
  const { agent, level } = await agentWithLevel(userId, agentId, "interact");
  return sharingOf(agent, level);
}

async function sharingOf(agent: Agent, level: AgentLevel): Promise<AgentSharingView> {
  const groupCounts = db
    .select({ groupId: memberGroupMember.groupId, n: count().as("n") })
    .from(memberGroupMember)
    .where(eq(memberGroupMember.workspaceId, agent.workspaceId))
    .groupBy(memberGroupMember.groupId)
    .as("group_counts");
  const [people, groups, everyone] = await Promise.all([
    db
      .select({ userId: user.id, name: user.name, email: user.email, image: user.image, level: agentShare.level })
      .from(agentShare)
      .innerJoin(user, eq(user.id, agentShare.userId))
      .where(eq(agentShare.agentId, agent.id))
      .orderBy(sql`lower(${user.name})`),
    db
      .select({ groupId: memberGroup.id, name: memberGroup.name, memberCount: sql<number>`coalesce(${groupCounts.n}, 0)`.mapWith(Number), level: agentShare.level })
      .from(agentShare)
      .innerJoin(memberGroup, eq(memberGroup.id, agentShare.groupId))
      .leftJoin(groupCounts, eq(groupCounts.groupId, memberGroup.id))
      .where(eq(agentShare.agentId, agent.id))
      .orderBy(sql`lower(${memberGroup.name})`),
    db
      .select({ level: agentShare.level })
      .from(agentShare)
      .where(and(eq(agentShare.agentId, agent.id), isNull(agentShare.userId), isNull(agentShare.groupId))),
  ]);
  const entries: AgentShareEntry[] = [
    ...(everyone[0] ? [{ kind: "everyone" as const, level: everyone[0].level }] : []),
    ...people.map((p) => ({ kind: "person" as const, ...p })),
    ...groups.map((g) => ({ kind: "group" as const, ...g })),
  ];
  if (level !== "full") return { level, entries, members: [], groups: [] };
  const [members, allGroups] = await Promise.all([
    workspacePeople(agent.workspaceId),
    db
      .select({ groupId: memberGroup.id, name: memberGroup.name, memberCount: sql<number>`coalesce(${groupCounts.n}, 0)`.mapWith(Number) })
      .from(memberGroup)
      .leftJoin(groupCounts, eq(groupCounts.groupId, memberGroup.id))
      .where(eq(memberGroup.workspaceId, agent.workspaceId))
      .orderBy(sql`lower(${memberGroup.name})`),
  ]);
  return {
    level,
    entries,
    members: members
      .filter((m) => m.role !== "guest")
      .map((m) => ({ userId: m.id, name: m.name, email: m.email, image: m.image, owner: m.role === "owner" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    groups: allGroups,
  };
}

/** Whom the target names, as the audit log records it; refused when it isn't someone the agent may be shared with. */
async function subjectOf(workspaceId: string, target: AgentShareTarget) {
  if (target.kind === "everyone") return { type: "everyone" as const };
  if (target.kind === "person") {
    const membership = typeof target.userId === "string" ? await findMembership(target.userId, workspaceId) : null;
    if (!membership || membership.role === "guest") throw new AgentError("notAMember", "An agent is shared only with the workspace's owners, members and groups");
    return { type: "user" as const, id: target.userId };
  }
  const [group] =
    typeof target.groupId === "string"
      ? await db
          .select({ id: memberGroup.id })
          .from(memberGroup)
          .where(and(eq(memberGroup.id, target.groupId), eq(memberGroup.workspaceId, workspaceId)))
      : [];
  if (!group) throw new AgentError("notAMember", "An agent is shared only with the workspace's owners, members and groups");
  return { type: "group" as const, id: group.id };
}

/** A share target from untrusted input (MCP, an action), or null when it names none. */
export function parseShareTarget(value: unknown): AgentShareTarget | null {
  const v = value as Partial<{ kind: string; userId: unknown; groupId: unknown }> | null;
  if (v?.kind === "everyone") return { kind: "everyone" };
  if (v?.kind === "person" && typeof v.userId === "string" && v.userId) return { kind: "person", userId: v.userId };
  if (v?.kind === "group" && typeof v.groupId === "string" && v.groupId) return { kind: "group", groupId: v.groupId };
  return null;
}

/** Shares the agent with a person, a group or everyone at `level` (or changes their level). Full access only. */
export async function setAgentShare(userId: string, agentId: string, target: AgentShareTarget, level: AgentShareLevel): Promise<AgentSharingView> {
  const { agent, level: own } = await agentWithLevel(userId, agentId, "full");
  if (!isAgentShareLevel(level)) throw new AgentError("invalid", "An agent is shared at full access, can edit or can view and interact", { reason: "shareLevel" });
  const subject = await subjectOf(agent.workspaceId, target);
  const previous = await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: agentShare.id, level: agentShare.level })
      .from(agentShare)
      .where(and(eq(agentShare.agentId, agent.id), principal(target)));
    if (found?.level === level) return level;
    if (found) await tx.update(agentShare).set({ level }).where(eq(agentShare.id, found.id));
    else {
      await tx.insert(agentShare).values({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        userId: target.kind === "person" ? target.userId : null,
        groupId: target.kind === "group" ? target.groupId : null,
        level,
        createdBy: userId,
      });
    }
    await recordAudit(
      {
        workspaceId: agent.workspaceId,
        actorId: userId,
        action: "agent.shared",
        target: { type: "user", id: agent.userId, label: agent.name },
        subject,
        details: { name: agent.name, level, previous: found?.level ?? null },
      },
      tx,
    );
    return found?.level ?? null;
  });
  // Their own entry may have changed what the person who changed it may do.
  return sharingOf(agent, previous === level ? own : await agentLevel(userId, agent));
}

/** Takes a person, a group or everyone off the agent's list. Full access only. */
export async function removeAgentShare(userId: string, agentId: string, target: AgentShareTarget): Promise<AgentSharingView> {
  const { agent } = await agentWithLevel(userId, agentId, "full");
  const subject = target.kind === "everyone" ? { type: "everyone" as const } : { type: target.kind === "person" ? ("user" as const) : ("group" as const), id: target.kind === "person" ? target.userId : target.groupId };
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(agentShare)
      .where(and(eq(agentShare.agentId, agent.id), principal(target)))
      .returning({ level: agentShare.level });
    if (!removed.length) return;
    await recordAudit(
      {
        workspaceId: agent.workspaceId,
        actorId: userId,
        action: "agent.unshared",
        target: { type: "user", id: agent.userId, label: agent.name },
        subject,
        details: { name: agent.name, previous: removed[0].level },
      },
      tx,
    );
  });
  return sharingOf(agent, await agentLevel(userId, agent));
}
