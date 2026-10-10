import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import { db } from "@/db";
import { notification, pushSubscription, session } from "@/db/schema";
import { env } from "@/lib/env";
import { formatIsoDate } from "@/lib/mentions";
import { encodePushPayload, isAllowedPushHost, parsePushSubscription, pushPayload, type PushSubscriptionInput, type VapidConfig } from "@/lib/push";
import { checkTarget } from "@/server/link-preview";
import { recipientLocale } from "@/server/mail/locale";
import { emailTranslator } from "@/server/mail/templates";
import { getNotificationPreferences, pushWanted } from "@/server/notification-preferences";
import { listNotifications } from "@/server/notifications";

/**
 * Push notifications: each new inbox notification also goes, as a push message, to the browsers
 * where its recipient turned them on (Settings > Preferences), when the server has VAPID keys
 * (env.vapid). Sending never holds up or fails what caused the notification: it starts after the
 * notification is saved and runs on its own.
 *
 * A message says only what the inbox shows for the notification (server/notifications.ts reads it
 * with the same access checks), in the recipient's language, and leads where the inbox does. It is
 * encrypted for the browser (aes128gcm) and signed with the server's VAPID key; push services keep
 * it a day at most.
 *
 * The endpoint comes from the browser, so the server checks where it goes before each send, as it
 * does for webhooks: https only, the usual port, and every address of the host public, with the
 * connection pinned to the checked address. Hosts in PUSH_ALLOWED_HOSTS skip these checks (a push
 * service run next to the server). A push service that says the subscription is gone (404, 410)
 * gets it deleted; one that keeps failing, after MAX_FAILURES sends in a row.
 */

/** How long push services keep a message for a browser that is offline. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;
/** Failed sends in a row after which a subscription is dropped. */
const MAX_FAILURES = 10;
/** Devices one person may have at once; subscribing another drops the one used least recently. */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;
const PUSH_PORTS = new Set(["", "443"]);
const USER_AGENT = "Leafdesk-Push/1.0";

export function pushStatus(): "on" | "off" {
  return env.vapid ? "on" : "off";
}

/** The public key browsers subscribe with, or null when push is off. */
export function vapidPublicKey() {
  return env.vapid?.publicKey ?? null;
}

/** Sends that started and haven't finished. */
const sending = new Set<Promise<void>>();

/**
 * Pushes the notifications just saved (by id) to their recipients' devices, without waiting:
 * returns at once and never throws. Unread notifications only, of the kinds each person wants
 * pushed, that their inbox shows them.
 */
export function pushNotifications(ids: string[]) {
  if (!ids.length || !env.vapid) return;
  const delivery: Promise<void> = deliver(ids)
    .catch((error) => console.error("could not send push notifications", error))
    .finally(() => sending.delete(delivery));
  sending.add(delivery);
}

/** Scripts and tests: wait for the push notifications being sent. */
export async function flushPush() {
  while (sending.size) await Promise.all(sending);
}

type Subscription = typeof pushSubscription.$inferSelect;

async function deliver(ids: string[]) {
  const vapid = env.vapid;
  if (!vapid) return;
  const rows = await db
    .select({ id: notification.id, userId: notification.userId, kind: notification.kind, locale: notification.emailLocale })
    .from(notification)
    .where(and(inArray(notification.id, ids), isNull(notification.readAt)));
  if (!rows.length) return;
  const recipients = [...new Set(rows.map((r) => r.userId))];
  // Only devices whose sign-in is still valid.
  const subscriptions = await db
    .select({ subscription: pushSubscription })
    .from(pushSubscription)
    .innerJoin(session, eq(session.id, pushSubscription.sessionId))
    .where(and(inArray(pushSubscription.userId, recipients), gt(session.expiresAt, new Date())));
  const devices = new Map<string, Subscription[]>();
  for (const { subscription } of subscriptions) devices.set(subscription.userId, [...(devices.get(subscription.userId) ?? []), subscription]);
  await Promise.all(
    [...devices].map(async ([userId, targets]) => {
      const preferences = await getNotificationPreferences(userId);
      const theirs = rows.filter((r) => r.userId === userId && pushWanted(preferences, r.kind));
      if (!theirs.length) return;
      const items = await listNotifications(userId, { ids: theirs.map((r) => r.id), unreadOnly: true });
      if (!items.length) return;
      const locale = await recipientLocale(userId, theirs.find((r) => r.locale)?.locale);
      const t = emailTranslator(locale);
      const texts = (key: string, values?: Record<string, string>) => t(`push.${key}` as Parameters<typeof t>[0], values);
      for (const item of items) {
        const payload = pushPayload(item, texts, (date) => formatIsoDate(date, locale, "medium", "UTC"));
        if (!payload) continue;
        const json = encodePushPayload({ ...payload, url: `${env.appUrl}${payload.url}` });
        await Promise.all(targets.map((target) => sendTo(target, json, vapid)));
      }
    }),
  );
}

export class PushTargetError extends Error {}

/**
 * Where a push to `endpoint` may connect: the checked public address to pin the connection to,
 * or null for an allowed host, which the system resolves as usual. Throws when it may not go.
 */
export async function pushTarget(endpoint: URL, allowed = env.pushAllowedHosts): Promise<LookupAddress | null> {
  if (endpoint.username || endpoint.password) throw new PushTargetError("Credentials in the endpoint");
  if (isAllowedPushHost(endpoint, allowed)) {
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new PushTargetError("Only http(s) endpoints");
    return null;
  }
  if (endpoint.protocol !== "https:") throw new PushTargetError("Only https endpoints");
  try {
    return await checkTarget(endpoint, { ports: PUSH_PORTS });
  } catch (error) {
    throw new PushTargetError(error instanceof Error ? error.message : "Blocked endpoint");
  }
}

/** Sends one message to one device and records how it went; never throws. */
async function sendTo(target: Subscription, json: string, vapid: VapidConfig) {
  let status: number | null = null;
  try {
    status = await post(target, json, vapid);
  } catch (error) {
    console.error(`[push] could not reach ${new URL(target.endpoint).host}: ${error instanceof Error ? error.message : error}`);
  }
  try {
    if (status !== null && status >= 200 && status < 300) {
      await db.update(pushSubscription).set({ lastUsedAt: new Date(), failureCount: 0 }).where(eq(pushSubscription.id, target.id));
    } else if (status === 404 || status === 410) {
      // The browser unsubscribed, or the subscription expired.
      await db.delete(pushSubscription).where(eq(pushSubscription.id, target.id));
    } else {
      const [failed] = await db
        .update(pushSubscription)
        .set({ failureCount: sql`${pushSubscription.failureCount} + 1` })
        .where(eq(pushSubscription.id, target.id))
        .returning({ failures: pushSubscription.failureCount });
      if (failed && failed.failures >= MAX_FAILURES) await db.delete(pushSubscription).where(eq(pushSubscription.id, target.id));
    }
  } catch (error) {
    console.error("[push] could not record a send", error);
  }
}

/** The encrypted, signed POST to the push service; resolves with its status. */
async function post(target: Subscription, json: string, vapid: VapidConfig): Promise<number> {
  const url = new URL(target.endpoint);
  const address = await pushTarget(url);
  const details = webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, json, {
    vapidDetails: vapid,
    TTL: PUSH_TTL_SECONDS,
    urgency: "normal",
    contentEncoding: "aes128gcm",
  });
  const pinned: LookupFunction | undefined = address
    ? (_hostname, options, callback) => {
        if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [address]);
        else callback(null, address.address, address.family);
      }
    : undefined;
  const client = url.protocol === "https:" ? https : http;
  const signal = AbortSignal.timeout(PUSH_TIMEOUT_MS);
  const headers = { ...details.headers, "user-agent": USER_AGENT };
  return new Promise<number>((resolve, reject) => {
    const req = client.request(url, { method: "POST", ...(pinned ? { lookup: pinned } : {}), agent: false, signal, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(details.body ?? undefined);
  });
}

export class PushSubscriptionError extends Error {}

/**
 * Keeps a browser's subscription for `userId`, made in sign-in `sessionId`. The same browser
 * subscribing again (another user signed in on it, say) moves it over. Past
 * MAX_SUBSCRIPTIONS_PER_USER, the device used least recently is dropped.
 */
export async function savePushSubscription(userId: string, sessionId: string, input: unknown, userAgent: string | null) {
  const parsed: PushSubscriptionInput | null = parsePushSubscription(input, env.pushAllowedHosts);
  if (!parsed) throw new PushSubscriptionError("Not a valid push subscription");
  const agent = userAgent?.slice(0, 512) || null;
  await db
    .insert(pushSubscription)
    .values({ userId, sessionId, ...parsed, userAgent: agent })
    .onConflictDoUpdate({
      target: pushSubscription.endpoint,
      set: { userId, sessionId, p256dh: parsed.p256dh, auth: parsed.auth, userAgent: agent, failureCount: 0, createdAt: new Date() },
    });
  const devices = await db
    .select({ id: pushSubscription.id })
    .from(pushSubscription)
    .where(eq(pushSubscription.userId, userId))
    .orderBy(sql`coalesce(${pushSubscription.lastUsedAt}, ${pushSubscription.createdAt}) desc`);
  const extra = devices.slice(MAX_SUBSCRIPTIONS_PER_USER).map((d) => d.id);
  if (extra.length) await db.delete(pushSubscription).where(inArray(pushSubscription.id, extra));
  return parsed.endpoint;
}

/** Forgets a browser's subscription (turned off on that device). */
export async function deletePushSubscription(userId: string, endpoint: string) {
  await db.delete(pushSubscription).where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)));
}

/**
 * The endpoints of the person's devices that get push notifications, so a browser can tell
 * whether its own subscription is still known here.
 */
export async function pushEndpoints(userId: string): Promise<string[]> {
  const rows = await db
    .select({ endpoint: pushSubscription.endpoint })
    .from(pushSubscription)
    .innerJoin(session, eq(session.id, pushSubscription.sessionId))
    .where(and(eq(pushSubscription.userId, userId), gt(session.expiresAt, new Date())));
  return rows.map((r) => r.endpoint);
}
