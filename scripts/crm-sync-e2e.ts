/**
 * End-to-end check of Zendesk and Salesforce syncs against the database and a fake service (an HTTP
 * server started here on 127.0.0.1 that answers both APIs' calls, in pages of two so paging is
 * exercised): private addresses, missing input, a wrong token, an account that may not export
 * tickets, a wrong consumer secret, an app without the client credentials flow and a bad object are
 * refused before anything is made. Setting up a Zendesk sync makes a database of the account's
 * tickets (status by stage, priority, type, requester and assignee as people when their email
 * address is a member's and others as names, tags, dates, link) with a board by status, read through
 * the incremental export page by page, the sign-in sealed. A due run asks only for what changed
 * since the newest update, writes changes over, adds new tickets and changes nothing otherwise; a
 * spent request limit passes, a refused token or a missing Ticket property pauses. A Salesforce sync
 * of Opportunities and one of Cases are made the same way from SOQL read page by page (stages
 * closed by IsClosed, owners found by email address or by name), run incrementally by
 * SystemModstamp, and pause when Salesforce refuses the query. Stopping keeps the rows. Creates its
 * own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/crm-sync-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's sweep would run the syncs it makes due.
 */
export {};

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

const RUN = `crm-${Date.now()}`;
const PAGE = 2;

// ---- A fake Zendesk
type FakeTicket = { id: number; subject: string; status: string; priority: string | null; type: string | null; requester_id: number; assignee_id: number | null; tags: string[]; created_at: string; updated_at: string };
let zendeskToken = "zd-token";
let zendeskLimited = false;
let clock = Date.parse("2026-10-01T10:00:00Z");
const stamp = () => new Date((clock += 60_000)).toISOString();
const ticket = (id: number, fields: Partial<FakeTicket> = {}): FakeTicket => ({
  id,
  subject: `Ticket ${id}`,
  status: "open",
  priority: "normal",
  type: "question",
  requester_id: 11,
  assignee_id: null,
  tags: [],
  created_at: "2026-09-30T09:00:00Z",
  updated_at: stamp(),
  ...fields,
});
const ZENDESK_USERS: Record<number, { id: number; name: string; email: string }> = {
  11: { id: 11, name: "Customer", email: "customer@client.test" },
  12: { id: 12, name: "Ada", email: "" },
  13: { id: 13, name: "Agent Smith", email: "smith@elsewhere.test" },
};
const tickets: FakeTicket[] = [
  ticket(1, { subject: "Printer jams", priority: "high", type: "incident", requester_id: 12, assignee_id: 13, tags: ["printer", "urgent"] }),
  ticket(2, { subject: "Where is my invoice", tags: ["billing"] }),
  ticket(3, { subject: "Gone", status: "deleted" }),
  ticket(4, { subject: "Old and solved", status: "solved", priority: null, type: null, assignee_id: 12 }),
  ticket(5, { subject: "Closed long ago", status: "closed" }),
];
const zendeskRequests: string[] = [];

// ---- A fake Salesforce
type FakeRecord = Record<string, unknown> & { Id: string; SystemModstamp: string };
let salesforceSecret = "sf-secret";
let refuseIndustry = false;
let salesforceModstamp = Date.parse("2026-10-01T10:00:00Z");
const sfStamp = () => new Date((salesforceModstamp += 60_000)).toISOString().replace("Z", "+0000");
const opportunities: FakeRecord[] = [
  { Id: "006A", Name: "Big deal", StageName: "Prospecting", IsClosed: false, Amount: 5000, CloseDate: "2026-12-01", Probability: 10, Type: "New Business", LeadSource: "Web", Account: { Name: "Acme" }, Owner: { Name: "Ada Owner", Email: "" }, SystemModstamp: sfStamp() },
  { Id: "006B", Name: "Won deal", StageName: "Closed Won", IsClosed: true, Amount: 120.5, CloseDate: "2026-09-01", Probability: 100, Type: null, LeadSource: null, Account: null, Owner: { Name: "Someone Else", Email: "else@elsewhere.test" }, SystemModstamp: sfStamp() },
  { Id: "006C", Name: "Third", StageName: "Prospecting", IsClosed: false, Amount: null, CloseDate: null, Probability: 20, Type: null, LeadSource: null, Account: { Name: "Beta" }, Owner: { Name: "Someone Else", Email: "else@elsewhere.test" }, SystemModstamp: sfStamp() },
];
const cases: FakeRecord[] = [
  { Id: "500A", Subject: "Broken thing", CaseNumber: "00001", Status: "New", IsClosed: false, Priority: "High", Origin: "Phone", Type: null, Account: { Name: "Acme" }, Contact: { Name: "Carl" }, CreatedDate: "2026-09-30T09:00:00.000+0000", Owner: { Name: "Ada Owner" }, SystemModstamp: sfStamp() },
];
const salesforceRequests: string[] = [];

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function zendesk(req: IncomingMessage, res: ServerResponse, url: URL) {
  zendeskRequests.push(`${url.pathname}${url.search}`);
  if (zendeskLimited) return send(res, 429, { error: "Rate limit" }, { "retry-after": "60" });
  const auth = req.headers.authorization ?? "";
  const given = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString();
  if (!given.endsWith(`/token:${zendeskToken}`) && !given.endsWith("/token:agent-token")) return send(res, 401, { error: "Couldn't authenticate you" });
  const agentOnly = given.endsWith("/token:agent-token");
  if (url.pathname === "/api/v2/users/me.json") return send(res, 200, { user: { id: 1, name: "Admin" } });
  if (url.pathname === "/api/v2/incremental/tickets/cursor.json") {
    if (agentOnly) return send(res, 403, { error: "Forbidden" });
    const cursor = url.searchParams.get("cursor");
    const start = Number(url.searchParams.get("start_time") ?? 0);
    const sorted = [...tickets].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    // A cursor is "<start>:<offset>": the export from a start time, from an offset.
    const [from, offset] = cursor ? cursor.split(":").map(Number) : [start, 0];
    const found = sorted.filter((t) => Date.parse(t.updated_at) / 1000 >= from);
    const slice = found.slice(offset, offset + PAGE);
    return send(res, 200, { tickets: slice, after_cursor: `${from}:${offset + PAGE}`, end_of_stream: offset + PAGE >= found.length });
  }
  if (url.pathname === "/api/v2/users/show_many.json") {
    const wanted = (url.searchParams.get("ids") ?? "").split(",").map(Number);
    return send(res, 200, { users: wanted.flatMap((id) => (ZENDESK_USERS[id] ? [{ ...ZENDESK_USERS[id], email: ZENDESK_USERS[id].email || undefined }] : [])) });
  }
  return send(res, 404, { error: "RecordNotFound" });
}

async function salesforce(req: IncomingMessage, res: ServerResponse, url: URL) {
  salesforceRequests.push(`${req.method} ${url.pathname}${url.search}`);
  if (url.pathname === "/services/oauth2/token") {
    const form = new URLSearchParams(await readBody(req));
    if (form.get("grant_type") !== "client_credentials") return send(res, 400, { error: "unsupported_grant_type" });
    if (form.get("client_id") === "app-nocc") return send(res, 400, { error: "invalid_grant", error_description: "client credentials flow is not enabled" });
    if (form.get("client_id") !== "app-id" || form.get("client_secret") !== salesforceSecret) return send(res, 400, { error: "invalid_client", error_description: "invalid client credentials" });
    return send(res, 200, { access_token: "sf-access", instance_url: "https://elsewhere.invalid", token_type: "Bearer" });
  }
  if (req.headers.authorization !== "Bearer sf-access") return send(res, 401, [{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }]);
  const query = /^\/services\/data\/v\d+\.0\/query$/.exec(url.pathname);
  const more = /^\/services\/data\/v\d+\.0\/query\/(\w+)-(\d+)$/.exec(url.pathname);
  if (!query && !more) return send(res, 404, [{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }]);
  const soql = query ? (url.searchParams.get("q") ?? "") : (lastSoql ?? "");
  if (query) lastSoql = soql;
  if (refuseIndustry && soql.includes("Industry")) return send(res, 400, [{ message: "No such column 'Industry' on entity 'Account'", errorCode: "INVALID_FIELD" }]);
  const object = /FROM (\w+)/.exec(soql)?.[1];
  const source = object === "Opportunity" ? opportunities : object === "Case" ? cases : [];
  const since = /SystemModstamp >= (\S+)/.exec(soql)?.[1];
  const found = source
    .filter((r) => !since || Date.parse(r.SystemModstamp.replace("+0000", "Z")) >= Date.parse(since))
    .sort((a, b) => a.SystemModstamp.localeCompare(b.SystemModstamp));
  const offset = more ? Number(more[2]) : 0;
  const records = found.slice(offset, offset + PAGE).map((r) => ({ attributes: { type: object }, ...r }));
  const done = offset + PAGE >= found.length;
  return send(res, 200, { totalSize: found.length, done, records, ...(done ? {} : { nextRecordsUrl: `/services/data/v62.0/query/01g-${offset + PAGE}` }) });
}
let lastSoql: string | null = null;

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  if (url.pathname.startsWith("/api/v2/")) return zendesk(req, res, url);
  salesforce(req, res, url).catch((error) => send(res, 500, { error: String(error) }));
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const HOST = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
// The fake service is on this machine: let the connections' fetch reach its port (read on each fetch).
process.env.CONNECTOR_ALLOWED_HOSTS = `127.0.0.1:${(fake.address() as AddressInfo).port}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseSync, databaseView, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { AccessError } = await import("@/server/access");
const { deleteProperty, getDatabaseSnapshot, getProperties } = await import("@/server/databases");
const { JiraError } = await import("@/server/jira-sync/client");
const zd = await import("@/server/zendesk-sync/manage");
const sf = await import("@/server/salesforce-sync/manage");
const { runDueSyncs } = await import("@/server/jira-sync/run");

// Titles are written through the collaboration service, as in the app.
const { hocuspocus, service } = createCollab();
registerCollab(service);

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

async function errorCode(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof JiraError ? error.code : error instanceof AccessError ? "access" : String(error);
  }
}

const ids = { owner: `${RUN}-owner`, second: `${RUN}-second`, ada: `${RUN}-ada`, member: `${RUN}-member` };
const workspaceId = `${RUN}-ws`;

async function rowsOf(databaseId: string) {
  return db
    .select({ id: page.id, title: page.title, properties: page.properties, archivedAt: page.archivedAt, updatedAt: page.updatedAt })
    .from(page)
    .where(and(eq(page.parentId, databaseId), eq(page.isTemplate, false)));
}

async function syncRow(databaseId: string) {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row;
}

/** Makes the sync due and runs what is due, as the minute's sweep would. */
async function runDue(databaseId: string) {
  await db.update(databaseSync).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(databaseSync.databaseId, databaseId));
  return runDueSyncs(new Date());
}

async function waitForTitle(rowId: string, title: string) {
  for (let i = 0; i < 40; i++) {
    const [row] = await db.select({ title: page.title }).from(page).where(eq(page.id, rowId));
    if (row?.title === title) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const zdSetup = (fields: Partial<Parameters<typeof zd.createZendeskSync>[1]> = {}) =>
  zd.createZendeskSync({ userId: ids.owner }, { workspaceId, parentId: null, site: HOST, email: "admin@acme.test", token: zendeskToken, ...fields });
const sfSetup = (fields: Partial<Parameters<typeof sf.createSalesforceSync>[1]> = {}) =>
  sf.createSalesforceSync({ userId: ids.owner }, { workspaceId, parentId: null, site: HOST, clientId: "app-id", clientSecret: salesforceSecret, object: "Opportunity", ...fields });

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner", email: `${ids.owner}@example.test` },
    { id: ids.second, name: "Second", email: `${ids.second}@example.test` },
    { id: ids.ada, name: "Ada Owner", email: "ada@acme.test" },
    { id: ids.member, name: "Member", email: "customer@client.test" },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.second, role: "owner" },
    { workspaceId, userId: ids.ada, role: "member" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  // Ada's email address in Zendesk is hidden (the fake gives no email), so she is matched by name there.
  ZENDESK_USERS[12].name = "Ada Owner";

  // ---- Zendesk: what is refused before anything is made
  check((await errorCode(() => zdSetup({ site: "http://10.1.2.3" }))) === "invalidSite", "Zendesk: a private address is refused");
  check((await errorCode(() => zdSetup({ site: "bad host" }))) === "invalidSite", "Zendesk: a bad address is refused");
  check((await errorCode(() => zdSetup({ token: "" }))) === "invalidInput", "Zendesk: a missing token is refused");
  check((await errorCode(() => zdSetup({ token: "wrong" }))) === "unauthorized", "Zendesk: a wrong token is refused");
  check((await errorCode(() => zdSetup({ token: "agent-token" }))) === "forbidden", "Zendesk: an account that may not export tickets is refused");
  check((await errorCode(() => zdSetup({ intervalMinutes: 7 }))) === "invalidInput", "Zendesk: an interval it doesn't offer is refused");
  check((await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length === 0, "and nothing was made");

  // ---- Zendesk: setting up
  zendeskRequests.length = 0;
  const zResult = await zdSetup({ intervalMinutes: 60 });
  const zId = zResult.pages[0].id;
  check(zResult.created.rows === 5 && zResult.pages[0].title === new URL(HOST).hostname, "Zendesk: setting up makes a database of the tickets, named after the account", zResult);
  check(
    zendeskRequests.filter((r) => r.startsWith("/api/v2/incremental/tickets/cursor.json")).length === 3 && zendeskRequests.some((r) => r.includes("cursor=")),
    "it reads the export page by page",
    zendeskRequests,
  );
  const zProps = await getProperties(zId);
  const zBy = (name: string) => zProps.find((p) => p.name === name)!;
  check(
    ["Ticket", "Status", "Priority", "Type", "Requester", "Requester (others)", "Assignee", "Assignee (others)", "Tags", "Created", "Updated", "Zendesk link"].every((n) => zProps.some((p) => p.name === n)),
    "with a property for each field",
    zProps.map((p) => `${p.name}:${p.type}`),
  );
  const zRows = await rowsOf(zId);
  const zRow = (n: number) => zRows.find((r) => r.properties[zBy("Ticket").id] === n)!;
  const zOption = (name: string, id: unknown) => zBy(name).options.options?.find((o) => o.id === id)?.name;
  const t1 = zRow(1);
  check(t1.title === "Printer jams" && zOption("Priority", t1.properties[zBy("Priority").id]) === "high" && zOption("Type", t1.properties[zBy("Type").id]) === "incident", "title, priority and type are written", t1);
  check(zOption("Status", t1.properties[zBy("Status").id]) === "Open", "the status is written in the account's words", t1.properties);
  check(
    ["New", "Open", "Pending", "On hold", "Solved", "Closed", "Deleted"].every((n) => zBy("Status").options.options?.some((o) => o.name === n)) &&
      zBy("Status").options.options?.find((o) => o.name === "Solved")?.group === "done",
    "the status has every stage, solved among done",
    zBy("Status").options.options,
  );
  check(same(t1.properties[zBy("Requester").id], [ids.ada]), "a requester the workspace has (by name where Zendesk hides emails) is that person", t1.properties);
  check(t1.properties[zBy("Assignee (others)").id] === "Agent Smith" && !t1.properties[zBy("Assignee").id], "someone else is written by name", t1.properties);
  check(same((t1.properties[zBy("Tags").id] as string[]).map((id) => zOption("Tags", id)), ["printer", "urgent"]), "tags are a multi-select");
  check(t1.properties[zBy("Zendesk link").id] === `${HOST}/agent/tickets/1`, "and the link goes back to the ticket");
  check(zOption("Status", zRow(3).properties[zBy("Status").id]) === "Deleted", "a deleted ticket is marked Deleted");
  const zViews = await db.select().from(databaseView).where(eq(databaseView.databaseId, zId));
  check(zViews.some((v) => v.type === "board" && v.config.groupBy === zBy("Status").id), "there is a board by status");
  const zSync = await syncRow(zId);
  check(zSync.source === "zendesk" && zSync.siteUrl === HOST && zSync.lastCount === 5 && zSync.nextRunAt && zSync.nextRunAt > new Date(), "the sync is recorded", zSync);
  check(!zSync.secrets.includes(zendeskToken) && !zSync.secrets.includes("admin@acme.test"), "its sign-in is sealed");
  check((zSync.query as { since: number }).since === Math.floor(Date.parse(tickets[4].updated_at) / 1000), "it remembers the newest update seen", zSync.query);
  check((await getDatabaseSnapshot(ids.owner, zId)).sync?.source === "zendesk", "the database says it syncs from Zendesk");
  const zView = await zd.getZendeskSync(ids.owner, zId);
  check(zView?.account === "admin@acme.test" && zView.canManage && !JSON.stringify(zView).includes(zendeskToken), "the sync's dialog shows the account, never the token", zView);
  check((await sf.getSalesforceSync(ids.owner, zId)) === null, "Salesforce's functions don't see a Zendesk sync");

  // ---- Zendesk: runs
  zendeskRequests.length = 0;
  const stamps = new Map((await rowsOf(zId)).map((r) => [r.id, r.updatedAt.getTime()]));
  check((await runDue(zId)) === 1, "a due sync runs");
  const newest = Math.floor(Date.parse(tickets[4].updated_at) / 1000);
  check(zendeskRequests.some((r) => r.includes(`start_time=${newest}`)), "it asks only from the newest update seen", zendeskRequests);
  check((await rowsOf(zId)).every((r) => stamps.get(r.id) === r.updatedAt.getTime()), "a run without changes changes no row");
  check((await zd.getZendeskSync(ids.owner, zId))?.lastCount === 5, "and counts the rows it holds");

  Object.assign(tickets[1], { status: "solved", subject: "Invoice found", assignee_id: 13, updated_at: stamp() });
  tickets.push(ticket(6, { subject: "Brand new", requester_id: 13, tags: ["fresh"] }));
  check((await runDue(zId)) === 1, "a due sync runs again");
  const zAfter = await rowsOf(zId);
  const zProps2 = await getProperties(zId);
  const zOption2 = (name: string, id: unknown) => zProps2.find((p) => p.name === name)?.options.options?.find((o) => o.id === id)?.name;
  const t2 = zAfter.find((r) => r.id === zRow(2).id)!;
  check(zOption2("Status", t2.properties[zBy("Status").id]) === "Solved", "a ticket solved since is Solved", t2.properties);
  check(await waitForTitle(zRow(2).id, "Invoice found"), "a changed subject renames the row");
  const t6 = zAfter.find((r) => r.properties[zBy("Ticket").id] === 6);
  check(t6 && t6.title === "Brand new" && t6.properties[zBy("Requester (others)").id] === "Agent Smith", "a new ticket adds a row", t6?.properties);
  check(zProps2.find((p) => p.name === "Tags")?.options.options?.some((o) => o.name === "fresh"), "with a new tag option");
  check(zAfter.length === 6 && (await zd.getZendeskSync(ids.owner, zId))?.lastCount === 6, "and the count follows");

  zendeskLimited = true;
  const zLimited = await zd.syncZendeskNow(ids.owner, zId);
  check(zLimited.outcome.error === "unreachable" && zLimited.enabled, "Zendesk: a spent request limit is passing: the sync stays on", zLimited);
  zendeskLimited = false;
  zendeskToken = "revoked";
  const { PAUSE_AFTER_FAILURES } = await import("@/lib/jira-sync");
  const zOnce = await zd.syncZendeskNow(ids.owner, zId);
  check(zOnce.outcome.error === "unauthorized" && zOnce.enabled, "Zendesk: a revoked token shows its error, and the sync stays on", zOnce);
  let zRefused = zOnce;
  for (let i = 1; i < PAUSE_AFTER_FAILURES; i++) zRefused = await zd.syncZendeskNow(ids.owner, zId);
  check(zRefused.outcome.error === "unauthorized" && !zRefused.enabled, "Zendesk: a revoked token pauses the sync once runs in a row failed", zRefused);
  check((await runDue(zId)) === 0, "a paused sync isn't run when due");
  zendeskToken = "zd-token-2";
  check((await errorCode(() => zd.updateZendeskSync(ids.owner, zId, { email: "admin@acme.test", token: "still-wrong" }))) === "unauthorized", "a new sign-in is checked first");
  const zRenewed = await zd.updateZendeskSync(ids.owner, zId, { email: "admin2@acme.test", token: zendeskToken });
  check(zRenewed.enabled && zRenewed.lastError === null && zRenewed.account === "admin2@acme.test", "a new sign-in syncs it again", zRenewed);
  const zEvery = await zd.updateZendeskSync(ids.owner, zId, { intervalMinutes: 0 });
  check(zEvery.intervalMinutes === 0 && (await syncRow(zId)).nextRunAt === null, "only when asked: it never falls due");
  await deleteProperty(ids.owner, zBy("Ticket").id);
  const zKeyless = await zd.syncZendeskNow(ids.owner, zId);
  check(zKeyless.outcome.error === "keyGone" && zKeyless.enabled, "without its Ticket property it fails (and pauses only if it repeats)", zKeyless);
  await zd.stopZendeskSync(ids.owner, zId);
  check(!(await syncRow(zId)) && (await rowsOf(zId)).length === 6, "stopping forgets the sync and keeps the rows");

  // ---- Salesforce: what is refused before anything is made
  const before = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  check((await errorCode(() => sfSetup({ site: "http://10.1.2.3" }))) === "invalidSite", "Salesforce: a private address is refused");
  check((await errorCode(() => sfSetup({ object: "Product2" }))) === "invalidInput", "Salesforce: an object it doesn't offer is refused");
  check((await errorCode(() => sfSetup({ clientSecret: "" }))) === "invalidInput", "Salesforce: a missing secret is refused");
  check((await errorCode(() => sfSetup({ clientSecret: "wrong" }))) === "unauthorized", "Salesforce: a wrong secret is refused");
  check((await errorCode(() => sfSetup({ clientId: "app-nocc" }))) === "forbidden", "Salesforce: an app without the client credentials flow is refused");
  check((await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length === before, "and nothing was made");

  // ---- Salesforce: opportunities
  salesforceRequests.length = 0;
  const sResult = await sfSetup({ intervalMinutes: 60 });
  const sId = sResult.pages[0].id;
  check(sResult.created.rows === 3 && sResult.pages[0].title === "Opportunity", "Salesforce: setting up makes a database of the object's records", sResult);
  check(
    salesforceRequests.filter((r) => r.includes("/query")).length === 2 && salesforceRequests.some((r) => r.includes("/query/01g-2")),
    "it reads the query page by page",
    salesforceRequests,
  );
  check(salesforceRequests.every((r) => !r.includes("elsewhere.invalid")), "and never follows the instance address of the token");
  const sProps = await getProperties(sId);
  const sBy = (name: string) => sProps.find((p) => p.name === name)!;
  check(
    ["Id", "Stage", "Amount", "Close date", "Probability", "Type", "Lead source", "Account", "Owner", "Owner (others)", "Modified", "Salesforce link"].every((n) => sProps.some((p) => p.name === n)),
    "with a property for each of the object's fields",
    sProps.map((p) => `${p.name}:${p.type}`),
  );
  const sRows = await rowsOf(sId);
  const sRow = (id: string) => sRows.find((r) => r.properties[sBy("Id").id] === id)!;
  const sOption = (props: typeof sProps, name: string, id: unknown) => props.find((p) => p.name === name)?.options.options?.find((o) => o.id === id);
  const big = sRow("006A");
  check(big.title === "Big deal" && big.properties[sBy("Amount").id] === 5000 && big.properties[sBy("Close date").id] === "2026-12-01", "title, amount and day are written", big);
  check(sOption(sProps, "Stage", sRow("006B").properties[sBy("Stage").id])?.group === "done" && sOption(sProps, "Stage", big.properties[sBy("Stage").id])?.group === "in_progress", "a closed stage is done, an open one in progress");
  check(sOption(sProps, "Type", big.properties[sBy("Type").id])?.name === "New Business", "types are options");
  check(big.properties[sBy("Account").id] === "Acme" && !sRow("006B").properties[sBy("Account").id], "a related record's name is text, nothing for none");
  check(same(big.properties[sBy("Owner").id], [ids.ada]) && !big.properties[sBy("Owner (others)").id], "an owner with no email address to give is found by name", big.properties);
  check(sRow("006B").properties[sBy("Owner (others)").id] === "Someone Else", "someone else is written by name", sRow("006B").properties);
  check(big.properties[sBy("Salesforce link").id] === `${HOST}/lightning/r/Opportunity/006A/view`, "the link goes back to the record");
  const sViews = await db.select().from(databaseView).where(eq(databaseView.databaseId, sId));
  check(sViews.some((v) => v.type === "board" && v.config.groupBy === sBy("Stage").id), "there is a board by stage");
  const sSync = await syncRow(sId);
  check(sSync.source === "salesforce" && sSync.lastCount === 3 && !sSync.secrets.includes("app-id") && !sSync.secrets.includes(salesforceSecret), "the sync is recorded, its sign-in sealed", sSync);
  const sView = await sf.getSalesforceSync(ids.owner, sId);
  check(sView?.object === "Opportunity" && sView.account === "app-id" && !JSON.stringify(sView).includes(salesforceSecret), "the dialog shows the object and key, never the secret", sView);

  // Incremental runs
  salesforceRequests.length = 0;
  const sStamps = new Map((await rowsOf(sId)).map((r) => [r.id, r.updatedAt.getTime()]));
  check((await runDue(sId)) === 1, "a due sync runs");
  check(salesforceRequests.some((r) => decodeURIComponent(r.replace(/\+/g, " ")).includes("WHERE SystemModstamp >= 2026-10-01T10:03:00Z")), "it asks only from the newest change seen", salesforceRequests);
  check((await rowsOf(sId)).every((r) => sStamps.get(r.id) === r.updatedAt.getTime()), "a run without changes changes no row");
  Object.assign(opportunities[2], { StageName: "Negotiation", Amount: 777, Name: "Third, renamed", SystemModstamp: sfStamp() });
  opportunities.push({ Id: "006D", Name: "Fresh", StageName: "Closed Lost", IsClosed: true, Amount: 1, Owner: { Name: "Ada Owner", Email: "ada@acme.test" }, SystemModstamp: sfStamp() });
  check((await runDue(sId)) === 1, "a due sync runs again");
  const sAfter = await rowsOf(sId);
  const sProps2 = await getProperties(sId);
  const third = sAfter.find((r) => r.properties[sBy("Id").id] === "006C")!;
  check(third.properties[sBy("Amount").id] === 777 && sOption(sProps2, "Stage", third.properties[sBy("Stage").id])?.name === "Negotiation", "a changed record is written over, with the new stage as an option", third.properties);
  check(await waitForTitle(third.id, "Third, renamed"), "and renamed");
  const fresh = sAfter.find((r) => r.properties[sBy("Id").id] === "006D");
  check(fresh && same(fresh.properties[sBy("Owner").id], [ids.ada]), "a new record adds a row, an owner found by email address a person", fresh?.properties);
  check(sAfter.length === 4 && (await sf.getSalesforceSync(ids.owner, sId))?.lastCount === 4, "and the count follows");

  // Cases: an owner found by name
  const cResult = await sfSetup({ object: "Case", title: "Support cases" });
  const cId = cResult.pages[0].id;
  const cProps = await getProperties(cId);
  const cBy = (name: string) => cProps.find((p) => p.name === name)!;
  const [caseRow] = await rowsOf(cId);
  check(cResult.pages[0].title === "Support cases" && caseRow.title === "Broken thing" && caseRow.properties[cBy("Case number").id] === "00001", "Salesforce: a case is a row by its subject", caseRow);
  check(same(caseRow.properties[cBy("Owner").id], [ids.ada]), "an owner with no email to give is found by name", caseRow.properties);
  check(String(caseRow.properties[cBy("Created").id]).startsWith("2026-09-30T09:00:00"), "dates and times are kept");
  const accounts = await sfSetup({ object: "Account", title: "Accounts" });
  check(accounts.created.rows === 0, "an object with no records makes an empty database");

  // Passing problems and pauses
  refuseIndustry = true;
  const accountsId = accounts.pages[0].id;
  const refused = await sf.syncSalesforceNow(ids.owner, accountsId);
  check(refused.outcome.error === "badQuery" && refused.enabled && refused.lastErrorDetail?.includes("Industry"), "a query Salesforce refuses is shown with Salesforce's words (it pauses only if it repeats)", refused);
  refuseIndustry = false;
  salesforceSecret = "rotated";
  const bad = await sf.syncSalesforceNow(ids.owner, sId);
  check(bad.outcome.error === "unauthorized" && bad.enabled, "a rotated secret shows its error (it pauses only if it repeats)", bad);
  check((await errorCode(() => sf.updateSalesforceSync(ids.second, sId, { clientId: "app-id", clientSecret: "nope" }))) === "unauthorized", "a new sign-in is checked first");
  // Each person has a budget of sync setups a minute (server/sync-setup): the second owner checks the new sign-in.
  const renewed = await sf.updateSalesforceSync(ids.second, sId, { clientId: "app-id", clientSecret: "rotated" });
  check(renewed.enabled && renewed.lastError === null, "a new sign-in syncs it again", renewed);
  await deleteProperty(ids.owner, sBy("Id").id);
  const keyless = await sf.syncSalesforceNow(ids.owner, sId);
  check(keyless.outcome.error === "keyGone" && keyless.enabled, "without its Id property it fails (and pauses only if it repeats)", keyless);
  await sf.stopSalesforceSync(ids.owner, sId);
  check(!(await syncRow(sId)) && (await rowsOf(sId)).length === 4, "stopping forgets the sync and keeps the rows");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  hocuspocus.closeConnections();
  fake.close();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
