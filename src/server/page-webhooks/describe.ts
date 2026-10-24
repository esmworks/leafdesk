import * as z from "zod";
import { MAX_WEBHOOK_URL } from "@/lib/automations";
import { MAX_PAGE_WEBHOOK_NAME, PAGE_WEBHOOK_EVENTS, PAGE_WEBHOOK_SCOPES } from "@/lib/page-webhooks";
import { pageUrl } from "@/server/mcp/format";
import type { PageWebhookDeliveryView, PageWebhookInput, PageWebhookView } from "./manage";

/** Page webhooks as the REST API takes and answers them (server/api/routes.ts). */

const fields = {
  name: z.string().max(MAX_PAGE_WEBHOOK_NAME).describe(`What it is for, up to ${MAX_PAGE_WEBHOOK_NAME} characters.`),
  url: z
    .string()
    .max(MAX_WEBHOOK_URL)
    .describe("The https address events are POSTed to (plain http only for hosts the server allows). Redirects aren't followed."),
  events: z
    .array(z.enum(PAGE_WEBHOOK_EVENTS))
    .min(1)
    .describe(`What it hears about: ${PAGE_WEBHOOK_EVENTS.join(", ")}. page.updated waits until the page is left alone for two minutes (at most 15).`),
  scope: z
    .enum(PAGE_WEBHOOK_SCOPES)
    .describe("Which pages: the whole workspace, one teamspace (teamspace_id) or a page and the pages under it (page_id). Database rows and templates are never sent."),
  teamspace_id: z.string().max(100).nullable().optional().describe('With scope "teamspace": its teamspace.'),
  page_id: z.string().max(100).nullable().optional().describe('With scope "page": the page.'),
  enabled: z.boolean().optional().describe("false keeps it without sending anything."),
};

export const webhookInputs = {
  create: z.object({ ...fields, scope: fields.scope.default("workspace") }),
  update: z.object({
    name: fields.name.optional(),
    url: fields.url.optional(),
    events: fields.events.optional(),
    scope: fields.scope.optional(),
    teamspace_id: fields.teamspace_id,
    page_id: fields.page_id,
    enabled: fields.enabled,
  }),
};

type CreateBody = z.infer<typeof webhookInputs.create>;
type UpdateBody = z.infer<typeof webhookInputs.update>;

export const toWebhookInput = (body: CreateBody): PageWebhookInput => ({
  name: body.name,
  url: body.url,
  events: body.events,
  scope: body.scope,
  teamspaceId: body.teamspace_id ?? null,
  pageId: body.page_id ?? null,
  enabled: body.enabled,
});

export const toWebhookPatch = (body: UpdateBody): Partial<PageWebhookInput> => ({
  ...(body.name !== undefined ? { name: body.name } : {}),
  ...(body.url !== undefined ? { url: body.url } : {}),
  ...(body.events !== undefined ? { events: body.events } : {}),
  ...(body.scope !== undefined ? { scope: body.scope } : {}),
  ...(body.teamspace_id !== undefined ? { teamspaceId: body.teamspace_id } : {}),
  ...(body.page_id !== undefined ? { pageId: body.page_id } : {}),
  ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
});

export function describeWebhook(view: PageWebhookView) {
  return {
    id: view.id,
    workspace_id: view.workspaceId,
    name: view.name,
    url: view.url,
    events: view.events,
    scope: view.scope,
    teamspace: view.teamspace,
    page: view.page ? { id: view.page.id, title: view.page.title, url: pageUrl(view.workspaceId, view.page.id) } : null,
    enabled: view.enabled,
    // "not_owner": the person it sent as is no longer an owner; saving it sends as the token's user.
    paused: view.paused === "notOwner" ? "not_owner" : null,
    sends_as: view.owner,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
}

const snake = (code: string | null) => (code ? code.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : null);

export function describeDelivery(d: PageWebhookDeliveryView) {
  return {
    id: d.id,
    event: d.event,
    page_id: d.pageId,
    status: d.status,
    attempts: d.attempts,
    http_status: d.httpStatus,
    reason: snake(d.code),
    error: d.error,
    next_attempt_at: d.nextAttemptAt,
    created_at: d.createdAt,
    finished_at: d.finishedAt,
  };
}
