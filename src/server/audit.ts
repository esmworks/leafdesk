import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { apiToken, auditEvent, memberGroup, oauthClient, page, scimToken, teamspace, user, workspace, workspaceAgent } from "@/db/schema";
import {
  AUDIT_CATEGORIES,
  AUDIT_CSV_LIMIT,
  AUDIT_PAGE_SIZE,
  auditDateRange,
  type AuditAction,
  type AuditActorKind,
  type AuditEvent,
  type AuditFilters,
  type AuditTargetType,
} from "@/lib/audit";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { requireMembership } from "@/server/access";
import { connectedAppCall } from "@/server/connected-app";
import { clientDisplayName } from "@/server/mcp/grants";

/**
 * The workspace audit log (issue #61, lib/audit.ts for the actions): `recordAudit` writes what an
 * owner may want to trace, from the server functions that make those changes, whichever way they
 * are reached (a server action, MCP, the REST API, SCIM, the daily cleanup).
 *
 * Recording never fails or holds back the change: a failure is logged and the change stands. Call
 * sites choose when it runs:
 *  - inside the change's transaction (pass `tx`), where the change is one: the event commits or
 *    rolls back with it, so the log never shows a change that didn't happen, nor misses one when
 *    the process dies right after the commit. It runs in a savepoint, so a failing insert leaves the
 *    transaction usable;
 *  - right after the change, for changes made in a single statement (or several that have no
 *    transaction of their own); a crash between the two can lose the event, never the change.
 *
 * Who acted and from where comes from the request being served, so call sites only name the user:
 *  - a browser request: its address (CLIENT_IP_HEADER, set by server.ts) and user agent;
 *  - an MCP client or REST API token (the connected-app context, see connected-app.ts): the person
 *    it acts for, and its name;
 *  - SCIM or the server itself (`runAsAuditOrigin`): the identity provider's token, or nobody.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select" | "insert">;

export type AuditTarget = {
  type: AuditTargetType;
  id?: string | null;
  /** Looked up from `id` when left out (people, pages, groups, teamspaces, workspaces). */
  label?: string | null;
};

export type AuditInput = {
  workspaceId: string;
  /** The user who made the change (or for whom an app made it); null for the server itself. */
  actorId: string | null;
  action: AuditAction;
  target?: AuditTarget | null;
  /**
   * Who a change on the target is for (the person, group or everyone a page is shared with), stored
   * in `details` as `subjectType`, `subjectId` and `subject` (its name then).
   */
  subject?: AuditTarget | { type: "everyone" } | null;
  /** Small before/after values; never page content. */
  details?: Record<string, unknown>;
};

/** A change made by something other than a person in a request: SCIM, or the server on its own. */
export type AuditOrigin = { kind: "scim"; tokenId: string; ip: string | null; userAgent: string | null } | { kind: "system" };

// One per process: route modules can be loaded more than once in development.
const globalForAudit = globalThis as unknown as { __leafdeskAuditOrigin?: AsyncLocalStorage<AuditOrigin> };
const origins = (globalForAudit.__leafdeskAuditOrigin ??= new AsyncLocalStorage<AuditOrigin>());

/**
 * Runs `fn` with its changes recorded as made by `origin`: a SCIM request (whatever user id the
 * code acting for it passes, such as the oldest owner for group changes) or the server itself.
 */
export function runAsAuditOrigin<T>(origin: AuditOrigin, fn: () => T): T {
  return origins.run(origin, fn);
}

const MAX_USER_AGENT = 512;
const MAX_LABEL = 300;

type RequestFacts = { ip: string | null; userAgent: string | null };

/** The address and user agent of the Next request being served; nulls outside one (scripts, jobs). */
async function requestFacts(): Promise<RequestFacts> {
  let requestHeaders: Headers;
  try {
    // Loaded on demand: this module is imported by code that also runs outside Next.
    const { headers } = await import("next/headers");
    requestHeaders = await headers();
  } catch (error) {
    // Next's own control flow (dynamic rendering bailouts and the like) must go through.
    const { unstable_rethrow } = await import("next/navigation");
    unstable_rethrow(error);
    return { ip: null, userAgent: null };
  }
  return { ip: requestHeaders.get(CLIENT_IP_HEADER), userAgent: requestHeaders.get("user-agent") };
}

type Actor = {
  kind: AuditActorKind;
  userId: string | null;
  name: string;
  email: string | null;
  via: string | null;
  ip: string | null;
  userAgent: string | null;
};

async function viaName(reader: Executor, kind: "connected_app" | "api_token" | "scim", id: string): Promise<string | null> {
  if (kind === "connected_app") {
    const [row] = await reader.select({ name: oauthClient.name }).from(oauthClient).where(eq(oauthClient.clientId, id)).limit(1);
    return clientDisplayName(row?.name, id);
  }
  const table = kind === "api_token" ? apiToken : scimToken;
  const [row] = await reader.select({ name: table.name }).from(table).where(eq(table.id, id)).limit(1);
  return row?.name ?? null;
}

async function actorOf(reader: Executor, actorId: string | null, facts: RequestFacts): Promise<Actor> {
  const origin = origins.getStore();
  if (origin?.kind === "scim") {
    const via = await viaName(reader, "scim", origin.tokenId);
    return { kind: "scim", userId: null, name: "", email: null, via, ip: origin.ip, userAgent: origin.userAgent };
  }
  if (origin?.kind === "system" || actorId === null) {
    return { kind: "system", userId: null, name: "", email: null, via: null, ip: null, userAgent: null };
  }
  const [person] = await reader
    .select({ name: user.name, email: user.email, agentId: workspaceAgent.id })
    .from(user)
    .leftJoin(workspaceAgent, eq(workspaceAgent.userId, user.id))
    .where(eq(user.id, actorId))
    .limit(1);
  // An agent acts on its own, never through an app or a browser: no address, no device.
  if (person?.agentId) return { kind: "agent", userId: actorId, name: person.name, email: null, via: null, ip: null, userAgent: null };
  const base = { userId: person ? actorId : null, name: person?.name ?? "", email: person?.email ?? null };
  const app = connectedAppCall(actorId)?.app;
  if (app) {
    const via = await viaName(reader, app.kind, app.id);
    return { ...base, kind: app.kind, via, ip: app.ip ?? null, userAgent: app.userAgent ?? null };
  }
  return { ...base, kind: "user", via: null, ...facts };
}

/** The target's name as it is now, for targets named by id only. */
async function labelOf(reader: Executor, target: AuditTarget): Promise<{ label: string; email?: string }> {
  if (target.label != null || !target.id) return { label: target.label ?? "" };
  const id = target.id;
  switch (target.type) {
    case "user": {
      const [row] = await reader
        .select({ name: user.name, email: user.email, agentId: workspaceAgent.id })
        .from(user)
        .leftJoin(workspaceAgent, eq(workspaceAgent.userId, user.id))
        .where(eq(user.id, id))
        .limit(1);
      // An agent's address is no one's: it is named only.
      if (row?.agentId) return { label: row.name };
      return row ? { label: row.name || row.email, email: row.email } : { label: "" };
    }
    case "page": {
      const [row] = await reader.select({ title: page.title }).from(page).where(eq(page.id, id)).limit(1);
      return { label: row?.title ?? "" };
    }
    case "group": {
      const [row] = await reader.select({ name: memberGroup.name }).from(memberGroup).where(eq(memberGroup.id, id)).limit(1);
      return { label: row?.name ?? "" };
    }
    case "teamspace": {
      const [row] = await reader.select({ name: teamspace.name }).from(teamspace).where(eq(teamspace.id, id)).limit(1);
      return { label: row?.name ?? "" };
    }
    case "workspace": {
      const [row] = await reader.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, id)).limit(1);
      return { label: row?.name ?? "" };
    }
    default:
      return { label: "" };
  }
}

let failWrites = false;

/**
 * Scripts only: makes every recording fail in the database (it names a workspace that doesn't
 * exist), to check that the changes themselves go through anyway. False restores recording.
 */
export function failAuditWritesForTesting(on: boolean) {
  failWrites = on;
}

async function write(executor: Executor, inputs: AuditInput[], facts: RequestFacts) {
  const actors = new Map<string | null, Actor>();
  const rows: (typeof auditEvent.$inferInsert)[] = [];
  for (const input of inputs) {
    let actor = actors.get(input.actorId);
    if (!actor) actors.set(input.actorId, (actor = await actorOf(executor, input.actorId, facts)));
    const target = input.target ?? null;
    const { label, email } = target ? await labelOf(executor, target) : { label: "" };
    const details: Record<string, unknown> = { ...input.details, ...(email ? { email } : {}) };
    const subject = input.subject;
    if (subject) {
      details.subjectType = subject.type;
      if (subject.type !== "everyone") {
        const named = await labelOf(executor, subject);
        details.subjectId = subject.id ?? null;
        details.subject = named.label.slice(0, MAX_LABEL);
        if (named.email) details.subjectEmail = named.email;
      }
    }
    rows.push({
      workspaceId: failWrites ? `missing-workspace-${crypto.randomUUID()}` : input.workspaceId,
      actorUserId: actor.userId,
      actorKind: actor.kind,
      actorName: actor.name.slice(0, MAX_LABEL),
      actorEmail: actor.email,
      actorVia: actor.via?.slice(0, MAX_LABEL) ?? null,
      action: input.action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      targetLabel: label.slice(0, MAX_LABEL),
      details,
      ip: actor.ip,
      userAgent: actor.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
    });
  }
  if (rows.length) await executor.insert(auditEvent).values(rows);
}

/**
 * Records one change, or several at once, in the audit log. Never throws. With `tx`, inside that
 * transaction (a savepoint of it); without, on its own right away. See the note at the top.
 */
export async function recordAudit(input: AuditInput | AuditInput[], tx?: Tx): Promise<void> {
  const inputs = Array.isArray(input) ? input : [input];
  if (!inputs.length) return;
  // Outside the try: Next's control flow from reading the request must reach Next.
  const facts = await requestFacts();
  try {
    if (tx) await tx.transaction((savepoint) => write(savepoint, inputs, facts));
    else await write(db, inputs, facts);
  } catch (error) {
    console.error(`[audit] could not record ${inputs.map((i) => i.action).join(", ")}`, error);
  }
}

/** Before/after of the keys whose value changed, as `details.changes` holds them. */
export function changedValues<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(after)) {
    const from = before[key];
    if (to !== undefined && JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from: from ?? null, to };
  }
  return changes;
}

// ------------------------------------------------------------------------------------- reading

function filterConditions(workspaceId: string, filters: AuditFilters, timeZone: string): SQL[] {
  const { since, until } = auditDateRange(filters, timeZone);
  const conditions: (SQL | undefined)[] = [
    eq(auditEvent.workspaceId, workspaceId),
    filters.category ? inArray(auditEvent.action, [...AUDIT_CATEGORIES[filters.category]]) : undefined,
    filters.actor
      ? "userId" in filters.actor
        ? eq(auditEvent.actorUserId, filters.actor.userId)
        : eq(auditEvent.actorKind, filters.actor.kind)
      : undefined,
    since ? gte(auditEvent.createdAt, since) : undefined,
    until ? lt(auditEvent.createdAt, until) : undefined,
  ];
  return conditions.filter((c): c is SQL => c !== undefined);
}

const eventColumns = {
  id: auditEvent.id,
  action: auditEvent.action,
  actorKind: auditEvent.actorKind,
  actorUserId: auditEvent.actorUserId,
  actorName: auditEvent.actorName,
  actorEmail: auditEvent.actorEmail,
  actorVia: auditEvent.actorVia,
  targetType: auditEvent.targetType,
  targetId: auditEvent.targetId,
  targetLabel: auditEvent.targetLabel,
  details: auditEvent.details,
  ip: auditEvent.ip,
  userAgent: auditEvent.userAgent,
  createdAt: auditEvent.createdAt,
};

async function selectEvents(workspaceId: string, filters: AuditFilters, timeZone: string, limit: number, offset: number): Promise<AuditEvent[]> {
  return db
    .select(eventColumns)
    .from(auditEvent)
    .where(and(...filterConditions(workspaceId, filters, timeZone)))
    .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
    .limit(limit)
    .offset(offset);
}

/**
 * One page of the log, newest first, with whether older events follow. Owners only (AccessError
 * for anyone else, whether the workspace exists or not). `timeZone` is the viewer's, for the days
 * of the date range.
 */
export async function listAuditEvents(
  actorId: string,
  workspaceId: string,
  filters: AuditFilters,
  { timeZone = "UTC" }: { timeZone?: string } = {},
): Promise<{ events: AuditEvent[]; hasMore: boolean }> {
  await requireMembership(actorId, workspaceId, "owner");
  const rows = await selectEvents(workspaceId, filters, timeZone, AUDIT_PAGE_SIZE + 1, (filters.page - 1) * AUDIT_PAGE_SIZE);
  return { events: rows.slice(0, AUDIT_PAGE_SIZE), hasMore: rows.length > AUDIT_PAGE_SIZE };
}

/** The filtered log for the CSV, all pages (up to AUDIT_CSV_LIMIT), newest first. Owners only. */
export async function auditEventsForExport(
  actorId: string,
  workspaceId: string,
  filters: AuditFilters,
  { timeZone = "UTC" }: { timeZone?: string } = {},
): Promise<AuditEvent[]> {
  await requireMembership(actorId, workspaceId, "owner");
  return selectEvents(workspaceId, filters, timeZone, AUDIT_CSV_LIMIT, 0);
}

export type AuditActorOption = { userId: string; name: string; email: string | null; isAgent: boolean };

/**
 * The people who acted in the workspace (themselves or through an app), by the name they had most
 * recently, for the actor filter. Owners only.
 */
export async function auditActors(actorId: string, workspaceId: string): Promise<AuditActorOption[]> {
  await requireMembership(actorId, workspaceId, "owner");
  const rows = await db
    .selectDistinctOn([auditEvent.actorUserId], {
      userId: auditEvent.actorUserId,
      name: auditEvent.actorName,
      email: auditEvent.actorEmail,
      kind: auditEvent.actorKind,
    })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), sql`${auditEvent.actorUserId} is not null`))
    .orderBy(auditEvent.actorUserId, desc(auditEvent.createdAt));
  return rows
    .flatMap((r) => (r.userId ? [{ userId: r.userId, name: r.name, email: r.email, isAgent: r.kind === "agent" }] : []))
    .sort((a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || ""));
}
