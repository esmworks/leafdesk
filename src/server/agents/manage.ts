/**
 * Agents of a workspace (see lib/agents.ts): who may create them is the workspace's setting (owners
 * only, or members too), and each agent's sharing list (sharing.ts) says who may change, pause and
 * archive it and choose which pages it may open; workspace owners may do all of that with every agent.
 *
 * An agent is a user of its own: created with the agent, in the same transaction, with an address
 * that can't receive mail (`agent-<id>@agents.leafdesk.invalid`), no password or other way to sign
 * in, and a guest membership of the workspace. As a guest it sees only the pages shared with it
 * (`page_access_level` gives guests nothing from teamspaces, groups or "everyone"), and it's never
 * given full access. Archiving keeps the user, so what the agent did keeps its name.
 */
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentDatabaseShare, agentRun, connection, databaseAutomation, page, pagePermission, schedule, user, workspaceAgent } from "@/db/schema";
import { MAX_AGENT_MAIL_RECIPIENTS, parseMailRecipients } from "@/lib/agent-mail";
import {
  accessSource,
  agentEmail,
  callConnectionName,
  callToSend,
  isAgentAccessLevel,
  isAgentModel,
  isAgentRowChanges,
  isEventRun,
  isMentionRun,
  isRowRun,
  isScheduleRun,
  ownerSeesRun,
  runPageOf,
  MAX_AGENT_DESCRIPTION,
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_NAME,
  MAX_AGENT_TOKEN_LIMIT,
  MAX_AGENTS,
  type AgentAccessLevel,
  type AgentAccessView,
  type AgentModel,
  type AgentRowChanges,
  type AgentRunView,
  type AgentView,
} from "@/lib/agents";
import { agentTargets } from "@/lib/automations";
import { ICON_RULE, parseIcon } from "@/lib/icon";
import type { AgentLevel, AgentShareLevel } from "@/lib/agent-sharing";
import { AccessError, pageAccessOf, pageVisibleTo, requireMember } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { removePagePermission, setPagePermission } from "@/server/permissions";
import { addAgentMembership } from "@/server/workspaces";
import { recordAgentVersion, withoutVersions } from "./version-record";
import { checkHelperIds, dropHelper, helperIdsOf, saveHelpers } from "./helpers";
import { agentLevels, agentWithLevel, requireAgentCreator, shareNewAgent } from "./sharing";

import { AgentError } from "./errors";

export { AgentError, type AgentErrorCode } from "./errors";

export { AGENT_EMAIL_DOMAIN, agentEmail, isAgentEmail } from "@/lib/agents";
export { agentUserIds, isAgentUser } from "@/server/agents/users";

type Agent = typeof workspaceAgent.$inferSelect;

export type AgentInput = {
  name?: string;
  icon?: string | null;
  description?: string;
  instructions?: string;
  enabled?: boolean;
  webAccess?: boolean;
  /** Addresses its runs may send email to (lib/agent-mail.ts). */
  mailRecipients?: string[];
  /** Tokens a month; null removes the limit. */
  monthlyTokenLimit?: number | null;
  model?: AgentModel;
  /** Whether its runs change rows at once or propose the changes for review. */
  rowChanges?: AgentRowChanges;
  /** Its "Agents it can ask" (see helpers.ts), all of them. */
  helperAgentIds?: string[];
};

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);

function checkName(value: unknown) {
  const name = clean(value, MAX_AGENT_NAME);
  if (!name) throw new AgentError("invalid", "An agent needs a name", { reason: "name" });
  return name;
}

function checkLimit(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_AGENT_TOKEN_LIMIT) {
    throw new AgentError("invalid", "A monthly token limit is a whole number of tokens, from 1 to a billion", { reason: "limit" });
  }
  return value;
}

function checkRowChanges(value: unknown): AgentRowChanges {
  if (!isAgentRowChanges(value)) throw new AgentError("invalid", 'An agent changes rows "direct"ly or proposes them for "review"', { reason: "rowChanges" });
  return value;
}

function checkMailRecipients(value: unknown): string[] {
  const recipients = parseMailRecipients(value);
  if (!recipients) throw new AgentError("invalid", `An agent sends email to up to ${MAX_AGENT_MAIL_RECIPIENTS} addresses`, { reason: "mailRecipients" });
  return recipients;
}

function checkModel(value: unknown): AgentModel {
  if (!isAgentModel(value)) throw new AgentError("invalid", 'An agent runs on the "main" or the "fast" model', { reason: "model" });
  return value;
}

/**
 * `value` as an agent's helpers, chosen by `userId`: each helper they add must be one they can at
 * least interact with (owners: any); those it has already stay.
 */
async function checkHelpers(userId: string, workspaceId: string, agentId: string | null, value: unknown, kept: string[] = []) {
  const ids = await checkHelperIds(workspaceId, agentId, value);
  if (!ids) throw new AgentError("invalid", "An agent may ask up to 10 other agents of its workspace that aren't archived", { reason: "helpers" });
  const added = ids.filter((id) => !kept.includes(id));
  if (added.length) {
    const levels = await agentLevels(userId, workspaceId, added);
    if (added.some((id) => levels.get(id) === "none")) throw new AgentError("invalid", "An agent may ask only agents shared with you", { reason: "helpers" });
  }
  return ids;
}

function checkIcon(value: unknown) {
  if (value === null || value === undefined) return null;
  // An emoji (a few code points at most) or a built-in icon, like a page's icon.
  const icon = parseIcon(value);
  if (!icon) throw new AgentError("invalid", `An agent's icon is ${ICON_RULE}`, { reason: "icon" });
  return icon;
}

/** The agent as `access` (the viewer's level on it) sees it. */
export function viewAgent(a: Agent, access: AgentShareLevel): AgentView {
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
    webAccess: a.webAccess,
    mailRecipients: a.mailRecipients,
    monthlyTokenLimit: a.monthlyTokenLimit,
    model: a.model,
    rowChanges: a.rowChanges,
    access,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export const auditDetails = (a: Agent) => ({
  name: a.name,
  enabled: a.enabled,
  archived: a.archivedAt !== null,
  webAccess: a.webAccess,
  mailRecipients: a.mailRecipients,
  monthlyTokenLimit: a.monthlyTokenLimit,
  model: a.model,
  rowChanges: a.rowChanges,
});

export { agentWithLevel } from "./sharing";

/**
 * The agent with this id, for someone with at least `min` on it (see sharing.ts): `interact` to
 * see it, `edit` to change it, `full` to share and archive it.
 */
export async function agentFor(userId: string, agentId: string, min: AgentLevel) {
  return (await agentWithLevel(userId, agentId, min)).agent;
}

/**
 * The agents of a workspace someone in it (not a guest) may see: every one for its owners, those
 * shared with them for members (archived ones only when asked), each with their level on it.
 */
export async function listAgents(userId: string, workspaceId: string, { archived = false } = {}): Promise<AgentView[]> {
  const membership = await requireMember(userId, workspaceId);
  const rows = await db
    .select()
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), archived ? undefined : isNull(workspaceAgent.archivedAt)))
    .orderBy(workspaceAgent.createdAt);
  const levels = await agentLevels(userId, workspaceId, rows.map((a) => a.id), membership.role);
  return rows.flatMap((a) => {
    const level = levels.get(a.id) ?? "none";
    return level === "none" ? [] : [viewAgent(a, level)];
  });
}

/** An agent as the sidebar lists it. */
export type SidebarAgent = { id: string; name: string; icon: string | null };

/** The agents someone may talk to, for the sidebar: those listAgents gives them, none for guests. */
export async function sidebarAgents(userId: string, workspaceId: string): Promise<SidebarAgent[]> {
  try {
    return (await listAgents(userId, workspaceId)).map((a) => ({ id: a.id, name: a.name, icon: a.icon }));
  } catch (error) {
    if (error instanceof AccessError) return [];
    throw error;
  }
}

/** The names of the workspace's agents (archived ones too), for naming them where they are used (automations): for owners and members. */
export async function agentRefs(userId: string, workspaceId: string): Promise<{ id: string; name: string }[]> {
  await requireMember(userId, workspaceId);
  return db.select({ id: workspaceAgent.id, name: workspaceAgent.name }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId)).orderBy(workspaceAgent.createdAt);
}

export async function getAgent(userId: string, agentId: string): Promise<AgentView> {
  const { agent, level } = await agentWithLevel(userId, agentId, "interact");
  return viewAgent(agent, level);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What a copy (duplicate.ts) adds to creating an agent. */
export type CopyOptions = {
  /** The agent it copies: its monthly token limit may be kept by anyone, as it only holds the copy back. */
  copiedFrom: Agent;
  /** Gives the new agent the rest of the setup (skills, connection tools), in the same transaction. */
  setUp: (tx: Tx, agent: Agent) => Promise<void>;
};

/**
 * Creates an agent, for owners and (when the workspace lets them) members: shared with everyone in
 * the workspace (can view and interact), and with its creator at full access. Only owners give it
 * a monthly token limit, except the one of the agent it copies.
 */
export async function createAgent(userId: string, workspaceId: string, input: AgentInput, copy?: CopyOptions): Promise<AgentView> {
  const membership = await requireAgentCreator(userId, workspaceId);
  const keptLimit = copy !== undefined && input.monthlyTokenLimit === copy.copiedFrom.monthlyTokenLimit;
  if (input.monthlyTokenLimit !== undefined && input.monthlyTokenLimit !== null && membership.role !== "owner" && !keptLimit) {
    throw new AgentError("ownersOnly", "Only the workspace's owners set an agent's monthly token limit");
  }
  const name = checkName(input.name);
  const icon = checkIcon(input.icon);
  const description = clean(input.description, MAX_AGENT_DESCRIPTION) ?? "";
  const instructions = clean(input.instructions, MAX_AGENT_INSTRUCTIONS) ?? "";
  const monthlyTokenLimit = input.monthlyTokenLimit === undefined ? null : checkLimit(input.monthlyTokenLimit);
  const model = input.model === undefined ? "main" : checkModel(input.model);
  const helpers = input.helperAgentIds === undefined ? [] : await checkHelpers(userId, workspaceId, null, input.helperAgentIds);
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
      .values({
        id,
        workspaceId,
        userId: userIdOfAgent,
        name,
        icon,
        description,
        instructions,
        enabled: input.enabled ?? true,
        webAccess: input.webAccess === true,
        mailRecipients: input.mailRecipients === undefined ? [] : checkMailRecipients(input.mailRecipients),
        monthlyTokenLimit,
        model,
        rowChanges: input.rowChanges === undefined ? "direct" : checkRowChanges(input.rowChanges),
        createdBy: userId,
      })
      .returning();
    if (helpers.length) await saveHelpers(tx, id, helpers);
    await shareNewAgent(tx, agent, userId);
    if (copy) await copy.setUp(tx, agent);
    return agent;
  });
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "agent.created",
    target: { type: "user", id: created.userId, label: name },
    details: { ...auditDetails(created), ...(copy ? { copiedFrom: { id: copy.copiedFrom.id, name: copy.copiedFrom.name } } : {}) },
  });
  await recordAgentVersion(userId, created.id, "created");
  return viewAgent(created, "full");
}

/**
 * Changes an agent, for those who can edit it; what `patch` leaves out stays as it was. Only owners
 * change its monthly token limit (the same limit sent back is no change).
 */
export async function updateAgent(userId: string, agentId: string, patch: AgentInput): Promise<AgentView> {
  const { agent: current, level, owner } = await agentWithLevel(userId, agentId, "edit");
  if (current.archivedAt) throw new AgentError("archived", "Restore the agent to change it");
  if (patch.monthlyTokenLimit !== undefined && patch.monthlyTokenLimit !== current.monthlyTokenLimit && !owner) {
    throw new AgentError("ownersOnly", "Only the workspace's owners set an agent's monthly token limit");
  }
  const set: Partial<Agent> = {};
  if (patch.name !== undefined) set.name = checkName(patch.name);
  if (patch.icon !== undefined) set.icon = checkIcon(patch.icon);
  if (patch.description !== undefined) set.description = clean(patch.description, MAX_AGENT_DESCRIPTION) ?? "";
  if (patch.instructions !== undefined) set.instructions = clean(patch.instructions, MAX_AGENT_INSTRUCTIONS) ?? "";
  if (patch.enabled !== undefined) set.enabled = Boolean(patch.enabled);
  if (patch.webAccess !== undefined) set.webAccess = patch.webAccess === true;
  if (patch.mailRecipients !== undefined) set.mailRecipients = checkMailRecipients(patch.mailRecipients);
  if (patch.monthlyTokenLimit !== undefined) set.monthlyTokenLimit = checkLimit(patch.monthlyTokenLimit);
  if (patch.model !== undefined) set.model = checkModel(patch.model);
  if (patch.rowChanges !== undefined) set.rowChanges = checkRowChanges(patch.rowChanges);
  const helpersBefore = (await helperIdsOf([agentId])).get(agentId) ?? [];
  const helpers = patch.helperAgentIds === undefined ? helpersBefore : await checkHelpers(userId, current.workspaceId, agentId, patch.helperAgentIds, helpersBefore);
  const helpersChanged = helpers.join() !== helpersBefore.join();
  if (!Object.keys(set).length && !helpersChanged) return viewAgent(current, level);
  const updated = await db.transaction(async (tx) => {
    if (helpersChanged) await saveHelpers(tx, agentId, helpers);
    if (!Object.keys(set).length) return current;
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
    details: {
      ...auditDetails(updated),
      previous: auditDetails(current),
      instructionsChanged: patch.instructions !== undefined || undefined,
      ...(helpersChanged ? { helpers, previousHelpers: helpersBefore } : {}),
    },
  });
  await recordAgentVersion(userId, agentId);
  return viewAgent(updated, level);
}

/**
 * Archives an agent: it stops (its waiting runs end as paused), loses every page shared with it,
 * and leaves the lists. Its user stays, so its edits and comments keep its name.
 */
export async function archiveAgent(userId: string, agentId: string): Promise<AgentView> {
  const { agent: current } = await agentWithLevel(userId, agentId, "full");
  if (current.archivedAt) return viewAgent(current, "full");
  const archived = await db.transaction(async (tx) => {
    const [agent] = await tx
      .update(workspaceAgent)
      .set({ archivedAt: new Date(), enabled: false })
      .where(eq(workspaceAgent.id, agentId))
      .returning();
    const removed = await tx
      .delete(pagePermission)
      .where(eq(pagePermission.userId, current.userId))
      .returning({ pageId: pagePermission.pageId, level: pagePermission.level });
    for (const { pageId, level } of removed) {
      await recordAudit(
        {
          workspaceId: current.workspaceId,
          actorId: userId,
          action: "page.permission_removed",
          target: { type: "page", id: pageId },
          subject: { type: "user", id: current.userId },
          details: { previous: level },
        },
        tx,
      );
    }
    await tx.delete(agentDatabaseShare).where(eq(agentDatabaseShare.agentId, agentId));
    // Other agents can no longer ask it.
    await dropHelper(tx, agentId);
    return agent;
  });
  await recordAudit({ workspaceId: current.workspaceId, actorId: userId, action: "agent.archived", target: { type: "user", id: current.userId, label: current.name }, details: auditDetails(archived) });
  return viewAgent(archived, "full");
}

/** Brings an archived agent back, paused and with nothing shared with it. */
export async function restoreAgent(userId: string, agentId: string): Promise<AgentView> {
  const { agent: current } = await agentWithLevel(userId, agentId, "full");
  if (!current.archivedAt) return viewAgent(current, "full");
  const [{ n }] = await db
    .select({ n: count() })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, current.workspaceId), isNull(workspaceAgent.archivedAt)));
  if (n >= MAX_AGENTS) throw new AgentError("tooMany", `A workspace has at most ${MAX_AGENTS} agents`, { max: String(MAX_AGENTS) });
  const [restored] = await db.update(workspaceAgent).set({ archivedAt: null, enabled: false }).where(eq(workspaceAgent.id, agentId)).returning();
  await recordAudit({ workspaceId: current.workspaceId, actorId: userId, action: "agent.updated", target: { type: "user", id: current.userId, label: current.name }, details: { ...auditDetails(restored), restored: true } });
  return viewAgent(restored, "full");
}

// ------------------------------------------------------------------------------------ access

/**
 * The pages shared with an agent that the person asking can open themselves (pages they can't
 * open are only counted, the way other lists keep restricted pages out of sight).
 */
export async function listAgentAccess(userId: string, agentId: string): Promise<{ pages: AgentAccessView[]; hidden: number }> {
  const agent = await agentFor(userId, agentId, "interact");
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
 * Shares a page (and the pages and rows under it) with an agent, for those who can edit the agent.
 * They need full access to the page, as for sharing it with anyone. Rows are reached through their database: an agent
 * reads and changes a row only with access to its database too.
 */
export async function setAgentAccess(userId: string, agentId: string, pageId: string, level: AgentAccessLevel) {
  const agent = await agentFor(userId, agentId, "edit");
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to share pages with it");
  if (!isAgentAccessLevel(level)) throw new AgentError("invalid", "An agent can view, comment on or edit a page", { reason: "level" });
  const { page: found } = await pageAccessOf(userId, pageId);
  if (!found || found.workspaceId !== agent.workspaceId) throw new AgentError("notAPage", "Page not found");
  await setPagePermission(userId, pageId, agent.userId, level);
  // Someone set it: it's theirs now, no longer taken back with the automations.
  await forgetDatabaseShare(agent.id, pageId);
}

export async function removeAgentAccess(userId: string, agentId: string, pageId: string) {
  const agent = await agentFor(userId, agentId, "edit");
  await removePagePermission(userId, pageId, agent.userId);
  await forgetDatabaseShare(agent.id, pageId);
}

const forgetDatabaseShare = (agentId: string, databaseId: string) =>
  db.delete(agentDatabaseShare).where(and(eq(agentDatabaseShare.agentId, agentId), eq(agentDatabaseShare.databaseId, databaseId)));

/**
 * Gives agents edit access to a database automations run them on, unless they have it already,
 * remembering that an automation gave it (see agentDatabaseShare). `userId` saves the automation,
 * so they have full access to the database.
 */
export async function shareDatabaseWithAgents(userId: string, databaseId: string, agentIds: string[]) {
  if (!agentIds.length) return;
  const agents = await db.select({ id: workspaceAgent.id, userId: workspaceAgent.userId }).from(workspaceAgent).where(inArray(workspaceAgent.id, agentIds));
  for (const agent of agents) {
    const { level } = await pageAccessOf(agent.userId, databaseId);
    if (level === "edit" || level === "full") continue;
    const [own] = await db
      .select({ level: pagePermission.level })
      .from(pagePermission)
      .where(and(eq(pagePermission.pageId, databaseId), eq(pagePermission.userId, agent.userId)));
    // An automation's share isn't part of the agent's setup (see version-record.ts).
    await withoutVersions(() => setPagePermission(userId, databaseId, agent.userId, "edit"));
    await db
      .insert(agentDatabaseShare)
      .values({ agentId: agent.id, databaseId, previousLevel: own && isAgentAccessLevel(own.level) ? own.level : null })
      .onConflictDoNothing();
  }
}

/**
 * Takes back the edit access automations gave agents on a database (see shareDatabaseWithAgents)
 * once no automation of the database runs them: their own entry goes back to what it was before.
 * Shares an owner set in the agent's settings stay. `userId` changes or deletes the automation, so
 * they have full access to the database.
 */
export async function releaseDatabaseFromAgents(userId: string, databaseId: string, agentIds: string[]) {
  if (!agentIds.length) return;
  const shares = await db
    .select({ agentId: agentDatabaseShare.agentId, previousLevel: agentDatabaseShare.previousLevel, agentUserId: workspaceAgent.userId })
    .from(agentDatabaseShare)
    .innerJoin(workspaceAgent, eq(workspaceAgent.id, agentDatabaseShare.agentId))
    .where(and(eq(agentDatabaseShare.databaseId, databaseId), inArray(agentDatabaseShare.agentId, agentIds)));
  if (!shares.length) return;
  // The database's own automations, and those of other databases that go over its rows.
  const automations = await db
    .select({ databaseId: databaseAutomation.databaseId, actions: databaseAutomation.actions })
    .from(databaseAutomation)
    .where(or(eq(databaseAutomation.databaseId, databaseId), sql`${databaseAutomation.actions}::text like ${`%${databaseId}%`}`));
  const stillRun = new Set(
    automations.flatMap((a) => agentTargets(a.actions, a.databaseId).flatMap((t) => (t.databaseId === databaseId ? [t.agentId] : []))),
  );
  for (const share of shares) {
    if (stillRun.has(share.agentId)) continue;
    await withoutVersions(() =>
      share.previousLevel ? setPagePermission(userId, databaseId, share.agentUserId, share.previousLevel) : removePagePermission(userId, databaseId, share.agentUserId),
    );
    await forgetDatabaseShare(share.agentId, databaseId);
  }
}

// -------------------------------------------------------------------------------------- runs

/**
 * SQL: runs `userId` started themselves (asked for, scheduled, mentioned the agent in, chatted):
 * all of an agent's runs that someone who can only interact with it sees.
 */
export const startedBy = (userId: string) =>
  sql`(${agentRun.source}->>'requestedBy' = ${userId} or ${agentRun.source}->>'scheduledBy' = ${userId} or ${agentRun.source}->>'mentionedBy' = ${userId} or (${agentRun.source}->>'kind' = 'chat' and ${agentRun.source}->>'userId' = ${userId}))`;

/**
 * An agent's latest runs, newest first: all of them for those who can edit it, only their own for
 * those who can only interact with it; what each run did as viewRuns shows it to them. `exact`: a
 * waiting call's input as it will be sent, for the app's runs, where an owner approves it;
 * otherwise (MCP, which can't approve, and anyone but an owner) masked.
 */
export async function listAgentRuns(userId: string, agentId: string, limit = 30, { exact = false }: { exact?: boolean } = {}): Promise<AgentRunView[]> {
  const { agent, level, owner } = await agentWithLevel(userId, agentId, "interact");
  const runs = await db
    .select()
    .from(agentRun)
    .where(and(eq(agentRun.agentId, agent.id), level === "interact" ? startedBy(userId) : undefined))
    .orderBy(desc(agentRun.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return viewRuns(userId, runs, { exact: exact && owner, owner });
}

/** One of an agent's runs, as listAgentRuns shows it. */
export async function getAgentRun(userId: string, agentId: string, runId: string, { exact = false }: { exact?: boolean } = {}): Promise<AgentRunView> {
  const { agent, level, owner } = await agentWithLevel(userId, agentId, "interact");
  const [run] = await db
    .select()
    .from(agentRun)
    .where(and(eq(agentRun.id, runId), eq(agentRun.agentId, agent.id), level === "interact" ? startedBy(userId) : undefined))
    .limit(1);
  if (!run) throw new AgentError("notFound", "Run not found");
  return (await viewRuns(userId, [run], { exact: exact && owner, owner }))[0];
}

/** Runs as `userId` may see them (see listAgentRuns); `owner`: they own the workspace. */
export async function viewRuns(userId: string, runs: (typeof agentRun.$inferSelect)[], { exact, owner }: { exact: boolean; owner: boolean }): Promise<AgentRunView[]> {
  // A helper's run shows as the run that asked it does (accessSource): its row or database counts.
  const rowIds = [
    ...new Set(
      runs.flatMap((r) => {
        const source = accessSource(r.source);
        return isRowRun(source) ? [source.rowId] : [];
      }),
    ),
  ];
  const titles = new Map<string, string>();
  if (rowIds.length) {
    const rows = await db
      .select({ id: page.id, title: page.title })
      .from(page)
      .where(and(inArray(page.id, rowIds), pageVisibleTo(userId)));
    for (const row of rows) titles.set(row.id, row.title);
  }
  // Skills are named only to those who may open them.
  const skillIds = [...new Set(runs.flatMap((r) => r.steps.flatMap((s) => (s.kind === "skill" ? [s.pageId] : []))))];
  const openSkills = new Set(
    skillIds.length ? (await db.select({ id: page.id }).from(page).where(and(inArray(page.id, skillIds), pageVisibleTo(userId)))).map((p) => p.id) : [],
  );
  const connectionIds = [
    ...new Set(
      runs.flatMap((r) => [
        ...(r.pending?.connectionId ? [r.pending.connectionId] : []),
        ...(isEventRun(r.source) ? [r.source.connectionId] : []),
        ...r.steps.flatMap((s) => (s.kind === "tool" && s.connectionId ? [s.connectionId] : [])),
      ]),
    ),
  ];
  const connectionNames = new Map(
    connectionIds.length ? (await db.select({ id: connection.id, name: connection.name }).from(connection).where(inArray(connection.id, connectionIds))).map((c) => [c.id, c.name]) : [],
  );
  // A schedule's run on a database: its title, and what the run read and wrote, only for those who can open it.
  const scheduledDatabaseIds = [
    ...new Set(
      runs.flatMap((r) => {
        const source = accessSource(r.source);
        return isScheduleRun(source) && source.databaseId ? [source.databaseId] : [];
      }),
    ),
  ];
  const databaseTitles = new Map(
    scheduledDatabaseIds.length
      ? (await db.select({ id: page.id, title: page.title }).from(page).where(and(inArray(page.id, scheduledDatabaseIds), pageVisibleTo(userId)))).map((d) => [d.id, d.title])
      : [],
  );
  // A mention's run: the page its comment is on, and what the run read and wrote, only for those who can open it.
  const mentionPageIds = [
    ...new Set(
      runs.flatMap((r) => {
        const source = accessSource(r.source);
        return isMentionRun(source) ? [source.pageId] : [];
      }),
    ),
  ];
  const mentionTitles = new Map(
    mentionPageIds.length
      ? (await db.select({ id: page.id, title: page.title }).from(page).where(and(inArray(page.id, mentionPageIds), pageVisibleTo(userId)))).map((p) => [p.id, p.title])
      : [],
  );
  // A schedule removed since keeps its runs; they just no longer name it.
  const scheduleIds = [...new Set(runs.flatMap((r) => (isScheduleRun(r.source) ? [r.source.scheduleId] : [])))];
  const liveSchedules = new Set(
    scheduleIds.length ? (await db.select({ id: schedule.id }).from(schedule).where(inArray(schedule.id, scheduleIds))).map((s) => s.id) : [],
  );
  const requesterIds = [
    ...new Set(
      runs.flatMap((r) =>
        r.source.kind === "request"
          ? [r.source.requestedBy]
          : r.source.kind === "schedule"
            ? [r.source.scheduledBy]
            : r.source.kind === "mention"
              ? [r.source.mentionedBy]
              : r.source.kind === "chat"
                ? [r.source.userId]
                : [],
      ),
    ),
  ];
  const requesters = new Map(
    requesterIds.length ? (await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, requesterIds))).map((u) => [u.id, u.name]) : [],
  );
  // The agents that asked for runs (handoff.ts), by name.
  const askerIds = [...new Set(runs.flatMap((r) => (r.source.kind === "handoff" ? [r.source.fromAgentId] : [])))];
  const askers = new Map(
    askerIds.length ? (await db.select({ id: workspaceAgent.id, name: workspaceAgent.name }).from(workspaceAgent).where(inArray(workspaceAgent.id, askerIds))).map((a) => [a.id, a.name]) : [],
  );
  // What a run did can quote pages the agent may open and the viewer may not: it, and the call it
  // waits on, are for the owners ownerSeesRun names, the same ones the inbox asks to answer the call
  // (connections/approvals).
  const visible = (r: (typeof runs)[number]) => {
    const pageId = runPageOf(r.source);
    const source = accessSource(r.source);
    // A connection's event is the owners' (ownerSeesRun), and so is the run it started: someone who
    // may edit the agent without owning the workspace lists it, but not what it read or would send.
    if (!owner && isEventRun(source)) return false;
    return ownerSeesRun(r.source, userId, pageId !== null && (isRowRun(source) ? titles : isMentionRun(source) ? mentionTitles : databaseTitles).has(pageId));
  };
  return runs.map((r) => {
    const open = visible(r);
    return {
      id: r.id,
      status: r.status,
      code: r.code ?? null,
      error: open ? r.error : null,
      source: r.source,
      rowTitle: isRowRun(r.source) ? (titles.get(r.source.rowId) ?? null) : null,
      steps: open ? r.steps.map((s) => (s.kind === "skill" && !openSkills.has(s.pageId) ? { ...s, title: "" } : s)) : [],
      answer: open ? r.answer : "",
      usage: r.usage,
      pending:
        open && r.pending
          ? {
              ...r.pending,
              arguments: (exact && callToSend(r.pending, r.state?.queue)) || r.pending.arguments,
              connectionName: callConnectionName(r.pending.connectionId, connectionNames),
            }
          : null,
      eventType: "eventType" in r.context ? r.context.eventType : null,
      request:
        r.source.kind === "request"
          ? { by: r.source.requestedBy, byName: requesters.get(r.source.requestedBy) ?? "", via: r.source.via, task: open ? r.prompt : "" }
          : null,
      chat: r.source.kind === "chat" ? { by: r.source.userId, byName: requesters.get(r.source.userId) ?? "", message: open ? r.prompt : "" } : null,
      schedule: isScheduleRun(r.source)
        ? {
            id: liveSchedules.has(r.source.scheduleId) ? r.source.scheduleId : "",
            by: r.source.scheduledBy,
            byName: requesters.get(r.source.scheduledBy) ?? "",
            task: open ? r.prompt : "",
            databaseId: r.source.databaseId ?? null,
            databaseTitle: r.source.databaseId ? (databaseTitles.get(r.source.databaseId) ?? "") : "",
          }
        : null,
      mention: isMentionRun(r.source)
        ? {
            by: r.source.mentionedBy,
            byName: requesters.get(r.source.mentionedBy) ?? "",
            pageId: r.source.pageId,
            threadId: r.source.threadId,
            pageTitle: mentionTitles.get(r.source.pageId) ?? null,
            task: open ? r.prompt : "",
          }
        : null,
      handoff:
        r.source.kind === "handoff"
          ? { fromAgentId: r.source.fromAgentId, fromName: askers.get(r.source.fromAgentId) ?? "", parentRunId: r.source.parentRunId, task: open ? r.prompt : "" }
          : null,
      connections: Object.fromEntries(connectionIds.filter((id) => connectionNames.has(id)).map((id) => [id, connectionNames.get(id)!])),
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}
