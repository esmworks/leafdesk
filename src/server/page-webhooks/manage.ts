import { createHmac } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { page, pageWebhook, pageWebhookDelivery, teamspace, user } from "@/db/schema";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import {
  MAX_PAGE_WEBHOOK_NAME,
  MAX_PAGE_WEBHOOKS,
  normalizeEvents,
  type DeliveryCode,
  type DeliveryStatus,
  type PageWebhookEvent,
  type PageWebhookPause,
  type PageWebhookScope,
} from "@/lib/page-webhooks";
import { AccessError, requireMembership, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { allowedHost, newSecretSalt, parseWebhookUrl, WebhookError } from "@/server/automations/webhook";
import { getTeamspace } from "@/server/teamspaces";

/**
 * Page webhooks, managed by the workspace's owners (Settings > Webhooks and the REST API): where
 * what happens to the workspace's pages goes, which events, and for which pages. Deliveries are
 * queued and sent by ./deliver.ts as whoever saved the subscription last.
 */

export type PageWebhookErrorCode = "invalidName" | "invalidUrl" | "httpsOnly" | "noEvents" | "invalidScope" | "tooMany";

export class PageWebhookError extends Error {
  constructor(
    readonly code: PageWebhookErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The signing secret of a page webhook: derived from its salt and the server's secret, never stored. */
export function pageWebhookSecret(salt: string) {
  return `whsec_${createHmac("sha256", env.authSecret).update(`page-webhook:${salt}`).digest("base64url")}`;
}

export type PageWebhookInput = {
  name: string;
  url: string;
  events: readonly string[];
  scope: PageWebhookScope;
  teamspaceId?: string | null;
  pageId?: string | null;
  enabled?: boolean;
};

export type PageWebhookView = {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  events: PageWebhookEvent[];
  scope: PageWebhookScope;
  teamspace: { id: string; name: string } | null;
  page: { id: string; title: string; icon: string | null; kind: string } | null;
  enabled: boolean;
  paused: PageWebhookPause | null;
  /** Who saved it last: deliveries go out as them. */
  owner: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type PageWebhookDeliveryView = {
  id: string;
  event: string;
  pageId: string | null;
  status: DeliveryStatus;
  attempts: number;
  httpStatus: number | null;
  code: DeliveryCode | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** The owners of the workspace only; guests and members read as not found. */
async function requireOwner(userId: string, workspaceId: string) {
  await requireMembership(userId, workspaceId, "owner");
}

async function loadViews(workspaceId: string, id?: string): Promise<PageWebhookView[]> {
  const rows = await db
    .select({
      hook: pageWebhook,
      teamspaceName: teamspace.name,
      pageTitle: page.title,
      pageIcon: page.icon,
      pageKind: page.kind,
      ownerName: user.name,
    })
    .from(pageWebhook)
    .leftJoin(teamspace, eq(teamspace.id, pageWebhook.teamspaceId))
    .leftJoin(page, eq(page.id, pageWebhook.pageId))
    .leftJoin(user, eq(user.id, pageWebhook.ownerId))
    .where(id ? and(eq(pageWebhook.workspaceId, workspaceId), eq(pageWebhook.id, id)) : eq(pageWebhook.workspaceId, workspaceId))
    .orderBy(pageWebhook.createdAt);
  return rows.map(({ hook, teamspaceName, pageTitle, pageIcon, pageKind, ownerName }) => ({
    id: hook.id,
    workspaceId: hook.workspaceId,
    name: hook.name,
    url: hook.url,
    events: hook.events,
    scope: hook.scope,
    teamspace: hook.teamspaceId ? { id: hook.teamspaceId, name: teamspaceName ?? "" } : null,
    page: hook.pageId ? { id: hook.pageId, title: pageLabel(pageTitle ?? ""), icon: pageIcon, kind: pageKind ?? "page" } : null,
    enabled: hook.enabled,
    paused: hook.paused,
    owner: hook.ownerId ? { id: hook.ownerId, name: ownerName ?? "" } : null,
    createdAt: hook.createdAt.toISOString(),
    updatedAt: hook.updatedAt.toISOString(),
  }));
}

/** The webhook, for an owner of its workspace; AccessError otherwise, as for one that doesn't exist. */
async function ownedWebhook(userId: string, webhookId: string) {
  const [found] = await db.select().from(pageWebhook).where(eq(pageWebhook.id, webhookId)).limit(1);
  if (!found) throw new AccessError();
  await requireOwner(userId, found.workspaceId);
  return found;
}

export async function listPageWebhooks(userId: string, workspaceId: string) {
  await requireOwner(userId, workspaceId);
  return loadViews(workspaceId);
}

export async function getPageWebhook(userId: string, webhookId: string) {
  const found = await ownedWebhook(userId, webhookId);
  const [view] = await loadViews(found.workspaceId, found.id);
  return view;
}

/**
 * An address webhooks may go to: https, or plain http for a host on AUTOMATION_WEBHOOK_ALLOWED_HOSTS
 * (a service on the server's own network). Where it points is checked when sending, as for
 * automation webhooks.
 */
export function checkedWebhookUrl(value: string) {
  let url: URL;
  try {
    url = parseWebhookUrl(value);
  } catch (error) {
    if (error instanceof WebhookError) throw new PageWebhookError("invalidUrl", error.message);
    throw error;
  }
  if (url.protocol !== "https:" && !allowedHost(url)) throw new PageWebhookError("httpsOnly", "Webhooks go to https addresses");
  return url.toString();
}

/** What a create or a change asks for, checked: the scope's teamspace or page must be the workspace's and visible to the owner. */
async function checkedInput(userId: string, workspaceId: string, input: PageWebhookInput) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_PAGE_WEBHOOK_NAME) throw new PageWebhookError("invalidName", `A webhook needs a name of up to ${MAX_PAGE_WEBHOOK_NAME} characters`);
  const url = checkedWebhookUrl(typeof input.url === "string" ? input.url : "");
  const events = normalizeEvents(Array.isArray(input.events) ? input.events : []);
  if (!events) throw new PageWebhookError("noEvents", "Choose at least one event");
  let teamspaceId: string | null = null;
  let pageId: string | null = null;
  if (input.scope === "teamspace") {
    if (!input.teamspaceId) throw new PageWebhookError("invalidScope", "Choose a teamspace");
    const found = await getTeamspace(userId, input.teamspaceId).catch(() => null);
    if (!found || found.workspaceId !== workspaceId) throw new PageWebhookError("invalidScope", "No such teamspace in this workspace");
    teamspaceId = found.id;
  } else if (input.scope === "page") {
    if (!input.pageId) throw new PageWebhookError("invalidScope", "Choose a page");
    const found = await requirePageAccess(userId, input.pageId, "view").catch(() => null);
    if (!found || found.workspaceId !== workspaceId || found.archivedAt || found.isTemplate || found.inTemplate) {
      throw new PageWebhookError("invalidScope", "No such page in this workspace");
    }
    pageId = found.id;
  } else if (input.scope !== "workspace") {
    throw new PageWebhookError("invalidScope", "The scope is workspace, teamspace or page");
  }
  return { name, url, events, scope: input.scope, teamspaceId, pageId };
}

/** Adds a webhook; it sends as `userId`. Returns it with its signing secret. */
export async function createPageWebhook(userId: string, workspaceId: string, input: PageWebhookInput) {
  await requireOwner(userId, workspaceId);
  const checked = await checkedInput(userId, workspaceId, input);
  const [{ n }] = await db.select({ n: count() }).from(pageWebhook).where(eq(pageWebhook.workspaceId, workspaceId));
  if (n >= MAX_PAGE_WEBHOOKS) throw new PageWebhookError("tooMany", `A workspace has up to ${MAX_PAGE_WEBHOOKS} webhooks`);
  const salt = newSecretSalt();
  const [created] = await db
    .insert(pageWebhook)
    .values({ workspaceId, ...checked, secretSalt: salt, ownerId: userId, enabled: input.enabled ?? true })
    .returning({ id: pageWebhook.id });
  await recordAudit({
    workspaceId,
    actorId: userId,
    action: "webhook.created",
    target: { type: "webhook", id: created.id, label: checked.name },
    details: { events: checked.events, scope: checked.scope },
  });
  const [view] = await loadViews(workspaceId, created.id);
  return { webhook: view, secret: pageWebhookSecret(salt) };
}

/**
 * Changes a webhook. Saving it makes `userId` the person it sends as, and lifts a pause it took
 * when the one before stopped being an owner.
 */
export async function updatePageWebhook(userId: string, webhookId: string, patch: Partial<PageWebhookInput>) {
  const found = await ownedWebhook(userId, webhookId);
  const checked = await checkedInput(userId, found.workspaceId, {
    name: patch.name ?? found.name,
    url: patch.url ?? found.url,
    events: patch.events ?? found.events,
    scope: patch.scope ?? found.scope,
    teamspaceId: patch.scope !== undefined || patch.teamspaceId !== undefined ? patch.teamspaceId : found.teamspaceId,
    pageId: patch.scope !== undefined || patch.pageId !== undefined ? patch.pageId : found.pageId,
  });
  const enabled = patch.enabled ?? found.enabled;
  await db
    .update(pageWebhook)
    .set({ ...checked, enabled, ownerId: userId, paused: null, updatedAt: new Date() })
    .where(eq(pageWebhook.id, webhookId));
  await recordAudit({
    workspaceId: found.workspaceId,
    actorId: userId,
    action: "webhook.updated",
    target: { type: "webhook", id: found.id, label: checked.name },
    details: { enabled, previous: { enabled: found.enabled } },
  });
  const [view] = await loadViews(found.workspaceId, found.id);
  return view;
}

export async function deletePageWebhook(userId: string, webhookId: string) {
  const found = await ownedWebhook(userId, webhookId);
  await db.delete(pageWebhook).where(eq(pageWebhook.id, webhookId));
  await recordAudit({
    workspaceId: found.workspaceId,
    actorId: userId,
    action: "webhook.deleted",
    target: { type: "webhook", id: found.id, label: found.name },
  });
  return { workspaceId: found.workspaceId };
}

/** The webhook's signing secret, for an owner; with `rotate`, a new one first (the old one stops signing at once). */
export async function pageWebhookSecretFor(userId: string, webhookId: string, rotate = false) {
  const found = await ownedWebhook(userId, webhookId);
  if (!rotate) return pageWebhookSecret(found.secretSalt);
  const salt = newSecretSalt();
  await db.update(pageWebhook).set({ secretSalt: salt, updatedAt: new Date() }).where(eq(pageWebhook.id, webhookId));
  await recordAudit({
    workspaceId: found.workspaceId,
    actorId: userId,
    action: "webhook.updated",
    target: { type: "webhook", id: found.id, label: found.name },
    details: { secret: "replaced" },
  });
  return pageWebhookSecret(salt);
}

/** The webhook's delivery log (kept DELIVERY_LOG_DAYS), newest first. */
export async function listPageWebhookDeliveries(userId: string, webhookId: string, limit = 50): Promise<PageWebhookDeliveryView[]> {
  await ownedWebhook(userId, webhookId);
  const rows = await db
    .select()
    .from(pageWebhookDelivery)
    .where(eq(pageWebhookDelivery.webhookId, webhookId))
    .orderBy(desc(pageWebhookDelivery.createdAt))
    .limit(Math.min(Math.max(1, limit), 200));
  return rows.map((d) => ({
    id: d.id,
    event: d.event,
    pageId: d.pageId,
    status: d.status,
    attempts: d.attempts,
    httpStatus: d.httpStatus,
    code: d.code,
    error: d.error,
    nextAttemptAt: d.status === "pending" && d.nextAttemptAt ? d.nextAttemptAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
  }));
}

/** For ./deliver.ts: the webhook a test goes to, for an owner. */
export const webhookForTest = ownedWebhook;
