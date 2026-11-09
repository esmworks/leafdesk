import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMessage, channelWebhook } from "@/db/schema";
import { env } from "@/lib/env";
import { plainText } from "@/lib/message-text";
import type { MessageData } from "@/lib/messages";
import { SlidingWindowLimiter, takeAll } from "@/lib/rate-limit";
import { slackPayloadBody, type SlackPayloadError } from "@/lib/slack-payload";
import { findMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { nextSeq } from "./channels";
import { MessageError, requireChannel, write } from "./core";

/**
 * Webhooks that post into a channel. A channel's admins (and the workspace's owners) make one with
 * a name, and get an address once: `APP_URL/api/messages/webhooks/<id>/<secret>`. Whatever posts to
 * a chat's incoming webhook can post there instead, with the same payload
 * (lib/slack-payload.ts), and is answered as such a webhook answers: `ok`, or what's wrong.
 *
 * A webhook's message has no author: it shows the webhook's name (`data.webhook`), notifies the
 * channel's people by their own settings, names nobody (a payload's mentions are words) and gets
 * no link previews. It stops working when its channel is archived or deleted, when the person who
 * made it leaves the workspace, and when an admin deletes it.
 */

/** Webhooks in one channel at most. */
export const MAX_WEBHOOKS_PER_CHANNEL = 10;
const MAX_NAME = 80;

// A webhook's budget: an alert storm or a build loop shouldn't drown a channel.
const perMinute = new SlidingWindowLimiter(30, 60_000);
const perHour = new SlidingWindowLimiter(600, 60 * 60_000);

export type WebhookView = { id: string; name: string; hint: string; createdBy: string | null; createdAt: string; lastUsedAt: string | null };

const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");
export const webhookUrl = (id: string, secret: string) => `${env.appUrl}/api/messages/webhooks/${id}/${secret}`;

function viewOf(row: typeof channelWebhook.$inferSelect): WebhookView {
  return { id: row.id, name: row.name, hint: row.hint, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null };
}

/** A channel's webhooks, for its admins. */
export async function listWebhooks(userId: string, channelId: unknown): Promise<WebhookView[]> {
  const { channel: row } = await requireChannel(userId, String(channelId ?? ""), "admin");
  const rows = await db.select().from(channelWebhook).where(eq(channelWebhook.channelId, row.id)).orderBy(asc(channelWebhook.createdAt));
  return rows.map(viewOf);
}

/** Makes a webhook for a channel; its address is in the answer, and only there. */
export async function createWebhook(userId: string, channelId: unknown, name: unknown): Promise<WebhookView & { url: string }> {
  const { channel: row } = await requireChannel(userId, String(channelId ?? ""), "admin");
  if (row.archivedAt) throw new MessageError("archived");
  const label = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
  if (!label) throw new MessageError("invalid", "A webhook needs a name");
  const secret = randomBytes(24).toString("base64url");
  const created = await db.transaction(async (tx) => {
    // One at a time per channel, so two clicks can't pass the limit together.
    await tx.select({ id: channel.id }).from(channel).where(eq(channel.id, row.id)).for("update");
    const [{ n }] = await tx.select({ n: count() }).from(channelWebhook).where(eq(channelWebhook.channelId, row.id));
    if (n >= MAX_WEBHOOKS_PER_CHANNEL) throw new MessageError("invalid", `A channel has at most ${MAX_WEBHOOKS_PER_CHANNEL} webhooks`);
    const [inserted] = await tx
      .insert(channelWebhook)
      .values({ channelId: row.id, workspaceId: row.workspaceId, name: label, secretHash: hashOf(secret), hint: secret.slice(-4), createdBy: userId })
      .returning();
    await recordAudit(
      { workspaceId: row.workspaceId, actorId: userId, action: "channel.webhook_created", target: { type: "channel", id: row.id, label: `#${row.name ?? ""}` }, details: { webhook: label } },
      tx,
    );
    return inserted;
  });
  return { ...viewOf(created), url: webhookUrl(created.id, secret) };
}

/** Deletes a webhook: its address stops working at once. Its messages stay. */
export async function deleteWebhook(userId: string, webhookId: unknown): Promise<void> {
  if (typeof webhookId !== "string" || !webhookId) throw new MessageError("notFound");
  const [hook] = await db.select().from(channelWebhook).where(eq(channelWebhook.id, webhookId)).limit(1);
  if (!hook) throw new MessageError("notFound");
  const { channel: row } = await requireChannel(userId, hook.channelId, "admin");
  await db.transaction(async (tx) => {
    await tx.delete(channelWebhook).where(eq(channelWebhook.id, hook.id));
    await recordAudit(
      { workspaceId: row.workspaceId, actorId: userId, action: "channel.webhook_deleted", target: { type: "channel", id: row.id, label: `#${row.name ?? ""}` }, details: { webhook: hook.name } },
      tx,
    );
  });
}

/** What a post to a webhook's address is answered: as a chat's incoming webhook answers. */
export type WebhookAnswer = { status: number; text: "ok" | SlackPayloadError | "no_service" | "channel_is_archived" | "rate_limited" | "action_prohibited" };

/** Posts `payload` as webhook `id`'s message, when `secret` is its own. */
export async function postFromWebhook(id: string, secret: string, payload: unknown, now = Date.now()): Promise<WebhookAnswer> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !secret || secret.length > 100) return { status: 404, text: "no_service" };
  const [found] = await db
    .select({ hook: channelWebhook, channel })
    .from(channelWebhook)
    .innerJoin(channel, eq(channel.id, channelWebhook.channelId))
    .where(eq(channelWebhook.id, id))
    .limit(1);
  const given = Buffer.from(hashOf(secret), "hex");
  if (!found || !timingSafeEqual(given, Buffer.from(found.hook.secretHash, "hex"))) return { status: 404, text: "no_service" };
  const { hook, channel: place } = found;
  if (place.archivedAt) return { status: 410, text: "channel_is_archived" };
  // Made by someone who has since left: it posts no more.
  if (!hook.createdBy || !(await findMembership(hook.createdBy, hook.workspaceId))) return { status: 403, text: "action_prohibited" };
  if (takeAll([[perMinute, hook.id], [perHour, hook.id]], now) > 0) return { status: 429, text: "rate_limited" };
  const made = slackPayloadBody(payload);
  if (!made.ok) return { status: 400, text: made.error };
  const messageId = crypto.randomUUID();
  const data: MessageData = { webhook: { id: hook.id, name: hook.name } };
  await write(place.workspaceId, async (tx, changed) => {
    const seq = await nextSeq(tx, place.id, changed.rev, true);
    await tx.insert(channelMessage).values({
      id: messageId,
      channelId: place.id,
      workspaceId: place.workspaceId,
      seq,
      threadId: null,
      authorId: null,
      body: made.body,
      plain: plainText(made.body),
      data,
      createdAt: new Date(now),
      rev: changed.rev,
    });
    await tx.update(channelWebhook).set({ lastUsedAt: new Date(now) }).where(and(eq(channelWebhook.id, hook.id)));
    changed.message(messageId);
    changed.channel(place.id);
    changed.sent(messageId);
  });
  return { status: 200, text: "ok" };
}
