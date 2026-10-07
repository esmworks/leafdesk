/**
 * Agents of a workspace (see lib/agents.ts): owners create, change, pause and archive them and
 * choose which pages they may open; members list them (to pick one in an automation).
 *
 * An agent is a user of its own: created with the agent, in the same transaction, with an address
 * that can't receive mail (`agent-<id>@agents.leafdesk.invalid`), no password or other way to sign
 * in, and a guest membership of the workspace. As a guest it sees only the pages shared with it
 * (`page_access_level` gives guests nothing from teamspaces, groups or "everyone"), and it's never
 * given full access. Archiving keeps the user, so what the agent did keeps its name.
 */
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, page, pagePermission, user, workspaceAgent } from "@/db/schema";
import {
  agentEmail,
  isAgentAccessLevel,
  MAX_AGENT_DESCRIPTION,
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_NAME,
  MAX_AGENTS,
  type AgentAccessLevel,
  type AgentAccessView,
  type AgentRunView,
  type AgentView,
} from "@/lib/agents";
import { AccessError, ConnectedAppReadOnlyError, pageAccessOf, requireMember, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { removePagePermission, setPagePermission } from "@/server/permissions";
import { addAgentMembership } from "@/server/workspaces";

export type AgentErrorCode = "invalid" | "notFound" | "tooMany" | "archived" | "notAPage";

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly params: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export { AGENT_EMAIL_DOMAIN, agentEmail, isAgentEmail } from "@/lib/agents";
export { agentUserIds, isAgentUser } from "@/server/agents/users";

type Agent = typeof workspaceAgent.$inferSelect;

export type AgentInput = {
  name?: string;
  icon?: string | null;
  description?: string;
  instructions?: string;
  enabled?: boolean;
};

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);

function checkName(value: unknown) {
  const name = clean(value, MAX_AGENT_NAME);
  if (!name) throw new AgentError("invalid", "An agent needs a name", { reason: "name" });
  return name;
}

function checkIcon(value: unknown) {
  if (value === null || value === undefined) return null;
  const icon = typeof value === "string" ? value.trim() : "";
  // An emoji (a few code points at most), like a page's icon.
  if (!icon || [...icon].length > 8) throw new AgentError("invalid", "An agent's icon is an emoji", { reason: "icon" });
  return icon;
}

export function viewAgent(a: Agent): AgentView {
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    userId: a.userId,
    name: a.name,
    icon: a.icon,
    description: a.description,
    instructions: a.instructions,
    enabled: a.enabled,
    archived: a.archivedAt !== null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

const auditDetails = (a: Agent) => ({ name: a.name, enabled: a.enabled, archived: a.archivedAt !== null });

/** The agent with this id, for an owner of its workspace. */
async function ownedAgent(userId: string, agentId: string) {
  const [found] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, agentId)).limit(1);
  if (!found) throw new AgentError("notFound", "Agent not found");
  await requireMembership(userId, found.workspaceId, "owner").catch((error) => {
    // A workspace that lets connected apps only read says so, rather than hiding the agent.
    if (error instanceof AccessError && !(error instanceof ConnectedAppReadOnlyError)) throw new AgentError("notFound", "Agent not found");
    throw error;
  });
  return found;
}

/** The agents of a workspace, for its owners and members (archived ones only when asked). */
export async function listAgents(userId: string, workspaceId: string, { archived = false } = {}): Promise<AgentView[]> {
  await requireMember(userId, workspaceId);
  const rows = await db
    .select()
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), archived ? undefined : isNull(workspaceAgent.archivedAt)))
    .orderBy(workspaceAgent.createdAt);
  return rows.map(viewAgent);
}

export async function getAgent(userId: string, agentId: string): Promise<AgentView> {
  return viewAgent(await ownedAgent(userId, agentId));
}

export async function createAgent(userId: string, workspaceId: string, input: AgentInput): Promise<AgentView> {
  await requireMembership(userId, workspaceId, "owner");
  const name = checkName(input.name);
  const icon = checkIcon(input.icon);
  const description = clean(input.description, MAX_AGENT_DESCRIPTION) ?? "";
  const instructions = clean(input.instructions, MAX_AGENT_INSTRUCTIONS) ?? "";
  const created = await db.transaction(async (tx) => {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(workspaceAgent)
      .where(and(eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)));
    if (n >= MAX_AGENTS) throw new AgentError("tooMany", `A workspace has at most ${MAX_AGENTS} agents`, { max: String(MAX_AGENTS) });
    const id = crypto.randomUUID();
    const userIdOfAgent = crypto.randomUUID();
    await tx.insert(user).values({ id: userIdOfAgent, name, email: agentEmail(id), emailVerified: false });
    await addAgentMembership(tx, workspaceId, userIdOfAgent, userId);
    const [agent] = await tx
      .insert(workspaceAgent)
      .values({ id, workspaceId, userId: userIdOfAgent, name, icon, description, instructions, enabled: input.enabled ?? true, createdBy: userId })
      .returning();
    return agent;
  });
  await recordAudit({ workspaceId, actorId: userId, action: "agent.created", target: { type: "user", id: created.userId, label: name }, details: auditDetails(created) });
  return viewAgent(created);
}

/** Changes an agent; what `patch` leaves out stays as it was. */
export async function updateAgent(userId: string, agentId: string, patch: AgentInput): Promise<AgentView> {
  const current = await ownedAgent(userId, agentId);
  if (current.archivedAt) throw new AgentError("archived", "Restore the agent to change it");
  const set: Partial<Agent> = {};
  if (patch.name !== undefined) set.name = checkName(patch.name);
  if (patch.icon !== undefined) set.icon = checkIcon(patch.icon);
  if (patch.description !== undefined) set.description = clean(patch.description, MAX_AGENT_DESCRIPTION) ?? "";
  if (patch.instructions !== undefined) set.instructions = clean(patch.instructions, MAX_AGENT_INSTRUCTIONS) ?? "";
  if (patch.enabled !== undefined) set.enabled = Boolean(patch.enabled);
  if (!Object.keys(set).length) return viewAgent(current);
  const updated = await db.transaction(async (tx) => {
    const [agent] = await tx.update(workspaceAgent).set(set).where(eq(workspaceAgent.id, agentId)).returning();
    // Its name shows wherever its user does: last edited by, comments, history.
    if (set.name) await tx.update(user).set({ name: set.name }).where(eq(user.id, current.userId));
    return agent;
  });
  await recordAudit({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "agent.updated",
    target: { type: "user", id: current.userId, label: updated.name },
    details: { ...auditDetails(updated), previous: auditDetails(current), instructionsChanged: patch.instructions !== undefined || undefined },
  });
  return viewAgent(updated);
}

/**
 * Archives an agent: it stops (its waiting runs end as paused), loses every page shared with it,
 * and leaves the lists. Its user stays, so its edits and comments keep its name.
 */
export async function archiveAgent(userId: string, agentId: string): Promise<AgentView> {
  const current = await ownedAgent(userId, agentId);
  if (current.archivedAt) return viewAgent(current);
  const archived = await db.transaction(async (tx) => {
    const [agent] = await tx
      .update(workspaceAgent)
      .set({ archivedAt: new Date(), enabled: false })
      .where(eq(workspaceAgent.id, agentId))
      .returning();
    await tx.delete(pagePermission).where(eq(pagePermission.userId, current.userId));
    return agent;
  });
  await recordAudit({ workspaceId: current.workspaceId, actorId: userId, action: "agent.archived", target: { type: "user", id: current.userId, label: current.name }, details: auditDetails(archived) });
  return viewAgent(archived);
}

/** Brings an archived agent back, paused and with nothing shared with it. */
export async function restoreAgent(userId: string, agentId: string): Promise<AgentView> {
  const current = await ownedAgent(userId, agentId);
  if (!current.archivedAt) return viewAgent(current);
  const [{ n }] = await db
    .select({ n: count() })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, current.workspaceId), isNull(workspaceAgent.archivedAt)));
  if (n >= MAX_AGENTS) throw new AgentError("tooMany", `A workspace has at most ${MAX_AGENTS} agents`, { max: String(MAX_AGENTS) });
  const [restored] = await db.update(workspaceAgent).set({ archivedAt: null, enabled: false }).where(eq(workspaceAgent.id, agentId)).returning();
  await recordAudit({ workspaceId: current.workspaceId, actorId: userId, action: "agent.updated", target: { type: "user", id: current.userId, label: current.name }, details: { ...auditDetails(restored), restored: true } });
  return viewAgent(restored);
}

// ------------------------------------------------------------------------------------ access

/**
 * The pages shared with an agent that the owner asking can open themselves (pages they can't
 * open are only counted, the way other lists keep restricted pages out of sight).
 */
export async function listAgentAccess(userId: string, agentId: string): Promise<{ pages: AgentAccessView[]; hidden: number }> {
  const agent = await ownedAgent(userId, agentId);
  const entries = await db
    .select({ pageId: pagePermission.pageId, level: pagePermission.level })
    .from(pagePermission)
    .where(eq(pagePermission.userId, agent.userId));
  const shared = entries.filter((e) => isAgentAccessLevel(e.level));
  const pages: AgentAccessView[] = [];
  let hidden = 0;
  for (const entry of shared) {
    const { page: found, level } = await pageAccessOf(userId, entry.pageId);
    if (!found || level === "none" || found.archivedAt) {
      hidden += 1;
      continue;
    }
    pages.push({
      pageId: found.id,
      title: found.title,
      icon: found.icon,
      kind: found.kind === "database" ? "database" : "page",
      level: entry.level as AgentAccessLevel,
    });
  }
  pages.sort((a, b) => a.title.localeCompare(b.title));
  return { pages, hidden };
}

/**
 * Shares a page (and the pages and rows under it) with an agent. The owner needs full access to
 * the page, as for sharing it with anyone. Rows are reached through their database: an agent
 * reads and changes a row only with access to its database too.
 */
export async function setAgentAccess(userId: string, agentId: string, pageId: string, level: AgentAccessLevel) {
  const agent = await ownedAgent(userId, agentId);
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to share pages with it");
  if (!isAgentAccessLevel(level)) throw new AgentError("invalid", "An agent can view, comment on or edit a page", { reason: "level" });
  const { page: found } = await pageAccessOf(userId, pageId);
  if (!found || found.workspaceId !== agent.workspaceId) throw new AgentError("notAPage", "Page not found");
  await setPagePermission(userId, pageId, agent.userId, level);
}

export async function removeAgentAccess(userId: string, agentId: string, pageId: string) {
  const agent = await ownedAgent(userId, agentId);
  await removePagePermission(userId, pageId, agent.userId);
}

/**
 * Gives an agent edit access to a database an automation runs it on, unless it already has it.
 * `userId` saves the automation, so they have full access to the database.
 */
export async function shareDatabaseWithAgent(userId: string, agentUserId: string, databaseId: string) {
  const { level } = await pageAccessOf(agentUserId, databaseId);
  if (level === "edit" || level === "full") return;
  await setPagePermission(userId, databaseId, agentUserId, "edit");
}

// -------------------------------------------------------------------------------------- runs

/** An agent's latest runs, newest first. */
export async function listAgentRuns(userId: string, agentId: string, limit = 30): Promise<AgentRunView[]> {
  const agent = await ownedAgent(userId, agentId);
  const runs = await db
    .select()
    .from(agentRun)
    .where(eq(agentRun.agentId, agent.id))
    .orderBy(desc(agentRun.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  const rowIds = [...new Set(runs.map((r) => r.source.rowId))];
  const titles = new Map<string, string>();
  if (rowIds.length) {
    const rows = await db.select({ id: page.id, title: page.title }).from(page).where(inArray(page.id, rowIds));
    for (const row of rows) {
      const { level } = await pageAccessOf(userId, row.id);
      if (level !== "none") titles.set(row.id, row.title);
    }
  }
  // What a run read, thought and answered can quote pages the agent may open and the viewer may
  // not; it all ends up on the row anyway, so only people who can open the row see it.
  return runs.map((r) => {
    const open = titles.has(r.source.rowId);
    return {
      id: r.id,
      status: r.status,
      code: r.code ?? null,
      error: open ? r.error : null,
      source: r.source,
      rowTitle: titles.get(r.source.rowId) ?? null,
      steps: open ? r.steps : [],
      answer: open ? r.answer : "",
      usage: r.usage,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

// ---------------------------------------------------------------------------------- lookups

/** An agent of the workspace that may run (enabled, not archived), or null. */
export async function runnableAgent(agentId: string, workspaceId: string) {
  const [found] = await db
    .select()
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.id, agentId), eq(workspaceAgent.workspaceId, workspaceId)))
    .limit(1);
  return found ?? null;
}
