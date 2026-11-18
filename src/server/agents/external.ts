/**
 * Outside agents: Claude Code, Cursor or any MCP client treated as a teammate. An agent of kind
 * `external` (workspace_agent.kind) is a user of its own like every agent (a guest that sees only
 * what is shared with it, whose changes and comments show its name), but it never runs in Leafdesk:
 * it asks for its work (`list_assigned_work`, REST `GET /assigned-work`) and reports it
 * (`update_assigned_work`, `PATCH /assigned-work`). Its work is the rows whose person properties name
 * it (a person value may name an outside agent, see external-people.ts) and the comments that
 * mention it and wait for it (external-mentions.ts).
 *
 * How a caller proves it is "acting as" the agent. Never by naming the agent: the caller is what the
 * server verified, and the agent follows from a binding made in Agents by someone with full access to
 * it (`external_agent_binding`), one of
 *  - a connected MCP app: the pair of the person and the OAuth client they connected (never the
 *    client alone, since clients with URL ids are shared by everyone). It holds while the person is
 *    still a member who may edit the agent, their consent for the app is the one that predates the
 *    binding (revoking the app and connecting it again ends it) and the workspace lets the
 *    person's connected apps in (the person's own connected-apps hold, access.ts connectedAppHold,
 *    applies first);
 *  - a token of its own: an API token made for the agent's user with only the scopes the work needs,
 *    so the REST API answers as the agent and nothing of anyone's. Revoked with the agent.
 * A caller bound to several agents (an app can be) names one of them; naming one it isn't bound to
 * reads like an agent that doesn't exist (lib/external-agents.ts chooseBinding).
 *
 * Writes run as the agent's user, so they are limited to what was shared with it, and the activity
 * of rows, comments and history show the agent. A connected MCP app that is bound keeps acting as its
 * person with every other tool; only the two work tools act as the agent.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiToken, externalAgentBinding, externalAgentMention, oauthClient, oauthConsent, page, rowActivity, user, workspaceAgent } from "@/db/schema";
import { chooseBinding, consentHolds, MAX_ASSIGNED_WORK, MAX_WORK_COMMENT } from "@/lib/external-agents";
import { type AgentView } from "@/lib/agents";
import { hasAgentLevel } from "@/lib/agent-sharing";
import { atLeast } from "@/lib/property-access";
import { optionOf } from "@/lib/properties";
import { connectedAppHold, findMembership, isGuest, pageVisibleTo, requirePageAccess } from "@/server/access";
import { openAssignedRows } from "@/server/assigned";
import { recordAudit } from "@/server/audit";
import { changeComments } from "@/server/comments";
import { updateRowProperties } from "@/server/databases";
import { loadProperties } from "@/server/derived";
import { generateTokenSecret, hashToken, TOKEN_PREFIX } from "@/server/api/tokens";
import { listConnectedApps } from "@/server/mcp/grants";
import { propertyAccessFor } from "@/server/property-access";
import { AgentError } from "./errors";
import { ExternalAgentError, type ExternalAgentErrorCode } from "./external-error";
import { agentLevels, agentWithLevel } from "./sharing";
import { createAgent } from "./manage";
import { dropExternalBinding } from "./external-binding";

type Agent = typeof workspaceAgent.$inferSelect;
type Prop = (Awaited<ReturnType<typeof loadProperties>> extends Map<string, (infer P)[]> ? P : never);
type Binding = typeof externalAgentBinding.$inferSelect;

/** What the server verified about whoever is calling: a connected MCP app's user and client, or an agent token. */
export type ExternalCaller =
  | { kind: "app"; userId: string; clientId: string }
  | { kind: "token"; userId: string; tokenId: string; workspaceId: string | null };

export { ExternalAgentError, type ExternalAgentErrorCode };

/** The scopes of an agent's own token: its work, and the rest of what the agent may read and write of the workspace. */
export const AGENT_TOKEN_SCOPES = [
  "workspaces:read",
  "pages:read",
  "pages:write",
  "search:read",
  "databases:read",
  "rows:read",
  "rows:write",
  "comments:read",
  "comments:write",
] as const;

// -------------------------------------------------------------------------------------- making

export type ExternalAgentInput = {
  name: string;
  icon?: string | null;
  description?: string;
  /** What it is reached through: one of the maker's connected apps, or a token of its own (shown once). */
  via: { kind: "app"; clientId: string } | { kind: "token" };
};

/**
 * Makes an outside agent (as createAgent does, shared with the workspace's people at interact level and
 * with its maker at full access) and binds it. A connected app is the maker's own; the new token's
 * secret is returned once.
 */
export async function createExternalAgent(userId: string, workspaceId: string, input: ExternalAgentInput): Promise<{ agent: AgentView; secret: string | null }> {
  // Checked first, so a refused binding leaves no agent behind.
  if (input.via.kind === "app") await requireOwnApp(userId, input.via.clientId);
  const agent = await createAgent(userId, workspaceId, { kind: "external", name: input.name, icon: input.icon, description: input.description });
  const secret = await bind(userId, agent.id, input.via);
  return { agent, secret };
}

/**
 * Binds the agent to one of the person's connected apps, or gives it a new token (the old one is
 * revoked): for those with full access to it. The person bound is the one acting, never someone else.
 * Returns the new token's secret, once, or null.
 */
export async function bindExternalAgent(userId: string, agentId: string, via: ExternalAgentInput["via"]): Promise<string | null> {
  await agentWithLevel(userId, agentId, "full");
  return bind(userId, agentId, via);
}

async function requireOwnApp(userId: string, clientId: string) {
  const [client] = await db.select({ disabled: oauthClient.disabled, skipConsent: oauthClient.skipConsent }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  // The server's own clients skip consent: no person connected them, so none is bound.
  if (!client || client.disabled || client.skipConsent) throw new AgentError("bindingInvalid", "Choose one of your connected apps");
  const apps = await listConnectedApps(userId);
  if (!apps.some((a) => a.clientId === clientId)) throw new AgentError("bindingInvalid", "Choose one of your connected apps");
}

async function bind(userId: string, agentId: string, via: ExternalAgentInput["via"]): Promise<string | null> {
  const { agent } = await agentWithLevel(userId, agentId, "full");
  if (agent.kind !== "external") throw new AgentError("bindingInvalid", "Only an outside agent is bound to an app or a token");
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to change it");
  if (via.kind === "app") await requireOwnApp(userId, via.clientId);
  let secret: string | null = null;
  await db.transaction(async (tx) => {
    // The token it had, if any, goes with its binding.
    await dropExternalBinding(tx, agentId);
    if (via.kind === "app") {
      await tx.insert(externalAgentBinding).values({ agentId, workspaceId: agent.workspaceId, userId, clientId: via.clientId, boundBy: userId });
      return;
    }
    secret = generateTokenSecret();
    const [token] = await tx
      .insert(apiToken)
      .values({
        userId: agent.userId,
        name: agent.name,
        prefix: secret.slice(0, TOKEN_PREFIX.length + 4),
        tokenHash: hashToken(secret),
        scopes: [...AGENT_TOKEN_SCOPES],
        workspaceId: agent.workspaceId,
      })
      .returning({ id: apiToken.id });
    await tx.insert(externalAgentBinding).values({ agentId, workspaceId: agent.workspaceId, userId: agent.userId, tokenId: token.id, boundBy: userId });
  });
  await recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.updated",
    target: { type: "user", id: agent.userId, label: agent.name },
    details: { kind: "external", boundTo: via.kind === "app" ? "app" : "token", ...(via.kind === "app" ? { clientId: via.clientId } : {}) },
  });
  return secret;
}

/** Unbinds the agent (and revokes its token): the app or token that reached it asks for nothing more. */
export async function unbindExternalAgent(userId: string, agentId: string): Promise<void> {
  const { agent } = await agentWithLevel(userId, agentId, "full");
  if (agent.kind !== "external") return;
  const was = await dropExternalBinding(db, agentId);
  if (was) {
    await recordAudit({
      workspaceId: agent.workspaceId,
      actorId: userId,
      action: "agent.updated",
      target: { type: "user", id: agent.userId, label: agent.name },
      details: { kind: "external", boundTo: null },
    });
  }
}

// ----------------------------------------------------------------------------------- resolving

type Bound = { agent: Agent; binding: Binding };

/**
 * The agents this caller is bound to as of now: live outside agents (not archived, on) whose binding
 * still holds (see the module's top). Nothing else is believed.
 */
async function liveBindings(caller: ExternalCaller): Promise<Bound[]> {
  const mine =
    caller.kind === "app"
      ? and(eq(externalAgentBinding.userId, caller.userId), eq(externalAgentBinding.clientId, caller.clientId))
      : and(eq(externalAgentBinding.userId, caller.userId), eq(externalAgentBinding.tokenId, caller.tokenId));
  const rows = await db
    .select({ binding: externalAgentBinding, agent: workspaceAgent })
    .from(externalAgentBinding)
    .innerJoin(workspaceAgent, eq(workspaceAgent.id, externalAgentBinding.agentId))
    .where(and(mine, eq(workspaceAgent.kind, "external"), eq(workspaceAgent.enabled, true), isNull(workspaceAgent.archivedAt)));
  const live: Bound[] = [];
  for (const row of rows) if (await bindingHolds(caller, row)) live.push(row);
  return live;
}

/** Whether one binding holds for the caller now; `caller` is the one the binding was found for. */
async function bindingHolds(caller: ExternalCaller, { agent, binding }: Bound): Promise<boolean> {
  if (caller.kind === "token") {
    if (!binding.tokenId || binding.tokenId !== caller.tokenId) return false;
    // A token of one workspace reaches only its own; the agent's user is the token's (made with the binding).
    return !caller.workspaceId || caller.workspaceId === agent.workspaceId;
  }
  if (!binding.clientId || binding.clientId !== caller.clientId || binding.userId !== caller.userId) return false;
  const membership = await findMembership(caller.userId, agent.workspaceId);
  if (!membership || isGuest(membership.role)) return false;
  // Someone who may no longer edit the agent doesn't act as it.
  const level = (await agentLevels(caller.userId, agent.workspaceId, [agent.id], membership.role)).get(agent.id) ?? "none";
  if (!hasAgentLevel(level, "edit")) return false;
  const [client] = await db.select({ disabled: oauthClient.disabled, skipConsent: oauthClient.skipConsent }).from(oauthClient).where(eq(oauthClient.clientId, caller.clientId)).limit(1);
  if (!client || client.disabled || client.skipConsent) return false;
  const [consent] = await db
    .select({ createdAt: oauthConsent.createdAt })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, caller.userId), eq(oauthConsent.clientId, caller.clientId)))
    .limit(1);
  return consentHolds(binding.boundAt, consent?.createdAt ?? null);
}

/**
 * The agent the caller acts as. `requested` (an agent id the caller names) only picks among the
 * agents it is bound to; one it isn't bound to is refused as `notBound`. For an app of a person, the
 * workspace's connected-apps setting applies to them first (a workspace turned off, or read-only
 * for a write, refuses: `writing` is the tool's own).
 */
export async function resolveExternalAgent(caller: ExternalCaller, requested?: string | null): Promise<Bound> {
  const bound = await liveBindings(caller);
  const choice = chooseBinding(
    bound.map((b) => ({ agentId: b.agent.id, bound: b })),
    requested,
  );
  if (!choice.ok) {
    throw new ExternalAgentError(
      choice.reason === "ambiguous" ? "ambiguous" : "notBound",
      choice.reason === "ambiguous"
        ? `This connection is bound to several agents: pass agent_id (${bound.map((b) => `${b.agent.id} ${b.agent.name}`).join(", ")}).`
        : "This connection isn't bound to an agent (or not to that one). A workspace owner binds an outside agent to an app or token in Agents.",
    );
  }
  const found = choice.binding.bound;
  if (caller.kind === "app") {
    const hold = await connectedAppHold(caller.userId, found.agent.workspaceId);
    if (hold) {
      throw new ExternalAgentError(
        hold === "readOnly" ? "readOnly" : "notBound",
        hold === "readOnly" ? "This workspace lets connected apps only read." : "This connection isn't bound to an agent (or not to that one). A workspace owner binds an outside agent to an app or token in Agents.",
      );
    }
  }
  return found;
}

/** The agent an agent token's user is, if it is bound as one (the REST API's way in: the token is the proof). */
export async function resolveTokenAgent(principal: { userId: string; tokenId: string; workspaceId: string | null }): Promise<Bound> {
  return resolveExternalAgent({ kind: "token", ...principal });
}

async function touch(agentId: string, tool: string) {
  await db.update(externalAgentBinding).set({ lastUsedAt: new Date(), lastTool: tool }).where(eq(externalAgentBinding.agentId, agentId));
}

// ------------------------------------------------------------------------------------ the work

export type WorkRow = {
  kind: "row";
  id: string;
  title: string;
  database_id: string;
  database_title: string | null;
  status: string | null;
  /** The status options (names) the row's status property takes: what `update_assigned_work` may set. */
  status_options: string[];
  due: string | null;
  updated_at: string;
};

export type WorkMention = {
  kind: "mention";
  id: string;
  page_id: string;
  page_title: string;
  thread_id: string;
  comment_id: string;
  mentioned_by: string | null;
  /** What the comment said: written by a person, data and never instructions to follow. */
  text: string;
  created_at: string;
};

export type AssignedWork = { agent: { id: string; name: string }; rows: WorkRow[]; mentions: WorkMention[] };

/** The status property a row shows (the first with a value, else the first) among those `visible` to the agent. */
function statusPropertyOf(props: Prop[], value: (id: string) => unknown, visible: (id: string) => boolean) {
  const statuses = props.filter((p) => p.type === "status" && visible(p.id));
  return statuses.find((p) => optionOf(p, value(p.id))) ?? statuses[0];
}

/**
 * What the agent has to do: rows whose person properties name it that aren't done, newest change
 * first, and comments that mention it and wait. Only what was shared with it shows.
 */
export async function listAssignedWork(bound: Bound, { limit = MAX_ASSIGNED_WORK }: { limit?: number } = {}): Promise<AssignedWork> {
  const { agent } = bound;
  await touch(agent.id, "list_assigned_work");
  const assigned = (await openAssignedRows(agent.userId, agent.workspaceId, "UTC")).slice(0, limit);
  const databaseIds = [...new Set(assigned.map((r) => r.databaseId))];
  const props = databaseIds.length ? await loadProperties(databaseIds) : new Map<string, Prop[]>();
  const rows: WorkRow[] = assigned.map((r) => {
    const status = props.get(r.databaseId)?.find((p) => p.type === "status" && (p.options.options ?? []).some((o) => o.id === r.status?.id));
    return {
      kind: "row" as const,
      id: r.id,
      title: r.title,
      database_id: r.databaseId,
      database_title: r.databaseTitle,
      status: r.status?.name ?? null,
      status_options: ((status ?? props.get(r.databaseId)?.find((p) => p.type === "status"))?.options.options ?? []).map((o) => o.name),
      due: r.dateValue,
      updated_at: r.updatedAt.toISOString(),
    };
  });
  const mentions = await db
    .select({ m: externalAgentMention, title: page.title, by: user.name })
    .from(externalAgentMention)
    .innerJoin(page, eq(page.id, externalAgentMention.pageId))
    .leftJoin(user, eq(user.id, externalAgentMention.mentionedBy))
    .where(and(eq(externalAgentMention.agentId, agent.id), isNull(externalAgentMention.handledAt), isNull(page.archivedAt), pageVisibleTo(agent.userId)))
    .orderBy(desc(externalAgentMention.createdAt))
    .limit(limit);
  return {
    agent: { id: agent.id, name: agent.name },
    rows,
    mentions: mentions.map(({ m, title, by }) => ({
      kind: "mention" as const,
      id: m.id,
      page_id: m.pageId,
      page_title: title,
      thread_id: m.threadId,
      comment_id: m.commentId,
      mentioned_by: by,
      text: m.excerpt,
      created_at: m.createdAt.toISOString(),
    })),
  };
}

export type WorkUpdate = {
  /** A row from the list: set its status and/or comment on it. */
  row_id?: string;
  /** A mention from the list: mark it handled (default) or open again, and/or reply in its thread. */
  mention_id?: string;
  /** A status option's name (see `status_options`). */
  status?: string;
  comment?: string;
  /** For a mention: false opens it again. */
  handled?: boolean;
};

export type WorkUpdated = { row_id?: string; mention_id?: string; status?: string | null; commented: boolean; handled?: boolean };

/**
 * Changes one item of the agent's work, as the agent: a row's status and a comment on it, or a
 * mention marked handled with an optional reply. Refuses a row that doesn't name the agent (the
 * tool isn't a way to edit any row), and what the agent may not edit.
 */
export async function updateAssignedWork(bound: Bound, update: WorkUpdate): Promise<WorkUpdated> {
  const { agent } = bound;
  const target = [update.row_id, update.mention_id].filter((v) => v !== undefined);
  if (target.length !== 1) throw new ExternalAgentError("invalid", "Pass row_id or mention_id, one of them.");
  const comment = update.comment?.trim();
  if (comment !== undefined && (!comment || comment.length > MAX_WORK_COMMENT)) throw new ExternalAgentError("invalid", `A comment is 1 to ${MAX_WORK_COMMENT} characters.`);
  await touch(agent.id, "update_assigned_work");

  if (update.mention_id !== undefined) {
    const [mention] = await db
      .select()
      .from(externalAgentMention)
      .where(and(eq(externalAgentMention.id, update.mention_id), eq(externalAgentMention.agentId, agent.id)))
      .limit(1);
    if (!mention) throw new ExternalAgentError("noMention", "No such mention in your work. list_assigned_work lists them.");
    if (update.status !== undefined) throw new ExternalAgentError("invalid", "A mention has no status: pass comment and/or handled.");
    if (comment) await changeComments(agent.userId, mention.pageId, { type: "addComment", threadId: mention.threadId, body: comment });
    const handled = update.handled !== false;
    await db
      .update(externalAgentMention)
      .set({ handledAt: handled ? new Date() : null, handledBy: handled ? agent.userId : null })
      .where(eq(externalAgentMention.id, mention.id));
    return { mention_id: mention.id, commented: Boolean(comment), handled };
  }

  if (update.handled !== undefined) throw new ExternalAgentError("invalid", "handled is for a mention.");
  if (update.status === undefined && !comment) throw new ExternalAgentError("invalid", "Pass status and/or comment.");
  const rowId = update.row_id!;
  const row = await requirePageAccess(agent.userId, rowId, "view");
  if (!row.parentId || row.archivedAt) throw new ExternalAgentError("notAssigned", "That isn't a row assigned to you.");
  const props = (await loadProperties([row.parentId])).get(row.parentId) ?? [];
  const levels = await propertyAccessFor(agent.userId, row.parentId);
  const visible = (id: string) => atLeast(levels.levelOf(id, row), "view");
  const value = (id: string) => row.properties[id];
  const named = props.some((p) => p.type === "person" && visible(p.id) && Array.isArray(value(p.id)) && (value(p.id) as unknown[]).includes(agent.userId));
  if (!named) throw new ExternalAgentError("notAssigned", "That row isn't assigned to you: only rows that name you in a person property are yours to change.");

  let status: string | null | undefined;
  if (update.status !== undefined) {
    const statusProp = statusPropertyOf(props, value, visible);
    if (!statusProp) throw new ExternalAgentError("noStatus", "This row's database has no status property you may see.");
    const wanted = update.status.trim().toLowerCase();
    const options = statusProp.options.options ?? [];
    const option = options.find((o) => o.id === update.status || o.name.trim().toLowerCase() === wanted);
    if (!option) throw new ExternalAgentError("unknownStatus", `"${update.status}" isn't a status of "${statusProp.name}". Options: ${options.map((o) => o.name).join(", ")}.`);
    if (value(statusProp.id) !== option.id) await updateRowProperties(agent.userId, rowId, { [statusProp.id]: option.id });
    status = option.name;
  }
  if (comment) await changeComments(agent.userId, rowId, { type: "createThread", body: comment });
  return { row_id: rowId, ...(status !== undefined ? { status } : {}), commented: Boolean(comment) };
}

// -------------------------------------------------------------------------------- the agent's page

export type ExternalAgentOverview = {
  binding: {
    via: "app" | "token";
    /** The app's name, or the token's. */
    name: string;
    /** The person whose app it is; null for a token of its own. */
    person: string | null;
    boundAt: string;
    lastUsedAt: string | null;
    lastTool: string | null;
    /** The binding holds now (a person who left, or an app revoked since, ends it). */
    holds: boolean;
  } | null;
  work: { id: string; title: string; databaseTitle: string | null; status: string | null; updatedAt: string }[];
  /** Mentions waiting, as many as the viewer may open the page of. */
  mentions: { id: string; pageId: string; pageTitle: string; text: string; createdAt: string }[];
  /** The agent's latest changes to rows the viewer may open. */
  activity: { rowId: string; title: string; at: string }[];
};

/**
 * An outside agent's page: how it is reached, what it has in hand and what it did last, for someone it
 * is shared with. What the agent's work shows is cut to what the viewer may open themselves.
 */
export async function externalAgentOverview(viewerId: string, agentId: string): Promise<ExternalAgentOverview> {
  const { agent, level } = await agentWithLevel(viewerId, agentId, "interact");
  if (agent.kind !== "external") throw new AgentError("notFound", "Agent not found");
  // Whose app or token reaches the agent is for those who may change it.
  const [binding] = hasAgentLevel(level, "edit") ? await db.select().from(externalAgentBinding).where(eq(externalAgentBinding.agentId, agentId)) : [];
  let bindingView: ExternalAgentOverview["binding"] = null;
  if (binding) {
    let name = agent.name;
    let person: string | null = null;
    let holds = false;
    if (binding.clientId) {
      const [owner] = await db.select({ name: user.name }).from(user).where(eq(user.id, binding.userId));
      person = owner?.name ?? null;
      const apps = await listConnectedApps(binding.userId);
      name = apps.find((a) => a.clientId === binding.clientId)?.name ?? binding.clientId;
      holds = enabledAndLive(agent) && (await bindingHolds({ kind: "app", userId: binding.userId, clientId: binding.clientId }, { agent, binding }));
    } else if (binding.tokenId) {
      const [token] = await db.select({ name: apiToken.prefix }).from(apiToken).where(eq(apiToken.id, binding.tokenId));
      name = token ? `${token.name}…` : name;
      holds = enabledAndLive(agent) && Boolean(token);
    }
    bindingView = {
      via: binding.clientId ? "app" : "token",
      name,
      person,
      boundAt: binding.boundAt.toISOString(),
      lastUsedAt: binding.lastUsedAt?.toISOString() ?? null,
      lastTool: binding.lastTool,
      holds,
    };
  }
  // What the agent has is read as the agent, then cut to what the viewer may open (the agent may see more).
  const assigned = (await openAssignedRows(agent.userId, agent.workspaceId, "UTC")).slice(0, MAX_ASSIGNED_WORK);
  const rowIds = assigned.map((r) => r.id);
  const open = rowIds.length ? new Set((await db.select({ id: page.id }).from(page).where(and(inArray(page.id, rowIds), pageVisibleTo(viewerId)))).map((r) => r.id)) : new Set<string>();
  const mentions = await db
    .select({ m: externalAgentMention, title: page.title })
    .from(externalAgentMention)
    .innerJoin(page, eq(page.id, externalAgentMention.pageId))
    .where(and(eq(externalAgentMention.agentId, agentId), isNull(externalAgentMention.handledAt), isNull(page.archivedAt), pageVisibleTo(viewerId)))
    .orderBy(desc(externalAgentMention.createdAt))
    .limit(20);
  const changed = await db
    .select({ rowId: rowActivity.rowId, title: page.title, at: rowActivity.createdAt })
    .from(rowActivity)
    .innerJoin(page, eq(page.id, rowActivity.rowId))
    .where(and(eq(rowActivity.actorUserId, agent.userId), isNull(page.archivedAt), pageVisibleTo(viewerId)))
    .orderBy(desc(rowActivity.createdAt))
    .limit(30);
  const seen = new Set<string>();
  const activity = changed.filter((c) => (seen.has(c.rowId) ? false : (seen.add(c.rowId), true))).slice(0, 8);
  return {
    binding: bindingView,
    work: assigned.filter((r) => open.has(r.id)).map((r) => ({ id: r.id, title: r.title, databaseTitle: r.databaseTitle, status: r.status?.name ?? null, updatedAt: r.updatedAt.toISOString() })),
    mentions: mentions.map(({ m, title }) => ({ id: m.id, pageId: m.pageId, pageTitle: title, text: m.excerpt, createdAt: m.createdAt.toISOString() })),
    activity: activity.map((a) => ({ rowId: a.rowId, title: a.title, at: a.at.toISOString() })),
  };
}

const enabledAndLive = (agent: Agent) => agent.enabled && agent.archivedAt === null && agent.kind === "external";

