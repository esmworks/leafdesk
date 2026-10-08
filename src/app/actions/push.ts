"use server";

import { headers } from "next/headers";
import { sharedLimiter, takeAll } from "@/lib/rate-limit";
import { deletePushSubscription, PushSubscriptionError, savePushSubscription, vapidPublicKey } from "@/server/push";
import { getSession, requireUserId } from "@/server/session";

export type PushSubscribeResult = { ok: true } | { ok: false; error: "unavailable" | "invalid" | "rateLimited" };

/** Enough to turn push on and off on a few devices, not to fill the table. */
const PER_HOUR = 30;

/**
 * Turns push notifications on for the browser that sends its subscription (`endpoint`, `p256dh`,
 * `auth`, as PushSubscription.toJSON() gives them), for the signed-in user and this sign-in.
 */
export async function subscribePushAction(subscription: { endpoint: string; p256dh: string; auth: string }): Promise<PushSubscribeResult> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  if (!vapidPublicKey()) return { ok: false, error: "unavailable" };
  if (takeAll([[sharedLimiter("push-subscribe", PER_HOUR, 60 * 60_000), session.user.id]]) > 0) return { ok: false, error: "rateLimited" };
  try {
    await savePushSubscription(session.user.id, session.session.id, subscription, (await headers()).get("user-agent"));
    return { ok: true };
  } catch (error) {
    if (error instanceof PushSubscriptionError) return { ok: false, error: "invalid" };
    throw error;
  }
}

/** Turns push notifications off for the browser with this endpoint. */
export async function unsubscribePushAction(endpoint: string) {
  const userId = await requireUserId();
  if (typeof endpoint !== "string" || !endpoint) return;
  await deletePushSubscription(userId, endpoint);
}
