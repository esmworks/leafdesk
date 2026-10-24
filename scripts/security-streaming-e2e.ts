/**
 * End-to-end check of the owners' security tools against the database: audit log streaming (who
 * may set it up, refused addresses, signed batches in order, waiting for a full batch or 30
 * seconds, retries with backoff under the same delivery id, the test event, turning it off, events
 * given up on after 7 days, a new secret); the REST API's audit log (the owner-only `audit:read`
 * scope, filters, the cursor); sensitive content detection (off by default, what is found in pages
 * and rows, masked, resolved, found again, dismissed, owners told at most once a day per page and
 * kind, the audit log, turning it off); and the people from the workspace's verified domains.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/security-streaming-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own sender and scanner would take the work.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export {};

try {
  process.loadEnvFile();
} catch {}

// Batches go to a server on this machine, which only allowed hosts may reach.
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
const streamUrl = `http://127.0.0.1:${port}/siem`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const schema = await import("@/db/schema");
const { account, auditEvent, auditStream, auditStreamOutbox, notification, page, sensitiveFinding, sensitiveScan, user, workspace, workspaceMember } = schema;
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage } = await import("@/server/pages");
const { recordAudit } = await import("@/server/audit");
const streams = await import("@/server/audit-stream");
const dlp = await import("@/server/sensitive-content");
const { addMembers, domainPeople, removeMember, updateWorkspaceSettings } = await import("@/server/workspaces");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");
const { AccessError } = await import("@/server/access");

const RUN = `sec-e2e-${Date.now().toString(36)}`;
const DOMAIN = `${RUN}.example.test`;

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async disconnectLostAccess() {},
  async disconnectUser() {},
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

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider`, elsewhere: `${RUN}-elsewhere` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

const later = (ms: number) => new Date(Date.now() + ms);
type Batch = { headers: http.IncomingHttpHeaders; raw: string; body: { id: string; type: string; workspace_id: string; test?: boolean; events: { id: string; action: string; details: Record<string, unknown>; actor: { id: string | null } }[] } };

/** Runs rounds as of `at` until none sends anything, and returns the batches the receiver got meanwhile. */
async function streamAll(at: Date): Promise<Batch[]> {
  const before = received.length;
  while ((await streams.runAuditStreams(at)) > 0) {}
  return received.slice(before).map((r) => ({ headers: r.headers, raw: r.body, body: JSON.parse(r.body) }));
}

const streamRow = async () => (await db.select().from(auditStream).where(eq(auditStream.workspaceId, workspaceId)))[0];
const waiting = async () => (await db.select().from(auditStreamOutbox).where(eq(auditStreamOutbox.workspaceId, workspaceId))).length;
const note = (n: number) =>
  recordAudit({ workspaceId, actorId: ids.owner, action: "workspace.renamed", target: { type: "workspace", id: workspaceId, label: RUN }, details: { n } });

function signedWith(secret: string, batch: Batch) {
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(batch.headers["x-leafdesk-signature"])) ?? [];
  return Boolean(t) && createHmac("sha256", secret).update(`${t}.${batch.raw}`).digest("hex") === v1;
}

async function api(token: string, query: string) {
  const response = await handleApiRequest(
    new Request(`http://localhost/api/v1/workspaces/${workspaceId}/audit-log${query}`, { headers: { authorization: `Bearer ${token}` } }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `olcay@${DOMAIN}`, emailVerified: true },
    { id: ids.member, name: "Member Mert", email: `mert@${DOMAIN}`, emailVerified: true },
    { id: ids.outsider, name: "Outside Oya", email: `oya@sales.${DOMAIN}`, emailVerified: true },
    { id: ids.elsewhere, name: "Else Ece", email: `ece@${RUN}-other.example.test`, emailVerified: true },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const owner = { userId: ids.owner };

  // ============================================================================ audit streaming
  check(await refused(streams.saveAuditStream(ids.member, workspaceId, { url: streamUrl }), "access"), "members can't set up streaming");
  check(await refused(streams.saveAuditStream(ids.owner, workspaceId, { url: "http://example.com/siem" }), "httpsOnly"), "plain http is refused (but for allowed hosts)");
  check(await refused(streams.saveAuditStream(ids.owner, workspaceId, { url: "ftp://example.com/x" }), "invalidUrl"), "an address that isn't http(s) is refused");
  check((await streams.getAuditStream(ids.owner, workspaceId)) === null, "nothing is streamed by default");
  await note(0);
  check((await waiting()) === 0, "…and nothing waits to be");

  const saved = await streams.saveAuditStream(ids.owner, workspaceId, { url: streamUrl });
  let secret = saved.secret!;
  check(secret.startsWith("whsec_") && saved.stream.enabled && saved.stream.url === streamUrl, "an owner starts streaming and gets the secret once", saved.stream);
  const [stored] = await db.select({ secret: auditStream.secret }).from(auditStream).where(eq(auditStream.workspaceId, workspaceId));
  check(!stored.secret.includes(secret.slice(6)), "the secret is kept sealed");
  check((await streams.saveAuditStream(ids.owner, workspaceId, { url: streamUrl })).secret === null, "saving again shows no secret");

  received.length = 0;
  for (let n = 1; n <= 3; n++) await note(n);
  check((await waiting()) === 5, "new events wait to be sent (two saves and three more)", await waiting());
  check((await streamAll(new Date())).length === 0, "a small batch waits");
  let batches = await streamAll(later(31_000));
  check(batches.length === 1 && batches[0].body.events.length === 5, "…up to 30 seconds, then goes as one", batches.map((b) => b.body.events.length));
  const batch = batches[0];
  check(batch.headers["x-leafdesk-event"] === "audit.events" && batch.headers["x-leafdesk-delivery"] === batch.body.id && batch.body.type === "audit.events", "the event and delivery are in headers and body", batch.headers);
  check(signedWith(secret, batch), "…signed with the stream's secret");
  const actions = batch.body.events.map((e) => e.action);
  check(actions.join() === "audit_stream.created,audit_stream.updated,workspace.renamed,workspace.renamed,workspace.renamed", "events go oldest first", actions);
  check(batch.body.events.slice(2).map((e) => e.details.n).join() === "1,2,3" && batch.body.events[2].actor.id === ids.owner, "…with who did what", batch.body.events[2]);
  let status = await streamRow();
  check((await waiting()) === 0 && status.sentEvents === 5 && status.lastSuccessAt && status.failures === 0, "sent events stop waiting and are counted", status);

  for (let n = 0; n < 150; n++) await note(100 + n);
  batches = await streamAll(new Date());
  check(batches.length === 1 && batches[0].body.events.length === 100, "a full batch of 100 goes at once", batches.map((b) => b.body.events.length));
  batches = await streamAll(later(31_000));
  check(batches.length === 1 && batches[0].body.events.length === 50 && batches[0].body.events[0].details.n === 200, "…the rest after it waited, in order", batches.map((b) => b.body.events.length));

  // ----------------------------------------------------------------------------------- retries
  await note(300);
  answers = [500];
  const t0 = Date.now();
  batches = await streamAll(new Date(t0 + 31_000));
  status = await streamRow();
  check(batches.length === 1 && status.failures === 1 && status.lastHttpStatus === 500 && status.lastErrorCode === "http" && status.failingSince, "a refused batch is recorded as failing", status);
  check(status.nextAttemptAt!.getTime() - (t0 + 31_000) === 30_000, "…and tried again 30 seconds later", status.nextAttemptAt);
  const view = await streams.getAuditStream(ids.owner, workspaceId);
  check(view?.status.failingSince && view.status.waiting === 1 && view.status.lastErrorCode === "http", "the settings show it failing, and what waits", view?.status);
  check((await streamAll(new Date(t0 + 45_000))).length === 0, "nothing is sent before then");
  await note(301);
  answers = [503];
  batches = await streamAll(new Date(t0 + 62_000));
  status = await streamRow();
  check(batches.length === 1 && status.failures === 2, "a second failure counts", status);
  const firstTry = received.at(-2)!;
  check(batches[0].headers["x-leafdesk-delivery"] === firstTry.headers["x-leafdesk-delivery"], "a batch tried again keeps its delivery id");
  check(status.nextAttemptAt!.getTime() - (t0 + 62_000) === 60_000, "…and the wait grows", status.nextAttemptAt);
  batches = await streamAll(new Date(t0 + 130_000));
  status = await streamRow();
  check(
    batches.length === 1 && batches[0].body.events.map((e) => e.details.n).join() === "300,301" && status.failures === 0 && status.failingSince === null && status.lastErrorCode === "http",
    "once it goes through, the stream is healthy again (the last error is kept)",
    status,
  );

  // ---------------------------------------------------------------------------------- the test
  const before = { ...(await streamRow()) };
  const ping = await streams.sendAuditStreamTest(ids.owner, workspaceId);
  const pinged = JSON.parse(received.at(-1)!.body);
  check(ping.ok && pinged.test === true && pinged.type === "ping" && received.at(-1)!.headers["x-leafdesk-event"] === "ping", "Send test event sends a signed ping", pinged);
  check(pinged.events[0].action === "audit_stream.test", "…with one made-up event");
  const afterPing = await streamRow();
  check(afterPing.sentEvents === before.sentEvents && (await waiting()) === 0, "…and changes nothing else");
  answers = [404];
  const failedPing = await streams.sendAuditStreamTest(ids.owner, workspaceId);
  check(!failedPing.ok && failedPing.httpStatus === 404, "a test says how the address answered", failedPing);
  check(await refused(streams.sendAuditStreamTest(ids.member, workspaceId), "access"), "…for owners only");

  // ------------------------------------------------------------------------------- off, stale
  await note(400);
  await streams.saveAuditStream(ids.owner, workspaceId, { enabled: false });
  check((await waiting()) === 0, "turning it off drops what waits");
  await note(401);
  check((await waiting()) === 0, "…and new events aren't kept for it");
  await streams.saveAuditStream(ids.owner, workspaceId, { enabled: true });
  await note(402);
  const offAudit = await db.select({ details: auditEvent.details }).from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "audit_stream.updated")));
  check(offAudit.some((a) => (a.details as { enabled?: boolean }).enabled === false), "turning it off is in the audit log", offAudit);
  batches = await streamAll(later(31_000));
  check(batches.length === 1 && batches[0].body.events.at(-1)!.details.n === 402 && !batches[0].body.events.some((e) => e.details.n === 401), "on again, it sends what happened since", batches[0]?.body.events.map((e) => e.details.n));

  await note(500);
  await db.update(auditStreamOutbox).set({ createdAt: sql`now() - interval '8 days'` }).where(eq(auditStreamOutbox.workspaceId, workspaceId));
  answers = [500, 500];
  await streams.runAuditStreams();
  status = await streamRow();
  check((await waiting()) === 0 && status.droppedEvents === 1 && status.lastDroppedAt, "events older than 7 days are given up on and counted", status);

  const rotated = await streams.replaceAuditStreamSecret(ids.owner, workspaceId);
  check(rotated !== secret && rotated.startsWith("whsec_"), "a new secret can be made");
  secret = rotated;
  await note(600);
  batches = await streamAll(later(31_000));
  check(batches.length === 1 && signedWith(secret, batches[0]), "…which signs from then on");
  answers = [];

  // ============================================================================ the REST API
  const ownerToken = await createApiToken(ids.owner, { name: "SIEM", scopes: ["audit:read"], workspaceId });
  check(await refused(createApiToken(ids.member, { name: "x", scopes: ["audit:read"], workspaceId }), "ownerScope"), "members can't make a token that reads the audit log");
  check(await refused(createApiToken(ids.owner, { name: "x", scopes: ["audit:read"] }), "ownerScope"), "…nor can owners, for all their workspaces");
  const plain = await createApiToken(ids.owner, { name: "Pages", scopes: ["pages:read"], workspaceId });
  check((await api(plain.secret, "")).status === 403, "a token without audit:read is refused");

  const all = await api(ownerToken.secret, "?limit=500");
  check(all.status === 200 && all.body.events.length > 150 && all.body.has_more === false, "an owner's token reads the audit log", { status: all.status, n: all.body.events?.length });
  check(all.body.events[0].time >= all.body.events.at(-1).time, "…newest first");
  const renamed = await api(ownerToken.secret, "?action=workspace.renamed&order=asc&limit=100");
  check(renamed.body.events.every((e: { action: string }) => e.action === "workspace.renamed") && renamed.body.events[0].details.n === 0 && renamed.body.has_more, "filtered by action, oldest first, in pages", renamed.body.events[0]);
  const next = await api(ownerToken.secret, `?action=workspace.renamed&order=asc&limit=100&cursor=${renamed.body.next_cursor}`);
  check(next.status === 200, "the next page is read", next.body);
  const seen = [...renamed.body.events, ...next.body.events].map((e: { id: string }) => e.id);
  check(next.body.events.length > 0 && new Set(seen).size === seen.length && next.body.events[0].details.n === 100 + 96, "the cursor goes on where the page ended", next.body.events[0]?.details);
  check((await api(ownerToken.secret, `?order=desc&cursor=${renamed.body.next_cursor}`)).status === 400, "a cursor of the other order is refused");
  const security = await api(ownerToken.secret, "?category=security&actor_kind=user");
  check(security.body.events.length > 0 && security.body.events.every((e: { category: string }) => e.category === "security"), "filtered by category and actor kind");
  const window = await api(ownerToken.secret, `?since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`);
  check(window.body.events.length === 0, "filtered by time");
  await db.update(workspaceMember).set({ role: "member" }).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.owner)));
  const demoted = await api(ownerToken.secret, "");
  check(demoted.status === 403 || demoted.status === 404, "the token stops reading when its person is no longer an owner", demoted);
  await db.update(workspaceMember).set({ role: "owner" }).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.owner)));

  // ============================================================================ sensitive content
  const card = "4242 4242 4242 4242";
  const doc = await createPage(owner, { workspaceId, title: "Payments" });
  const setText = (id: string, text: string) => db.update(page).set({ contentText: text }).where(eq(page.id, id));
  await setText(doc.id, `Customer card ${card}, expires 12/29. Key AKIAIOSFODNN7EXAMPLE.`);
  await dlp.runSensitiveContentScans();
  check(!(await db.select().from(sensitiveFinding).where(eq(sensitiveFinding.workspaceId, workspaceId))).length, "nothing is read while detection is off (the default)");
  check(await refused(updateWorkspaceSettings(ids.member, workspaceId, { sensitiveContent: true }), "access"), "only owners turn it on");
  await updateWorkspaceSettings(ids.owner, workspaceId, { sensitiveContent: true });

  const database = await createPage(owner, { workspaceId, title: "Suppliers", kind: "database" });
  const row = await createPage(owner, { workspaceId, parentId: database.id, title: "Acme" });
  await db.update(page).set({ properties: { iban: "TR33 0006 1005 1978 6457 8413 26", note: "fine" } as never }).where(eq(page.id, row.id));
  const clean = await createPage(owner, { workspaceId, title: "Nothing here" });
  await setText(clean.id, "Order 4242424242424241 shipped; call +90 532 123 45 67.");

  const ownersBefore = await db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "sensitive_content")));
  while ((await dlp.runSensitiveContentScans()) > 0) {}
  let findings = await db.select().from(sensitiveFinding).where(eq(sensitiveFinding.workspaceId, workspaceId));
  const byKind = Object.fromEntries(findings.map((f) => [f.kind, f]));
  check(findings.length === 3 && byKind.card?.pageId === doc.id && byKind.aws_key?.pageId === doc.id && byKind.iban?.pageId === row.id, "cards, keys and IBANs are found in pages and rows", findings.map((f) => [f.kind, f.excerpt]));
  check(byKind.card.excerpt === "**** **** **** 4242" && byKind.iban.excerpt === "TR** **** **** 1326" && byKind.aws_key.excerpt === "AKIA…MPLE", "…kept masked", findings.map((f) => f.excerpt));
  const raw = JSON.stringify(findings);
  check(!raw.includes("4242 4242 4242") && !raw.includes("4242424242424242") && !raw.includes("AKIAIOSFODNN7EXAMPLE") && !raw.includes("0006 1005"), "…never with the value");
  check((await dlp.runSensitiveContentScans()) === 0, "an unchanged page isn't read again");
  const found = await db.select({ details: auditEvent.details, actorKind: auditEvent.actorKind, targetId: auditEvent.targetId }).from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "sensitive_content.found")));
  check(found.length === 3 && found.every((e) => e.actorKind === "system") && !JSON.stringify(found).includes("4242424242424242"), "each finding is in the audit log, masked", found);
  let told = await db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "sensitive_content")));
  check(ownersBefore.length === 0 && told.length === 3 && told.every((n) => n.userId === ids.owner), "owners are told, once per page and kind", told.map((n) => [n.userId, n.message]));

  check(await refused(dlp.listSensitiveFindings(ids.member, workspaceId), "access"), "members can't list findings");
  let list = await dlp.listSensitiveFindings(ids.owner, workspaceId);
  check(list.total === 3 && list.findings.every((f) => f.page.title), "owners list the open findings with their pages", list);

  // A second card on the same page, the same day: found, but no second notice.
  await setText(doc.id, `Customer card ${card} and 5555 5555 5555 4444. Key AKIAIOSFODNN7EXAMPLE.`);
  await dlp.runSensitiveContentScans();
  told = await db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "sensitive_content")));
  check((await dlp.listSensitiveFindings(ids.owner, workspaceId)).total === 4 && told.length === 3, "another value of a kind already told about today adds a finding, not a notice");

  // Gone from the page: resolved; back again: open again.
  await setText(doc.id, "Customer card removed. Key AKIAIOSFODNN7EXAMPLE.");
  await dlp.runSensitiveContentScans();
  findings = await db.select().from(sensitiveFinding).where(eq(sensitiveFinding.pageId, doc.id));
  check(findings.filter((f) => f.kind === "card").every((f) => f.status === "resolved" && f.resolvedAt) && findings.find((f) => f.kind === "aws_key")?.status === "open", "a value no longer on the page resolves itself", findings.map((f) => [f.kind, f.status]));
  await db.update(sensitiveFinding).set({ notifiedAt: sql`now() - interval '2 days'` }).where(eq(sensitiveFinding.pageId, doc.id));
  await setText(doc.id, `Card again ${card}. Key AKIAIOSFODNN7EXAMPLE.`);
  await dlp.runSensitiveContentScans();
  findings = await db.select().from(sensitiveFinding).where(and(eq(sensitiveFinding.pageId, doc.id), eq(sensitiveFinding.kind, "card")));
  told = await db.select().from(notification).where(and(eq(notification.workspaceId, workspaceId), eq(notification.kind, "sensitive_content")));
  check(findings.filter((f) => f.status === "open").length === 1 && told.length === 4, "found again, it opens again, and owners are told after a day", { findings: findings.map((f) => f.status), told: told.length });

  // Dismissed: stays dismissed while the page holds it.
  const awsFinding = (await dlp.listSensitiveFindings(ids.owner, workspaceId)).findings.find((f) => f.kind === "aws_key")!;
  check(await refused(dlp.dismissSensitiveFinding(ids.member, workspaceId, awsFinding.id), "access"), "members can't dismiss findings");
  await dlp.dismissSensitiveFinding(ids.owner, workspaceId, awsFinding.id);
  check(await refused(dlp.dismissSensitiveFinding(ids.owner, workspaceId, awsFinding.id), "access"), "a dismissed finding can't be dismissed again");
  await setText(doc.id, `Card again ${card}. Key AKIAIOSFODNN7EXAMPLE. Edited.`);
  await dlp.runSensitiveContentScans();
  list = await dlp.listSensitiveFindings(ids.owner, workspaceId);
  check(!list.findings.some((f) => f.id === awsFinding.id), "a dismissed finding stays out of the list after the page changes", list.findings.map((f) => f.kind));
  const dismissed = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "sensitive_content.dismissed")));
  check(dismissed.length === 1 && dismissed[0].actorUserId === ids.owner, "dismissing is in the audit log");

  // Templates aren't read.
  const template = await createPage(owner, { workspaceId, title: "Invoice template", template: true });
  await setText(template.id, `Example card ${card}`);
  await dlp.runSensitiveContentScans();
  check(!(await db.select().from(sensitiveFinding).where(eq(sensitiveFinding.pageId, template.id))).length, "templates aren't read");

  await updateWorkspaceSettings(ids.owner, workspaceId, { sensitiveContent: false });
  const left = await db.select().from(sensitiveFinding).where(eq(sensitiveFinding.workspaceId, workspaceId));
  const scans = await db.select().from(sensitiveScan).where(eq(sensitiveScan.workspaceId, workspaceId));
  check(!left.length && !scans.length, "turning it off clears the findings and what was read");

  // ============================================================================ people from domains
  check(await refused(domainPeople(ids.member, workspaceId), "access"), "members can't list the people from the domains");
  check((await domainPeople(ids.owner, workspaceId)).domains.length === 0, "without verified domains there is no one to list");
  await db
    .update(workspace)
    .set({ settings: sql`${workspace.settings} || ${JSON.stringify({ allowedDomains: [DOMAIN, `unproven-${DOMAIN}`], allowedDomainsVerified: [DOMAIN] })}::jsonb` })
    .where(eq(workspace.id, workspaceId));
  await db.insert(account).values({ id: `${RUN}-acct`, accountId: ids.outsider, providerId: "credential", userId: ids.outsider, password: "not-a-real-hash" });
  let people = await domainPeople(ids.owner, workspaceId);
  check(people.domains.join() === DOMAIN, "only proven domains count", people.domains);
  const emails = people.people.map((p) => p.email);
  check(
    emails.join() === [`mert@${DOMAIN}`, `olcay@${DOMAIN}`, `oya@sales.${DOMAIN}`].join(),
    "everyone on the domain and its subdomains is listed, the workspace's people first, no one from elsewhere",
    emails,
  );
  const oya = people.people.find((p) => p.userId === ids.outsider)!;
  check(oya.role === null && oya.signIn.join() === "password" && oya.lastActiveAt === null, "with their place here, how they sign in and when they were last active", oya);
  check(people.people.find((p) => p.userId === ids.member)?.role === "member", "members show as members");

  const added = await addMembers(ids.owner, workspaceId, [oya.email], "member");
  check(added[0]?.kind === "added", "an owner adds them through the usual step", added);
  people = await domainPeople(ids.owner, workspaceId);
  check(people.people.find((p) => p.userId === ids.outsider)?.role === "member", "…and they show as in the workspace");
  await removeMember(ids.owner, workspaceId, ids.outsider);
  people = await domainPeople(ids.owner, workspaceId);
  check(people.people.find((p) => p.userId === ids.outsider)?.role === null, "…and out again once removed");

  console.log(`\n${passed} checks passed`);
} finally {
  receiver.close();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
