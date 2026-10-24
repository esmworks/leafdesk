/**
 * End-to-end check of page webhooks against the database: only owners manage them and what is
 * refused when saving; which page events reach which subscriptions (the whole workspace, a
 * teamspace, a page and the pages under it; rows and templates never); edits waiting until the page
 * is left alone; signed deliveries with the event in X-Leafdesk-Event; pages the subscription's
 * person can't open skipped; the export switch; retries, failures and the test ping; pausing when
 * the person stops being an owner; the 30-day log; the audit log.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/page-webhooks-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own sender would take the queued deliveries.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export {};

try {
  process.loadEnvFile();
} catch {}

// Deliveries go to a server on this machine, which only allowed hosts may reach.
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let answers: number[] = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.writeHead(answers.shift() ?? 200);
    res.end();
  });
});
await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const port = (receiver.address() as AddressInfo).port;
process.env.AUTOMATION_WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${port}`;
const hookUrl = `http://127.0.0.1:${port}/hook`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, pageWebhook, pageWebhookDelivery, pageWebhookPending, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage, archivePage, restorePage, deletePagePermanently, movePage } = await import("@/server/pages");
const manage = await import("@/server/page-webhooks/manage");
const { runPageWebhooks, sendTestDelivery } = await import("@/server/page-webhooks/deliver");
const { queuePageUpdated, queueCommentCreated } = await import("@/server/page-webhooks/queue");
const { createTeamspace } = await import("@/server/teamspaces");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { MAX_WEBHOOK_ATTEMPTS } = await import("@/lib/automations");

const RUN = `page-webhooks-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
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

async function refused(promise: Promise<unknown>, code: string) {
  return promise.then(
    () => false,
    (error: unknown) => (code === "access" ? error instanceof AccessError : (error as { code?: string }).code === code),
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, second: `${RUN}-second` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** A moment `ms` from now, for rounds that should find what waits until then. */
const later = (ms: number) => new Date(Date.now() + ms);

/** Runs rounds until nothing is due as of `at`, and returns what the receiver got meanwhile. */
async function deliverAll(at: Date) {
  const before = received.length;
  while ((await runPageWebhooks(at)) > 0) {}
  return received.slice(before).map((r) => ({ headers: r.headers, body: JSON.parse(r.body) as Record<string, any>, raw: r.body }));
}

const deliveriesOf = (webhookId: string) =>
  db.select().from(pageWebhookDelivery).where(eq(pageWebhookDelivery.webhookId, webhookId)).orderBy(pageWebhookDelivery.createdAt);

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.second, name: "Second Selin", email: `${ids.second}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.second, role: "owner" },
  ]);
  const owner = { userId: ids.owner };
  const space = await createTeamspace(ids.owner, workspaceId, { name: "Docs", access: "open" });

  // ---------------------------------------------------------------------------- managing them
  const base = { name: "All pages", url: hookUrl, events: ["page.created", "page.updated", "page.moved", "page.trashed", "page.restored", "page.deleted", "comment.created"], scope: "workspace" as const };
  check(await refused(manage.listPageWebhooks(ids.member, workspaceId), "access"), "members can't list webhooks");
  check(await refused(manage.createPageWebhook(ids.member, workspaceId, base), "access"), "…nor add one");
  check(await refused(manage.createPageWebhook(ids.owner, workspaceId, { ...base, url: "http://example.com/hook" }), "httpsOnly"), "plain http is refused (but for allowed hosts)");
  check(await refused(manage.createPageWebhook(ids.owner, workspaceId, { ...base, url: "ftp://example.com" }), "invalidUrl"), "an address that isn't http(s) is refused");
  check(await refused(manage.createPageWebhook(ids.owner, workspaceId, { ...base, events: ["page.renamed"] }), "noEvents"), "a webhook needs a known event");
  check(await refused(manage.createPageWebhook(ids.owner, workspaceId, { ...base, scope: "teamspace", teamspaceId: "nope" }), "invalidScope"), "a teamspace scope needs a teamspace of the workspace");
  check(await refused(manage.createPageWebhook(ids.owner, workspaceId, { ...base, name: " " }), "invalidName"), "a webhook needs a name");

  const all = await manage.createPageWebhook(ids.owner, workspaceId, base);
  check(all.secret.startsWith("whsec_") && all.webhook.owner?.id === ids.owner, "an owner adds one and gets its secret", all.webhook);
  check((await manage.pageWebhookSecretFor(ids.owner, all.webhook.id)) === all.secret, "the secret can be shown again");
  const docs = await createPage(owner, { workspaceId, title: "Handbook", teamspaceId: space.id });
  const spaceHook = await manage.createPageWebhook(ids.owner, workspaceId, { ...base, name: "Docs space", scope: "teamspace", teamspaceId: space.id, events: ["page.created", "page.trashed"] });
  const subtreeHook = await manage.createPageWebhook(ids.owner, workspaceId, { ...base, name: "Handbook", scope: "page", pageId: docs.id, events: ["page.created", "page.moved", "comment.created"] });
  check((await manage.listPageWebhooks(ids.second, workspaceId)).length === 3, "every owner sees the workspace's webhooks");
  const audited = await db.select({ action: auditEvent.action }).from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "webhook.created")));
  check(audited.length === 3, "adding one is in the audit log", audited);
  await deliverAll(later(60_000)); // the Handbook's own page.created went to the workspace webhook only
  received.length = 0;

  // ------------------------------------------------------------------------------ which events
  const chapter = await createPage(owner, { workspaceId, parentId: docs.id, title: "Chapter" });
  check((await deliverAll(new Date())).length === 0, "page.created waits a few seconds");
  const created = await deliverAll(later(10_000));
  const createdFor = (id: string) => created.filter((d) => d.body.webhook.id === id).map((d) => d.body.page.title);
  check(createdFor(all.webhook.id).join() === "Chapter", "a new page goes to the workspace's webhook", created.map((d) => d.body));
  check(createdFor(spaceHook.webhook.id).join() === "Chapter", "…to its teamspace's");
  check(createdFor(subtreeHook.webhook.id).join() === "Chapter", "…and to one for a page above it");
  const first = created[0];
  check(first.headers["x-leafdesk-event"] === "page.created" && typeof first.headers["x-leafdesk-delivery"] === "string", "the event and the delivery are in headers", first.headers);
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(first.headers["x-leafdesk-signature"])) ?? [];
  const secretOf = (id: string) => (id === all.webhook.id ? all.secret : id === spaceHook.webhook.id ? spaceHook.secret : subtreeHook.secret);
  const expected = createHmac("sha256", secretOf(first.body.webhook.id)).update(`${t}.${first.raw}`).digest("hex");
  check(v1 === expected, "…signed with the webhook's secret like automation webhooks", first.headers["x-leafdesk-signature"]);
  check(first.body.page.parent_id === docs.id && first.body.actor?.id === ids.owner && first.body.page.url.includes(`/p/${chapter.id}`), "the body names the page, where it is and who did it", first.body);

  const database = await createPage(owner, { workspaceId, title: "Tasks", kind: "database", teamspaceId: space.id });
  await deliverAll(later(10_000));
  received.length = 0;
  await createPage(owner, { workspaceId, parentId: database.id, title: "A row" });
  await createPage(owner, { workspaceId, title: "A template", template: true, teamspaceId: space.id });
  check((await deliverAll(later(10_000))).length === 0, "database rows and templates send nothing");

  // A private page of someone else: the owner's webhook can't open it.
  await createPage({ userId: ids.member }, { workspaceId, title: "Mert's notes", teamspaceId: null });
  await deliverAll(later(10_000));
  const skipped = (await deliveriesOf(all.webhook.id)).filter((d) => d.status === "skipped");
  check(skipped.length === 1 && skipped[0].code === "noAccess", "a page the webhook's person can't open is skipped, unsent", skipped);

  // -------------------------------------------------------------------------------- edits wait
  received.length = 0;
  await queuePageUpdated(chapter.id, ids.owner, { title: true, body: false });
  await queuePageUpdated(chapter.id, ids.member, { title: false, body: true });
  check((await deliverAll(later(30_000))).length === 0, "edits wait until the page is left alone");
  const [pending] = await db.select().from(pageWebhookPending).where(eq(pageWebhookPending.pageId, chapter.id));
  check(pending?.title && pending.body, "…as one, with what changed", pending);
  const updated = await deliverAll(later(3 * 60_000));
  check(updated.length === 1 && updated[0].body.event === "page.updated", "a session of edits is one page.updated (only the webhook that listens)", updated.map((u) => u.body));
  check(updated[0].body.changes.title && updated[0].body.changes.body && updated[0].body.actor.id === ids.member, "…saying what changed and who edited last", updated[0].body);

  // ------------------------------------------------------------------------ moves, trash, comments
  received.length = 0;
  await movePage(ids.owner, chapter.id, null, undefined, space.id);
  const moved = await deliverAll(later(1000));
  check(
    moved.some((m) => m.body.webhook.id === subtreeHook.webhook.id && m.body.from.parent_id === docs.id) && moved.some((m) => m.body.webhook.id === all.webhook.id),
    "a page moved out from under the page goes to that page's webhook too, with where it was",
    moved.map((m) => m.body),
  );
  await queueCommentCreated(docs.id, ids.member, { threadId: "t1", commentId: "c1", reply: false, text: "Looks good" });
  const comments = await deliverAll(later(1000));
  check(comments.length === 2 && comments.every((c) => c.body.comment.text === "Looks good" && c.headers["x-leafdesk-event"] === "comment.created"), "a comment goes out with its text", comments.map((c) => c.body));

  received.length = 0;
  const inner = await createPage(owner, { workspaceId, parentId: chapter.id, title: "Section" });
  await deliverAll(later(10_000));
  received.length = 0;
  await archivePage(ids.owner, chapter.id);
  const trashed = await deliverAll(later(1000));
  check(
    trashed.length === 2 && trashed.every((d) => d.body.page.id === chapter.id && d.body.page.in_trash === true),
    "the trash sends one page.trashed for the page, not for the pages under it",
    trashed.map((d) => d.body),
  );
  await restorePage(ids.owner, chapter.id);
  const restored = await deliverAll(later(1000));
  check(restored.length === 1 && restored[0].body.event === "page.restored", "restoring it sends page.restored", restored.map((d) => d.body));
  await archivePage(ids.owner, inner.id);
  received.length = 0;
  await deletePagePermanently(ids.owner, inner.id);
  const deleted = await deliverAll(later(1000));
  check(
    deleted.length === 1 && deleted[0].body.page.deleted === true && deleted[0].body.page.title === "Section" && deleted[0].body.page.markdown === undefined,
    "deleting it for good sends page.deleted with its id and title",
    deleted.map((d) => d.body),
  );

  // ------------------------------------------------------------------------------- the switches
  await updateWorkspaceSettings(ids.owner, workspaceId, { export: false });
  await createPage(owner, { workspaceId, title: "While export is off", teamspaceId: space.id });
  check((await deliverAll(later(10_000))).length === 0, "nothing goes out while export is off");
  const offCodes = (await deliveriesOf(all.webhook.id)).filter((d) => d.code === "exportOff");
  check(offCodes.length === 1 && offCodes[0].status === "skipped", "…the log says why", offCodes);
  await updateWorkspaceSettings(ids.owner, workspaceId, { export: true });

  received.length = 0;
  answers = [500];
  await createPage(owner, { workspaceId, title: "Retried", teamspaceId: space.id });
  await deliverAll(later(10_000));
  const [retry] = await db.select().from(pageWebhookDelivery).where(and(eq(pageWebhookDelivery.workspaceId, workspaceId), eq(pageWebhookDelivery.status, "pending")));
  check(retry && retry.attempts === 1 && retry.httpStatus === 500 && retry.nextAttemptAt! > new Date(), "a 500 is tried again later", retry);
  await deliverAll(later(2 * 60_000));
  const [done] = await db.select().from(pageWebhookDelivery).where(eq(pageWebhookDelivery.id, retry.id));
  const tries = received.filter((r) => r.headers["x-leafdesk-delivery"] === retry.id);
  check(done.status === "delivered" && done.attempts === 2 && tries.length === 2 && tries[0].body === tries[1].body, "…and the same body goes again", done);

  answers = [400];
  await createPage(owner, { workspaceId, title: "Refused", teamspaceId: space.id });
  await deliverAll(later(10_000));
  // Whichever of the two webhooks hearing about it was sent first got the 400.
  const [refusedOnce] = await db.select().from(pageWebhookDelivery).where(and(eq(pageWebhookDelivery.workspaceId, workspaceId), eq(pageWebhookDelivery.httpStatus, 400)));
  check(refusedOnce?.status === "failed" && refusedOnce.attempts === 1, "a 400 fails without trying again", refusedOnce);
  check(MAX_WEBHOOK_ATTEMPTS === 5, "deliveries are tried as often as automation webhooks");

  answers = [];
  const ping = await sendTestDelivery(ids.owner, all.webhook.id);
  check(ping?.status === "delivered" && JSON.parse(received.at(-1)!.body).event === "ping" && received.at(-1)!.headers["x-leafdesk-event"] === "ping", "Send test pings the address", ping);
  check(await refused(sendTestDelivery(ids.member, all.webhook.id), "access"), "…for owners only");

  // The person it sends as stops being an owner: it pauses until an owner saves it.
  await db.update(workspaceMember).set({ role: "member" }).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.owner)));
  received.length = 0;
  await createPage({ userId: ids.second }, { workspaceId, title: "After the demotion" });
  check((await deliverAll(later(10_000))).length === 0, "nothing goes out as someone who is no longer an owner");
  const [paused] = await db.select({ paused: pageWebhook.paused }).from(pageWebhook).where(eq(pageWebhook.id, all.webhook.id));
  check(paused.paused === "notOwner", "…and the webhook pauses", paused);
  const resaved = await manage.updatePageWebhook(ids.second, all.webhook.id, { enabled: true });
  check(resaved.paused === null && resaved.owner?.id === ids.second, "another owner saving it sends as them from then on", resaved);
  await createPage({ userId: ids.second }, { workspaceId, title: "Sent again" });
  check((await deliverAll(later(10_000))).some((d) => d.body.page.title === "Sent again"), "…and it sends again");

  const off = await manage.updatePageWebhook(ids.second, spaceHook.webhook.id, { enabled: false });
  check(!off.enabled, "a webhook can be turned off");
  const offAudit = await db.select({ details: auditEvent.details }).from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "webhook.updated")));
  check(offAudit.some((a) => (a.details as { enabled?: boolean }).enabled === false), "…which is in the audit log", offAudit);

  // ------------------------------------------------------------------------------------ the log
  const log = await manage.listPageWebhookDeliveries(ids.second, all.webhook.id);
  check(log.length > 5 && log[0].createdAt >= log.at(-1)!.createdAt, "the delivery log lists them, newest first");
  await db.update(pageWebhookDelivery).set({ createdAt: sql`now() - interval '31 days'` }).where(eq(pageWebhookDelivery.id, retry.id));
  await runPageWebhooks();
  check(!(await db.select().from(pageWebhookDelivery).where(eq(pageWebhookDelivery.id, retry.id))).length, "deliveries older than 30 days are forgotten");

  await manage.deletePageWebhook(ids.second, subtreeHook.webhook.id);
  check(!(await db.select().from(pageWebhook).where(eq(pageWebhook.id, subtreeHook.webhook.id))).length, "an owner removes a webhook, with its log");

  console.log(`\n${passed} checks passed`);
} finally {
  receiver.close();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
