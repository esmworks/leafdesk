/**
 * End-to-end check of push notifications against the database, with no browser: a "push service"
 * this script starts on 127.0.0.1 (allowed through PUSH_ALLOWED_HOSTS) stands in for the one a
 * browser would pick, and the script holds the browser's keys, so it can read what arrives.
 * - a real notification (assigning someone to a row, mentioning them) reaches their device as an
 *   encrypted POST: TTL, urgency, aes128gcm, a VAPID signature for the push service's origin, and
 *   a payload that says what the inbox says, in the recipient's language, leading to the page;
 * - preferences: push follows the inbox, and can be turned off per kind;
 * - devices whose sign-in ended get nothing, and signing out deletes the subscription;
 * - a 410 deletes the subscription, other failures are counted; an endpoint on a private address
 *   is refused when subscribing and never contacted when sending;
 * - without VAPID keys nothing is sent.
 * Creates its own users and workspace (and throwaway VAPID keys) and deletes them afterwards.
 *
 *   pnpm tsx scripts/push-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import webpush from "web-push";

try {
  process.loadEnvFile();
} catch {}

// The push service: records each request and answers with the next queued status (201 by default).
type Received = { path: string; headers: http.IncomingHttpHeaders; body: Buffer };
const received: Received[] = [];
/** How many messages came in (a function, so assertions about one count don't narrow the next). */
const count = () => received.length;
let answers: number[] = [];
const service = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(answers.shift() ?? 201);
    res.end();
  });
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const port = (service.address() as AddressInfo).port;
const serviceOrigin = `http://127.0.0.1:${port}`;
process.env.PUSH_ALLOWED_HOSTS = `127.0.0.1:${port}`;
const vapidKeys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
process.env.VAPID_SUBJECT = "mailto:push-e2e@example.test";

// Imported after the environment is set: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { notification, pushSubscription, session, user, userPreference, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, createRows, updateRowProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { recordMentions } = await import("@/server/notifications");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { flushPush, PushSubscriptionError, savePushSubscription } = await import("@/server/push");
const { env } = await import("@/lib/env");

registerCollab({
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle() {},
} as unknown as Parameters<typeof registerCollab>[0]);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

/** A browser's side of a subscription: its key pair and auth secret. */
function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16) };
}
type Browser = ReturnType<typeof browserKeys>;

/** Decrypts an aes128gcm push message (RFC 8188, keys as in RFC 8291) the way the browser would. */
function decrypt(browser: Browser, body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const serverKey = body.subarray(21, 21 + idLength);
  const content = body.subarray(21 + idLength);
  const shared = browser.ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), browser.ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, browser.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(content.subarray(content.length - 16));
  const plain = Buffer.concat([decipher.update(content.subarray(0, content.length - 16)), decipher.final()]);
  // The last record ends with 0x02, then padding.
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
}

/** Checks the VAPID header: signed by the server's key, for the push service's origin. */
function vapidClaims(authorization: string | undefined) {
  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(authorization ?? "");
  if (!match) return null;
  const [header, payload, signature] = match[1].split(".");
  const point = Buffer.from(match[2], "base64url");
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
  const valid = verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  return { valid, key: match[2], ...(JSON.parse(Buffer.from(payload, "base64url").toString()) as { aud: string; sub: string; exp: number }) };
}

const RUN = `push-e2e-${Date.now().toString(36)}`;
const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const subscriptionOf = (endpoint: string) => db.select().from(pushSubscription).where(eq(pushSubscription.endpoint, endpoint));

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const now = new Date();
  const later = new Date(Date.now() + 24 * 60 * 60_000);
  await db.insert(session).values([
    { id: `${RUN}-s1`, token: `${RUN}-t1`, userId: ids.member, expiresAt: later, createdAt: now, updatedAt: now },
    { id: `${RUN}-s2`, token: `${RUN}-t2`, userId: ids.member, expiresAt: new Date(Date.now() - 60_000), createdAt: now, updatedAt: now },
  ]);

  // ------------------------------------------------------------------ subscribing
  const phone = browserKeys();
  const phoneEndpoint = `${serviceOrigin}/push/phone`;
  await savePushSubscription(ids.member, `${RUN}-s1`, { endpoint: phoneEndpoint, p256dh: phone.p256dh, auth: phone.auth.toString("base64url") }, "Mozilla/5.0 (iPhone)");
  check((await subscriptionOf(phoneEndpoint)).length === 1, "a browser's subscription is kept for its user and sign-in");
  const refused = async (endpoint: string) =>
    savePushSubscription(ids.member, `${RUN}-s1`, { endpoint, p256dh: phone.p256dh, auth: phone.auth.toString("base64url") }, null).then(
      () => false,
      (error) => error instanceof PushSubscriptionError,
    );
  check(await refused("http://10.0.0.1/push"), "a plain-http endpoint off the allowed hosts is refused");
  check(await refused("javascript:alert(1)"), "…and so is anything that isn't an address");
  // Well-formed, but on a private address: kept, and refused when sending (see below).
  const internal = browserKeys();
  const internalEndpoint = "https://127.0.0.1/push/internal";
  await savePushSubscription(ids.member, `${RUN}-s1`, { endpoint: internalEndpoint, p256dh: internal.p256dh, auth: internal.auth.toString("base64url") }, null);
  // A device whose sign-in ran out.
  const old = browserKeys();
  const oldEndpoint = `${serviceOrigin}/push/expired`;
  await savePushSubscription(ids.member, `${RUN}-s2`, { endpoint: oldEndpoint, p256dh: old.p256dh, auth: old.auth.toString("base64url") }, null);

  // ------------------------------------------------------------------ an assignment
  const owner = { userId: ids.owner };
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  const [first, second, third, fourth] = await createRows(ids.owner, tasks.id, [{ title: "Fix login" }, { title: "Write docs" }, { title: "Ship it" }, { title: "Tidy up" }]);
  await updateRowProperties(ids.owner, first.id, { Assignee: [ids.member] });
  await flushPush();
  check(count() === 1 && received[0].path === "/push/phone", "assigning someone pushes to their device, once", received.map((r) => r.path));
  const message = received[0];
  check(message.headers.ttl === "86400", "the message is kept a day at most (TTL)", message.headers);
  check(message.headers.urgency === "normal", "…with normal urgency", message.headers);
  check(message.headers["content-encoding"] === "aes128gcm" && message.headers["content-type"] === "application/octet-stream", "…encrypted as aes128gcm", message.headers);
  const claims = vapidClaims(message.headers.authorization);
  check(claims?.valid && claims.key === vapidKeys.publicKey, "…signed with the server's VAPID key", message.headers.authorization);
  check(claims.aud === serviceOrigin && claims.sub === "mailto:push-e2e@example.test" && claims.exp * 1000 > Date.now(), "…for the push service's origin, with the subject", claims);
  check(message.body.length > 0 && message.body.length < 4096, "…and fits what push services take", message.body.length);
  const [assigned] = await db
    .select({ id: notification.id })
    .from(notification)
    .where(and(eq(notification.userId, ids.member), eq(notification.pageId, first.id)));
  const payload = JSON.parse(decrypt(phone, message.body));
  check(
    payload.title === "Fix login" &&
      payload.body === "Owner Olcay assigned you to “Assignee” · Tasks" &&
      payload.url === `${env.appUrl}/w/${workspaceId}/p/${first.id}` &&
      payload.tag === assigned.id,
    "the browser reads what the inbox says, the row's link and the notification as its tag",
    payload,
  );
  check(Buffer.byteLength(decrypt(phone, message.body)) < 3_000, "…in under 3 KB");
  check(!received.some((r) => r.path === "/push/expired"), "a device whose sign-in ran out gets nothing");
  const [phoneRow] = await subscriptionOf(phoneEndpoint);
  check(phoneRow.lastUsedAt !== null && phoneRow.failureCount === 0, "a send that went through is recorded", phoneRow);
  const [internalRow] = await subscriptionOf(internalEndpoint);
  check(internalRow?.failureCount === 1 && internalRow.lastUsedAt === null, "an endpoint on a private address is never contacted, and counts as a failure", internalRow);
  await db.delete(pushSubscription).where(eq(pushSubscription.endpoint, internalEndpoint));

  // ------------------------------------------------------------------ a mention, in their language
  await db.insert(userPreference).values({ userId: ids.member, locale: "tr" }).onConflictDoUpdate({ target: userPreference.userId, set: { locale: "tr" } });
  const plan = await createPage(owner, { workspaceId, title: "Plan" });
  received.splice(0);
  await recordMentions(ids.owner, workspaceId, plan.id, [{ userId: ids.member, mentionId: "m1" }], "en");
  await flushPush();
  const mention = count() === 1 ? JSON.parse(decrypt(phone, received[0].body)) : null;
  check(mention?.title === "Plan" && mention.body === "Owner Olcay sizden bahsetti", "a mention is pushed in the recipient's language", mention);

  // ------------------------------------------------------------------ preferences
  received.splice(0);
  await setNotificationPreference(ids.member, "assignment", "push", false);
  await updateRowProperties(ids.owner, second.id, { Assignee: [ids.member] });
  await flushPush();
  check(count() === 0, "turning push off for a kind stops it, while the inbox keeps it");
  await setNotificationPreference(ids.member, "assignment", "push", true);
  await setNotificationPreference(ids.member, "assignment", "inbox", false);
  await updateRowProperties(ids.owner, third.id, { Assignee: [ids.member] });
  await flushPush();
  check(count() === 0, "a kind kept out of the inbox isn't pushed either");
  await setNotificationPreference(ids.member, "assignment", "inbox", true);

  // ------------------------------------------------------------------ the push service's answers
  answers = [500];
  await updateRowProperties(ids.owner, fourth.id, { Assignee: [ids.member] });
  await flushPush();
  const [failing] = await subscriptionOf(phoneEndpoint);
  check(count() === 1 && failing?.failureCount === 1, "a failed send is counted and the subscription kept", failing);
  received.splice(0);
  answers = [410];
  await updateRowProperties(ids.owner, first.id, { Assignee: [] });
  await updateRowProperties(ids.owner, first.id, { Assignee: [ids.member] });
  await flushPush();
  check(count() === 1 && (await subscriptionOf(phoneEndpoint)).length === 0, "a 410 (the browser unsubscribed) deletes the subscription");

  // ------------------------------------------------------------------ signing out, and no keys
  await savePushSubscription(ids.member, `${RUN}-s1`, { endpoint: phoneEndpoint, p256dh: phone.p256dh, auth: phone.auth.toString("base64url") }, null);
  check((await subscriptionOf(phoneEndpoint)).length === 1, "subscribing again brings it back");
  await db.delete(session).where(eq(session.id, `${RUN}-s1`));
  check((await subscriptionOf(phoneEndpoint)).length === 0, "signing out (the session going) deletes the subscription");

  await db.insert(session).values({ id: `${RUN}-s3`, token: `${RUN}-t3`, userId: ids.member, expiresAt: later, createdAt: now, updatedAt: now });
  await savePushSubscription(ids.member, `${RUN}-s3`, { endpoint: phoneEndpoint, p256dh: phone.p256dh, auth: phone.auth.toString("base64url") }, null);
  delete process.env.VAPID_PRIVATE_KEY;
  received.splice(0);
  await updateRowProperties(ids.owner, second.id, { Assignee: [] });
  await updateRowProperties(ids.owner, second.id, { Assignee: [ids.member] });
  await flushPush();
  check(count() === 0, "without VAPID keys nothing is sent");

  console.log(`\n${passed} checks passed`);
} finally {
  service.close();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
