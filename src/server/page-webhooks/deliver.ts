import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pageWebhook, pageWebhookDelivery, user } from "@/db/schema";
import { MAX_WEBHOOK_ATTEMPTS, retryDelayMs } from "@/lib/automations";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { DELIVERY_LOG_DAYS, MAX_PAYLOAD_MARKDOWN, PING_EVENT, retriableCode, type DeliveryCode, type DeliveryDetails } from "@/lib/page-webhooks";
import { redactError } from "@/lib/redact";
import { findMembership, hasLevel, pageAccessOf } from "@/server/access";
import { sendWebhook, WebhookError } from "@/server/automations/webhook";
import { startSweep } from "@/server/sweep";
import { exportAllowed } from "@/server/workspaces";
import { pageWebhookSecret, webhookForTest } from "./manage";
import { releaseDueUpdates } from "./queue";

/**
 * Sends page webhook deliveries (queued by ./queue.ts), as signed JSON POSTs the way automation
 * webhooks are sent (server/automations/webhook.ts: the address checks, the signature and the
 * X-Leafdesk-* headers, with the event's name in X-Leafdesk-Event). Each goes out as the person who
 * saved the subscription last, checked when it is sent: they must still be an owner (else the
 * subscription pauses), the workspace must allow export, and they must be able to open the page
 * (with access worked out as `page_access_level` does, for every attempt). The body is made at the
 * first attempt, as they may see the page then, and sent again on each retry. Deliveries are kept
 * DELIVERY_LOG_DAYS.
 */

/** How often the server looks for deliveries that are due. */
const SWEEP_INTERVAL_MS = 5_000;
/** Deliveries one round sends at most; the next round goes on. */
const ROUND_LIMIT = 100;
/** A claimed delivery is held this long; one whose send never finished (the server stopped) is tried again after. */
const CLAIM_MS = 5 * 60_000;

type Delivery = typeof pageWebhookDelivery.$inferSelect;
type Hook = typeof pageWebhook.$inferSelect;

const appUrl = (workspaceId: string, pageId: string) => `${env.appUrl}/w/${workspaceId}/p/${pageId}`;

/** The body of a delivery, as `ownerId` may see the page now; null when they can't open it. */
async function payloadOf(delivery: Delivery, hook: Hook, ownerId: string): Promise<string | null> {
  const details: DeliveryDetails = delivery.details ?? {};
  const [actor] = details.actorId ? await db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, details.actorId)) : [];
  const base = {
    id: delivery.id,
    event: delivery.event,
    created_at: delivery.createdAt.toISOString(),
    webhook: { id: hook.id, name: hook.name },
    workspace_id: delivery.workspaceId,
    actor: actor ? { id: actor.id, name: actor.name } : null,
  };
  if (delivery.event === PING_EVENT) return JSON.stringify({ ...base, test: true });
  if (delivery.event === "page.deleted") {
    if (!details.deleted?.visible) return null;
    return JSON.stringify({ ...base, page: { id: delivery.pageId, title: pageLabel(details.deleted.title), kind: details.deleted.kind, deleted: true } });
  }
  if (!delivery.pageId) return null;
  const { page: found, level } = await pageAccessOf(ownerId, delivery.pageId);
  if (!found || !hasLevel(level, "view")) return null;
  const [body] = await db.select({ markdown: page.contentMarkdown, createdAt: page.createdAt }).from(page).where(eq(page.id, found.id));
  // Where it is, as far as they may see: a page above it they can't open isn't named.
  const parentId = found.parentId && hasLevel((await pageAccessOf(ownerId, found.parentId)).level, "view") ? found.parentId : null;
  const markdown = body?.markdown ?? "";
  const pageOut = {
    id: found.id,
    title: pageLabel(found.title),
    kind: found.kind,
    icon: found.icon,
    url: appUrl(found.workspaceId, found.id),
    parent_id: parentId,
    teamspace_id: found.teamspaceId,
    in_trash: Boolean(found.archivedAt),
    created_at: body?.createdAt.toISOString(),
    updated_at: found.updatedAt.toISOString(),
    markdown: markdown.slice(0, MAX_PAYLOAD_MARKDOWN),
    ...(markdown.length > MAX_PAYLOAD_MARKDOWN ? { markdown_truncated: true } : {}),
  };
  const extra =
    delivery.event === "page.updated"
      ? { changes: { title: Boolean(details.title), body: Boolean(details.body) } }
      : delivery.event === "page.moved" && details.from
        ? {
            from: {
              parent_id: details.from.parentId && hasLevel((await pageAccessOf(ownerId, details.from.parentId)).level, "view") ? details.from.parentId : null,
              teamspace_id: details.from.teamspaceId,
            },
          }
        : delivery.event === "comment.created" && details.comment
          ? {
              comment: {
                thread_id: details.comment.threadId,
                id: details.comment.commentId,
                reply: details.comment.reply,
                text: details.comment.text ?? "",
              },
            }
          : {};
  return JSON.stringify({ ...base, page: pageOut, ...extra });
}

async function finish(delivery: Delivery, status: "delivered" | "failed" | "skipped", result: { code?: DeliveryCode | null; error?: string | null; httpStatus?: number | null; payload?: string | null; attempts?: number }) {
  await db
    .update(pageWebhookDelivery)
    .set({
      status,
      code: result.code ?? null,
      error: result.error ?? null,
      httpStatus: result.httpStatus ?? null,
      attempts: result.attempts ?? delivery.attempts,
      ...(result.payload !== undefined ? { payload: result.payload } : {}),
      nextAttemptAt: null,
      finishedAt: new Date(),
    })
    .where(eq(pageWebhookDelivery.id, delivery.id));
}

/** Why a delivery can't go out now, or null when it may (the person, the subscription and the workspace's switch). */
async function holdOf(hook: Hook): Promise<DeliveryCode | null> {
  if (!hook.enabled) return "disabled";
  const membership = hook.ownerId ? await findMembership(hook.ownerId, hook.workspaceId) : null;
  if (!hook.ownerId || membership?.role !== "owner") {
    // It stops until an owner saves it again (manage.ts updatePageWebhook).
    if (!hook.paused) await db.update(pageWebhook).set({ paused: "notOwner" }).where(eq(pageWebhook.id, hook.id));
    return "notOwner";
  }
  if (!(await exportAllowed(hook.workspaceId))) return "exportOff";
  return null;
}

/** Sends one claimed delivery (or settles why it isn't sent), and returns how it went. */
export async function deliver(delivery: Delivery) {
  const [hook] = await db.select().from(pageWebhook).where(eq(pageWebhook.id, delivery.webhookId));
  if (!hook) return null;
  const hold = await holdOf(hook);
  if (hold) {
    await finish(delivery, "skipped", { code: hold });
    return { status: "skipped" as const, code: hold };
  }
  let payload = delivery.payload;
  if (delivery.attempts === 0 || !payload) {
    payload = await payloadOf(delivery, hook, hook.ownerId!);
    if (payload === null) {
      await finish(delivery, "skipped", { code: "noAccess" });
      return { status: "skipped" as const, code: "noAccess" as const };
    }
  }
  const attempts = delivery.attempts + 1;
  try {
    const httpStatus = await sendWebhook(hook.url, { id: delivery.id, event: delivery.event, body: payload, secret: pageWebhookSecret(hook.secretSalt) });
    await finish(delivery, "delivered", { httpStatus, payload, attempts });
    return { status: "delivered" as const, httpStatus };
  } catch (error) {
    if (!(error instanceof WebhookError)) throw error;
    const code: DeliveryCode = error.code;
    // A ping is a one-off: it reports how the address answered, without trying again.
    if (delivery.event !== PING_EVENT && retriableCode(code) && attempts < MAX_WEBHOOK_ATTEMPTS && (code !== "http" || retriableStatus(error.httpStatus))) {
      await db
        .update(pageWebhookDelivery)
        .set({ attempts, payload, code, error: error.message, httpStatus: error.httpStatus, nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)) })
        .where(eq(pageWebhookDelivery.id, delivery.id));
      return { status: "pending" as const, code, httpStatus: error.httpStatus, error: error.message };
    }
    await finish(delivery, "failed", { code, error: error.message, httpStatus: error.httpStatus, payload, attempts });
    return { status: "failed" as const, code, httpStatus: error.httpStatus, error: error.message };
  }
}

/** Whether an answer is worth trying again (408, 429 and 5xx, as for automation webhooks). */
const retriableStatus = (status: number | null) => status === null || status === 408 || status === 429 || status >= 500;

/** Claims due deliveries (one server at a time each), holding them for CLAIM_MS. */
async function claim(now: Date, limit: number) {
  return db
    .update(pageWebhookDelivery)
    .set({ nextAttemptAt: new Date(now.getTime() + CLAIM_MS) })
    .where(
      inArray(
        pageWebhookDelivery.id,
        sql`(select id from ${pageWebhookDelivery} where status = 'pending' and next_attempt_at <= ${now.toISOString()}::timestamptz order by next_attempt_at limit ${limit} for update skip locked)`,
      ),
    )
    .returning();
}

/**
 * One round as of `now`: edits that waited long enough become deliveries, due deliveries are sent,
 * and the log forgets what is older than DELIVERY_LOG_DAYS. Returns how many were sent or settled.
 */
export async function runPageWebhooks(now: Date = new Date()) {
  await releaseDueUpdates(now);
  const claimed = await claim(now, ROUND_LIMIT);
  for (const delivery of claimed) {
    try {
      await deliver(delivery);
    } catch (error) {
      console.error("[page-webhooks] could not send a delivery", redactError(error));
    }
  }
  await db
    .delete(pageWebhookDelivery)
    .where(and(lt(pageWebhookDelivery.createdAt, new Date(now.getTime() - DELIVERY_LOG_DAYS * 86_400_000)), ne(pageWebhookDelivery.status, "pending")));
  return claimed.length;
}

/** Sends a `ping` to the webhook now (*Send test*), for an owner, and says how it went. It is kept in the log. */
export async function sendTestDelivery(userId: string, webhookId: string) {
  const hook = await webhookForTest(userId, webhookId);
  const [created] = await db
    .insert(pageWebhookDelivery)
    .values({ webhookId: hook.id, workspaceId: hook.workspaceId, event: PING_EVENT, details: { actorId: userId }, nextAttemptAt: null })
    .returning();
  return deliver(created);
}

/** Starts the sender. */
export function startPageWebhooks() {
  return startSweep(SWEEP_INTERVAL_MS, () => runPageWebhooks(), "could not send page webhooks");
}
