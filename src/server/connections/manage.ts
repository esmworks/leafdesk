/**
 * Connections of a workspace (see lib/connections.ts): owners add, change, sign in to and remove
 * them, class their tools, allow agents tools, and set triggers on their events. Members and
 * guests see none of it. Credentials go in sealed and never come back: the settings show only
 * whether a connection has them.
 */
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { agentGrant, connection, connectionEvent, connectionOauth, connectionTrigger, workspaceAgent } from "@/db/schema";
import {
  connectionSlug,
  isConnectionAuthType,
  isEventPreset,
  MAX_CONNECTION_NAME,
  MAX_CONNECTION_TOKEN,
  MAX_CONNECTION_TRIGGERS,
  MAX_CONNECTIONS,
  MAX_TRIGGER_EVENT,
  type AgentGrantView,
  type ConnectionAuthType,
  type ConnectionErrorCode,
  type ConnectionEventView,
  type ConnectionTriggerView,
  type ConnectionView,
  type EventPreset,
  type ToolKind,
} from "@/lib/connections";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import { env } from "@/lib/env";
import { AccessError, ConnectedAppReadOnlyError, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { open, seal, sealJson } from "../secret-box";
import { ConnectionClientError, dropClient, finishOAuth, listConnectionTools, secretsOf, startOAuth, type ConnectionRow, type ConnectionSecrets } from "./client";
import { checkConnectionUrl, ConnectionFetchError } from "./fetch";

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
    readonly params: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

/** How long a sign-in begun in the browser may take. */
const OAUTH_STATE_MS = 15 * 60_000;

export type ConnectionInput = {
  name?: string;
  icon?: string | null;
  url?: string;
  authType?: ConnectionAuthType;
  /** For `token` connections: the token (a bearer token the service gave). */
  token?: string;
  eventPreset?: EventPreset;
};

export const eventUrlOf = (connectionId: string) => `${env.appUrl}/api/connections/${connectionId}/events`;

export function viewConnection(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    url: row.url,
    authType: row.authType,
    hasToken: row.authType === "token" ? Boolean(row.secrets && secretsOf(row).token) : row.authType === "oauth" ? Boolean(row.secrets && secretsOf(row).oauth?.tokens) : false,
    status: row.status,
    statusError: row.statusError,
    tools: row.tools,
    toolsAt: row.toolsAt?.toISOString() ?? null,
    eventPreset: row.eventPreset,
    eventUrl: eventUrlOf(row.id),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

const auditDetails = (row: ConnectionRow) => ({ name: row.name, url: row.url, authType: row.authType, eventPreset: row.eventPreset });

function checkName(value: unknown) {
  const name = typeof value === "string" ? value.trim().slice(0, MAX_CONNECTION_NAME) : "";
  if (!name) throw new ConnectionError("invalidName", "A connection needs a name");
  return name;
}

function checkIcon(value: unknown) {
  if (value === null || value === undefined) return null;
  const icon = typeof value === "string" ? value.trim() : "";
  if (!icon || [...icon].length > 8) throw new ConnectionError("invalidName", "A connection's icon is an emoji");
  return icon;
}

function checkUrl(value: unknown) {
  try {
    return checkConnectionUrl(typeof value === "string" ? value.trim() : "").href;
  } catch (error) {
    if (error instanceof ConnectionFetchError) throw new ConnectionError(error.code === "blocked" ? "blocked" : "invalidUrl", error.message);
    throw error;
  }
}

function checkToken(value: unknown) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token || token.length > MAX_CONNECTION_TOKEN || /\s/.test(token)) throw new ConnectionError("invalidToken", "Paste the service's token");
  return token;
}

const newEventSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

/** The connection with this id, for an owner of its workspace. */
async function ownedConnection(userId: string, connectionId: string): Promise<ConnectionRow> {
  const [found] = await db.select().from(connection).where(eq(connection.id, connectionId)).limit(1);
  if (!found) throw new ConnectionError("notFound", "Connection not found");
  await requireMembership(userId, found.workspaceId, "owner").catch((error) => {
    if (error instanceof AccessError && !(error instanceof ConnectedAppReadOnlyError)) throw new ConnectionError("notFound", "Connection not found");
    throw error;
  });
  return found;
}

async function ownedAgentIn(userId: string, agentId: string) {
  const [agent] = await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, agentId)).limit(1);
  if (!agent) throw new ConnectionError("notFound", "Agent not found");
  await requireMembership(userId, agent.workspaceId, "owner").catch((error) => {
    if (error instanceof AccessError && !(error instanceof ConnectedAppReadOnlyError)) throw new ConnectionError("notFound", "Agent not found");
    throw error;
  });
  return agent;
}

export async function listConnections(userId: string, workspaceId: string): Promise<ConnectionView[]> {
  await requireMembership(userId, workspaceId, "owner");
  const rows = await db.select().from(connection).where(eq(connection.workspaceId, workspaceId)).orderBy(connection.createdAt);
  return rows.map(viewConnection);
}

export async function getConnection(userId: string, connectionId: string): Promise<ConnectionView> {
  return viewConnection(await ownedConnection(userId, connectionId));
}

/**
 * Lists a connection's tools again and saves where it stands: ready, waiting for a sign-in, or
 * failing (with why). Never throws for the service's sake: the status says it.
 */
async function refresh(row: ConnectionRow): Promise<ConnectionRow> {
  if (row.authType === "oauth" && !secretsOf(row).oauth?.tokens) {
    const [saved] = await db.update(connection).set({ status: "needsAuth", statusError: null }).where(eq(connection.id, row.id)).returning();
    return saved;
  }
  try {
    const tools = await listConnectionTools(row);
    const [saved] = await db.update(connection).set({ tools, toolsAt: new Date(), status: "ready", statusError: null }).where(eq(connection.id, row.id)).returning();
    return saved;
  } catch (error) {
    const failure = error instanceof ConnectionClientError ? error : new ConnectionClientError("notMcp", String(error));
    const status = failure.code === "unauthorized" && row.authType === "oauth" ? "needsAuth" : "error";
    const [saved] = await db
      .update(connection)
      .set({ status, statusError: `${failure.code}: ${failure.message}`.slice(0, 300) })
      .where(eq(connection.id, row.id))
      .returning();
    return saved;
  }
}

/** Adds a connection; a token or open one is tried at once, an OAuth one waits for a sign-in. */
export async function createConnection(userId: string, workspaceId: string, input: ConnectionInput): Promise<ConnectionView> {
  await requireMembership(userId, workspaceId, "owner");
  const name = checkName(input.name);
  const icon = checkIcon(input.icon);
  const url = checkUrl(input.url);
  const authType = isConnectionAuthType(input.authType) ? input.authType : "oauth";
  const eventPreset = isEventPreset(input.eventPreset) ? input.eventPreset : "hmac";
  const secrets: ConnectionSecrets = authType === "token" ? { token: checkToken(input.token) } : {};
  const created = await db.transaction(async (tx) => {
    const existing = await tx.select({ slug: connection.slug }).from(connection).where(eq(connection.workspaceId, workspaceId));
    if (existing.length >= MAX_CONNECTIONS) throw new ConnectionError("tooMany", `A workspace has at most ${MAX_CONNECTIONS} connections`, { max: String(MAX_CONNECTIONS) });
    const [row] = await tx
      .insert(connection)
      .values({
        workspaceId,
        name,
        icon,
        slug: connectionSlug(name, new Set(existing.map((e) => e.slug))),
        url,
        authType,
        secrets: authType === "none" ? null : sealJson(secrets),
        status: "needsAuth",
        eventPreset,
        eventSecret: seal(newEventSecret()),
        createdBy: userId,
      })
      .returning();
    return row;
  });
  await recordAudit({ workspaceId, actorId: userId, action: "connection.created", target: { type: "connection", id: created.id, label: name }, details: auditDetails(created) });
  return viewConnection(authType === "oauth" ? created : await refresh(created));
}

/** Changes a connection; a new address or way to sign in signs it out (an OAuth one waits for a new sign-in). */
export async function updateConnection(userId: string, connectionId: string, input: ConnectionInput): Promise<ConnectionView> {
  const current = await ownedConnection(userId, connectionId);
  const set: Partial<ConnectionRow> = {};
  if (input.name !== undefined) set.name = checkName(input.name);
  if (input.icon !== undefined) set.icon = checkIcon(input.icon);
  if (input.url !== undefined) set.url = checkUrl(input.url);
  if (input.authType !== undefined && isConnectionAuthType(input.authType)) set.authType = input.authType;
  if (input.eventPreset !== undefined && isEventPreset(input.eventPreset)) set.eventPreset = input.eventPreset;
  const authType = set.authType ?? current.authType;
  const reconnect = (set.url !== undefined && set.url !== current.url) || authType !== current.authType || input.token !== undefined;
  if (reconnect) {
    if (authType === "token") set.secrets = sealJson({ token: input.token !== undefined ? checkToken(input.token) : secretsOf(current).token ?? checkToken("") });
    else if (authType === "none") set.secrets = null;
    // OAuth: what the old service gave is no good for a new one.
    else set.secrets = sealJson({});
    set.status = "needsAuth";
    set.statusError = null;
  }
  const [updated] = await db.update(connection).set(set).where(eq(connection.id, connectionId)).returning();
  if (reconnect) dropClient(connectionId);
  await recordAudit({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "connection.updated",
    target: { type: "connection", id: connectionId, label: updated.name },
    details: { ...auditDetails(updated), previous: auditDetails(current), tokenChanged: input.token !== undefined || undefined },
  });
  return viewConnection(reconnect && authType !== "oauth" ? await refresh(updated) : updated);
}

/** Lists a connection's tools again (they may have changed at the service). */
export async function refreshConnection(userId: string, connectionId: string): Promise<ConnectionView> {
  const row = await ownedConnection(userId, connectionId);
  dropClient(row.id);
  return viewConnection(await refresh(row));
}

/** Classes a tool as reading or writing (null: as the server marked it). */
export async function setToolKind(userId: string, connectionId: string, tool: string, kind: ToolKind | null): Promise<ConnectionView> {
  const row = await ownedConnection(userId, connectionId);
  const found = row.tools.find((t) => t.name === tool);
  if (!found) throw new ConnectionError("unknownTool", "No such tool");
  const kinds = { ...row.kinds };
  if (kind === null || kind === found.hinted) delete kinds[tool];
  else kinds[tool] = kind;
  const tools = row.tools.map((t) => (t.name === tool ? { ...t, kind: kinds[tool] ?? t.hinted } : t));
  const [updated] = await db.update(connection).set({ kinds, tools }).where(eq(connection.id, connectionId)).returning();
  await recordAudit({
    workspaceId: row.workspaceId,
    actorId: userId,
    action: "connection.updated",
    target: { type: "connection", id: connectionId, label: row.name },
    details: { ...auditDetails(updated), tool, kind: kinds[tool] ?? found.hinted },
  });
  return viewConnection(updated);
}

/** Removes a connection: its credentials, the tools agents had on it and its triggers go with it. */
export async function deleteConnection(userId: string, connectionId: string): Promise<void> {
  const row = await ownedConnection(userId, connectionId);
  await db.delete(connection).where(eq(connection.id, connectionId));
  dropClient(connectionId);
  await recordAudit({ workspaceId: row.workspaceId, actorId: userId, action: "connection.deleted", target: { type: "connection", id: connectionId, label: row.name }, details: auditDetails(row) });
}

// ---------------------------------------------------------------------------------- OAuth

/** Begins signing in to a connection's service: the address to send the browser to (null: already signed in). */
export async function beginConnectionOAuth(userId: string, connectionId: string): Promise<{ url: string } | null> {
  const row = await ownedConnection(userId, connectionId);
  if (row.authType !== "oauth") throw new ConnectionError("oauthFailed", "This connection doesn't sign in with OAuth");
  await db.delete(connectionOauth).where(lte(connectionOauth.createdAt, new Date(Date.now() - OAUTH_STATE_MS)));
  let started: Awaited<ReturnType<typeof startOAuth>>;
  try {
    started = await startOAuth(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(connection).set({ status: "error", statusError: `oauth: ${message}`.slice(0, 300) }).where(eq(connection.id, row.id));
    throw new ConnectionError("oauthFailed", message);
  }
  if (!started) {
    await refresh(await ownedConnection(userId, connectionId));
    return null;
  }
  await db.insert(connectionOauth).values({ state: started.state, connectionId, userId, data: sealJson({ verifier: started.verifier }) });
  return { url: started.url.href };
}

/**
 * The browser came back from the service: finishes the sign-in begun with `state`, by the same
 * person, still an owner. Returns the connection, signed in and its tools listed.
 */
export async function completeConnectionOAuth(userId: string, input: { state: string; code: string; iss?: string }): Promise<{ connection: ConnectionView; workspaceId: string }> {
  const [pending] = await db.delete(connectionOauth).where(eq(connectionOauth.state, input.state)).returning();
  if (!pending || pending.userId !== userId || pending.createdAt.getTime() < Date.now() - OAUTH_STATE_MS) {
    throw new ConnectionError("oauthFailed", "This sign-in expired or was begun by someone else; begin it again");
  }
  const row = await ownedConnection(userId, pending.connectionId);
  const { verifier } = JSON.parse(open(pending.data)) as { verifier: string };
  try {
    await finishOAuth(row, verifier, input.code, input.iss);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(connection).set({ status: "needsAuth", statusError: `oauth: ${message}`.slice(0, 300) }).where(eq(connection.id, row.id));
    throw new ConnectionError("oauthFailed", message);
  }
  const signedIn = await refresh(await ownedConnection(userId, row.id));
  await recordAudit({
    workspaceId: row.workspaceId,
    actorId: userId,
    action: "connection.updated",
    target: { type: "connection", id: row.id, label: row.name },
    details: { ...auditDetails(row), signedIn: true },
  });
  return { connection: viewConnection(signedIn), workspaceId: row.workspaceId };
}

/** Forgets what the service gave at sign-in: the connection waits for a new sign-in. */
export async function signOutConnection(userId: string, connectionId: string): Promise<ConnectionView> {
  const row = await ownedConnection(userId, connectionId);
  const [updated] = await db
    .update(connection)
    .set({ secrets: row.authType === "token" ? row.secrets : row.authType === "none" ? null : sealJson({}), status: "needsAuth", statusError: null })
    .where(eq(connection.id, connectionId))
    .returning();
  dropClient(connectionId);
  await recordAudit({ workspaceId: row.workspaceId, actorId: userId, action: "connection.updated", target: { type: "connection", id: connectionId, label: row.name }, details: { ...auditDetails(row), signedOut: true } });
  return viewConnection(updated);
}

// --------------------------------------------------------------------------------- events

/** The secret a connection's events are signed with, for an owner to give the sender. */
export async function revealEventSecret(userId: string, connectionId: string): Promise<string> {
  const row = await ownedConnection(userId, connectionId);
  return open(row.eventSecret);
}

/** A new secret for a connection's events (or, for Slack, the signing secret Slack shows). */
export async function setEventSecret(userId: string, connectionId: string, secret?: string): Promise<string> {
  const row = await ownedConnection(userId, connectionId);
  const value = secret === undefined ? newEventSecret() : secret.trim();
  if (!value || value.length > 500 || /\s/.test(value)) throw new ConnectionError("invalidToken", "Paste the signing secret");
  await db.update(connection).set({ eventSecret: seal(value) }).where(eq(connection.id, connectionId));
  await recordAudit({ workspaceId: row.workspaceId, actorId: userId, action: "connection.updated", target: { type: "connection", id: connectionId, label: row.name }, details: { ...auditDetails(row), eventSecretChanged: true } });
  return value;
}

export async function listConnectionEvents(userId: string, connectionId: string): Promise<ConnectionEventView[]> {
  await ownedConnection(userId, connectionId);
  const rows = await db.select().from(connectionEvent).where(eq(connectionEvent.connectionId, connectionId)).orderBy(desc(connectionEvent.receivedAt)).limit(50);
  return rows.map((e) => ({ id: e.id, eventType: e.eventType, status: e.status, note: e.note, receivedAt: e.receivedAt.toISOString() }));
}

// ------------------------------------------------------------------------------- triggers

const viewTrigger = (t: typeof connectionTrigger.$inferSelect): ConnectionTriggerView => ({
  id: t.id,
  connectionId: t.connectionId,
  agentId: t.agentId,
  eventType: t.eventType,
  prompt: t.prompt,
  enabled: t.enabled,
  createdAt: t.createdAt.toISOString(),
});

export type TriggerInput = { agentId?: string; eventType?: string | null; prompt?: string; enabled?: boolean };

async function checkTriggerAgent(userId: string, row: ConnectionRow, agentId: unknown) {
  if (typeof agentId !== "string") throw new ConnectionError("invalidTrigger", "Pick an agent");
  const agent = await ownedAgentIn(userId, agentId);
  if (agent.workspaceId !== row.workspaceId || agent.archivedAt) throw new ConnectionError("invalidTrigger", "Pick an agent of this workspace");
  return agent;
}

const checkEventType = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const type = typeof value === "string" ? value.trim().slice(0, MAX_TRIGGER_EVENT) : "";
  return type || null;
};

export async function listTriggers(userId: string, connectionId: string): Promise<ConnectionTriggerView[]> {
  await ownedConnection(userId, connectionId);
  const rows = await db.select().from(connectionTrigger).where(eq(connectionTrigger.connectionId, connectionId)).orderBy(connectionTrigger.createdAt);
  return rows.map(viewTrigger);
}

export async function createTrigger(userId: string, connectionId: string, input: TriggerInput): Promise<ConnectionTriggerView> {
  const row = await ownedConnection(userId, connectionId);
  const agent = await checkTriggerAgent(userId, row, input.agentId);
  const [{ n }] = await db.select({ n: count() }).from(connectionTrigger).where(eq(connectionTrigger.connectionId, connectionId));
  if (n >= MAX_CONNECTION_TRIGGERS) throw new ConnectionError("tooMany", `A connection has at most ${MAX_CONNECTION_TRIGGERS} triggers`, { max: String(MAX_CONNECTION_TRIGGERS) });
  const [created] = await db
    .insert(connectionTrigger)
    .values({
      connectionId,
      agentId: agent.id,
      eventType: checkEventType(input.eventType),
      prompt: (input.prompt ?? "").trim().slice(0, MAX_AGENT_PROMPT),
      enabled: input.enabled ?? true,
      createdBy: userId,
    })
    .returning();
  await recordAudit({
    workspaceId: row.workspaceId,
    actorId: userId,
    action: "connection.updated",
    target: { type: "connection", id: connectionId, label: row.name },
    details: { ...auditDetails(row), triggerAdded: { agent: agent.name, eventType: created.eventType } },
  });
  return viewTrigger(created);
}

export async function updateTrigger(userId: string, triggerId: string, input: TriggerInput): Promise<ConnectionTriggerView> {
  const [trigger] = await db.select().from(connectionTrigger).where(eq(connectionTrigger.id, triggerId));
  if (!trigger) throw new ConnectionError("notFound", "Trigger not found");
  const row = await ownedConnection(userId, trigger.connectionId);
  const set: Partial<typeof connectionTrigger.$inferInsert> = {};
  if (input.agentId !== undefined) set.agentId = (await checkTriggerAgent(userId, row, input.agentId)).id;
  if (input.eventType !== undefined) set.eventType = checkEventType(input.eventType);
  if (input.prompt !== undefined) set.prompt = input.prompt.trim().slice(0, MAX_AGENT_PROMPT);
  if (input.enabled !== undefined) set.enabled = Boolean(input.enabled);
  const [updated] = await db.update(connectionTrigger).set(set).where(eq(connectionTrigger.id, triggerId)).returning();
  return viewTrigger(updated);
}

export async function deleteTrigger(userId: string, triggerId: string): Promise<void> {
  const [trigger] = await db.select().from(connectionTrigger).where(eq(connectionTrigger.id, triggerId));
  if (!trigger) throw new ConnectionError("notFound", "Trigger not found");
  const row = await ownedConnection(userId, trigger.connectionId);
  await db.delete(connectionTrigger).where(eq(connectionTrigger.id, triggerId));
  await recordAudit({
    workspaceId: row.workspaceId,
    actorId: userId,
    action: "connection.updated",
    target: { type: "connection", id: row.id, label: row.name },
    details: { ...auditDetails(row), triggerRemoved: { eventType: trigger.eventType } },
  });
}

// --------------------------------------------------------------------------------- grants

/** The tools of each connection an agent may use. */
export async function listAgentGrants(userId: string, agentId: string): Promise<AgentGrantView[]> {
  await ownedAgentIn(userId, agentId);
  const rows = await db.select().from(agentGrant).where(eq(agentGrant.agentId, agentId));
  return rows.map((g) => ({ connectionId: g.connectionId, tools: g.tools }));
}

/** Sets the tools of a connection an agent may use (none: takes the connection from it). */
export async function setAgentGrant(userId: string, agentId: string, connectionId: string, tools: string[]): Promise<AgentGrantView[]> {
  const agent = await ownedAgentIn(userId, agentId);
  const row = await ownedConnection(userId, connectionId);
  if (row.workspaceId !== agent.workspaceId) throw new ConnectionError("notFound", "Connection not found");
  const known = new Set(row.tools.map((t) => t.name));
  const unknown = tools.find((t) => !known.has(t));
  if (unknown) throw new ConnectionError("unknownTool", `No tool "${unknown}"`, { tool: unknown });
  const chosen = [...new Set(tools)];
  const [before] = await db.select().from(agentGrant).where(and(eq(agentGrant.agentId, agentId), eq(agentGrant.connectionId, connectionId)));
  if (!chosen.length) await db.delete(agentGrant).where(and(eq(agentGrant.agentId, agentId), eq(agentGrant.connectionId, connectionId)));
  else {
    await db
      .insert(agentGrant)
      .values({ agentId, connectionId, tools: chosen })
      .onConflictDoUpdate({ target: [agentGrant.agentId, agentGrant.connectionId], set: { tools: chosen } });
  }
  await recordAudit({
    workspaceId: row.workspaceId,
    actorId: userId,
    action: "connection.updated",
    target: { type: "connection", id: connectionId, label: row.name },
    details: { ...auditDetails(row), agent: agent.name, tools: chosen, previousTools: before?.tools ?? [] },
  });
  return listAgentGrants(userId, agentId);
}
