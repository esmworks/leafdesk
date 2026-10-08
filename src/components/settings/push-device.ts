/**
 * This browser's push subscription (see server/push.ts): whether it can have one, the service
 * worker it belongs to, and dropping it at sign-out.
 */

/** Whether the browser has what push needs. Safari on iPhone and iPad has it only in an installed app. */
export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * The app's service worker, once registered (production builds register it on load; see
 * components/offline/install-app.tsx). Null when there is none within a few seconds.
 */
export async function appWorker(waitMs = 3_000): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const now = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
  if (now?.active) return now;
  return Promise.race([
    navigator.serviceWorker.ready.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
  ]);
}

/** The bytes of a base64url text (a VAPID public key). */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether a subscription was made with this server key (a new key needs a new subscription). */
export function madeWithKey(subscription: PushSubscription, key: Uint8Array) {
  const used = subscription.options.applicationServerKey;
  if (!used) return false;
  const bytes = new Uint8Array(used);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

/**
 * Sign-out: this browser stops getting push messages. The server already forgot the subscription
 * with the session; this drops it in the browser too. Never throws.
 */
export async function dropPushSubscription() {
  try {
    if (!pushSupported()) return;
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {}
}
