/**
 * End-to-end check of Jira syncs against the database and a fake Jira Cloud (an HTTP server started
 * here on 127.0.0.1, answering the REST calls a sync makes, two issues per page): wrong credentials
 * and private addresses are refused; setting one up makes a database of a project's issues (key,
 * summary as title, status by its category, an assignee who is a member as a person and someone else
 * as text, priority, type, labels, due date, link) with a board by status, without telling anyone of
 * their old assignments; the sign-in is sealed. A due run writes Jira's changes over the synced
 * properties and titles, adds new issues and options, keeps a property people added, leaves a row
 * in the trash there and tells a newly assigned member; a run without changes changes nothing.
 * Refused credentials, a refused query, a missing Key property and a query finding too many issues
 * pause the sync until it is changed; an endless chain of page tokens ends; stopping keeps the rows.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/jira-sync-e2e.ts
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

// The fake Jira is on this machine: let the connections' fetch reach it (read when env loads).
process.env.CONNECTOR_ALLOWED_HOSTS = "127.0.0.1";

const RUN = `jira-${Date.now()}`;
const EMAIL = "admin@acme.test";
let token = "token-1";
const PAGE = 2;

type FakeIssue = {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { key: string } };
    assignee: { accountId: string; displayName: string; emailAddress?: string } | null;
    reporter?: { accountId: string; displayName: string; emailAddress?: string } | null;
    priority: { name: string } | null;
    labels: string[];
    duedate: string | null;
    issuetype: { name: string };
  };
};

const status = (name: string, key: "new" | "indeterminate" | "done") => ({ name, statusCategory: { key } });
const adaEmail = `ada.${RUN}@example.test`;
const issues: FakeIssue[] = [
  {
    id: "1",
    key: "OPS-1",
    fields: {
      summary: "Fix the login page",
      status: status("In Progress", "indeterminate"),
      assignee: { accountId: "a-ada", displayName: "Ada Jira", emailAddress: adaEmail },
      reporter: { accountId: "a-ada", displayName: "Ada Jira", emailAddress: adaEmail },
      priority: { name: "High" },
      labels: ["web", "urgent"],
      duedate: "2026-11-02",
      issuetype: { name: "Bug" },
    },
  },
  {
    id: "2",
    key: "OPS-2",
    fields: {
      summary: "Write the release notes",
      status: status("To Do", "new"),
      assignee: { accountId: "a-grace", displayName: "Grace Hopper" },
      priority: { name: "Medium" },
      labels: [],
      duedate: null,
      issuetype: { name: "Task" },
    },
  },
  {
    id: "3",
    key: "OPS-3",
    fields: {
      summary: "Old cleanup",
      status: status("Done", "done"),
      assignee: null,
      priority: null,
      labels: ["web"],
      duedate: null,
      issuetype: { name: "Task" },
    },
  },
];

const requests: string[] = [];
let loopPages = 0;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://fake");
  requests.push(`${url.pathname}${url.search}`);
  if (req.headers.authorization !== `Basic ${Buffer.from(`${EMAIL}:${token}`).toString("base64")}`) {
    return send(res, 401, { errorMessages: ["You are not authenticated."] });
  }
  if (url.pathname === "/rest/api/3/myself") return send(res, 200, { accountId: "a-admin", displayName: "Fake Admin" });
  if (url.pathname === "/rest/api/3/project/search") {
    return send(res, 200, { values: [{ key: "OPS", name: "Operations" }, { key: "BIG", name: "Big" }], isLast: true });
  }
  if (url.pathname !== "/rest/api/3/search/jql") return send(res, 404, { errorMessages: ["Not found"] });
  const jql = url.searchParams.get("jql") ?? "";
  const project = /project = "([A-Z]+)"/.exec(jql)?.[1];
  if (project === "NOPE") return send(res, 400, { errorMessages: ["The value 'NOPE' does not exist for the field 'project'."] });
  if (project === "LOOP") {
    // Jira has been seen to hand out new tokens for the same page, endlessly.
    loopPages++;
    return send(res, 200, { issues: [issues[0]], nextPageToken: `loop-${loopPages}` });
  }
  if (project === "BIG") {
    const all = Array.from({ length: 2101 }, (_, i) => ({ ...issues[1], id: `big-${i}`, key: `BIG-${i + 1}` }));
    const start = Number(url.searchParams.get("nextPageToken") ?? 0);
    const size = Number(url.searchParams.get("maxResults"));
    const next = start + size;
    return send(res, 200, { issues: all.slice(start, next), ...(next < all.length ? { nextPageToken: String(next) } : { isLast: true }) });
  }
  const found = issues.filter((i) => !project || i.key.startsWith(`${project}-`));
  const start = Number(url.searchParams.get("nextPageToken") ?? 0);
  const next = start + PAGE;
  return send(res, 200, { issues: found.slice(start, next), ...(next < found.length ? { nextPageToken: String(next) } : { isLast: true }) });
}

const fake = createServer(handle);
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const SITE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseSync, databaseView, notification, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { addProperty, deleteProperty, getDatabaseSnapshot, getProperties, restoreProperty, updateRowProperties } = await import("@/server/databases");
const { archivePage } = await import("@/server/pages");
const { JiraError } = await import("@/server/jira-sync/client");
const manage = await import("@/server/jira-sync/manage");
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
    return error instanceof JiraError ? error.code : String(error);
  }
}

const ids = { owner: `${RUN}-owner`, ada: `${RUN}-ada` };
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

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner", email: `${ids.owner}@example.test` },
    { id: ids.ada, name: "Ada", email: adaEmail },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.ada, role: "member" },
  ]);

  // Checking the sign-in
  check((await errorCode(() => manage.checkJira({ siteUrl: SITE, email: EMAIL, token: "wrong" }))) === "unauthorized", "a wrong token is refused");
  check((await errorCode(() => manage.checkJira({ siteUrl: "http://10.1.2.3", email: EMAIL, token }))) === "invalidSite", "a private address is refused");
  check((await errorCode(() => manage.checkJira({ siteUrl: "https://localhost", email: EMAIL, token }))) === "invalidSite", "a local name is refused");
  check((await errorCode(() => manage.checkJira({ siteUrl: SITE, email: EMAIL, token: " " }))) === "invalidInput", "a missing token is refused");
  const checked = await manage.checkJira({ siteUrl: SITE, email: EMAIL, token });
  check(checked.account === "Fake Admin" && checked.projects.some((p) => p.key === "OPS"), "the right token says whose it is and lists projects", checked);

  // Setting up
  requests.length = 0;
  const result = await manage.createJiraSync(
    { userId: ids.owner },
    { workspaceId, parentId: null, siteUrl: SITE, email: EMAIL, token, query: { project: "ops" }, intervalMinutes: 60, title: "Operations" },
  );
  const databaseId = result.pages[0].id;
  check(result.created.rows === 3 && result.pages[0].title === "Operations", "setting up makes a database with a row per issue", result);
  const searches = requests.filter((r) => r.startsWith("/rest/api/3/search/jql"));
  check(searches.length === 2 && searches[1].includes("nextPageToken=2"), "issues are read page by page", searches);
  check(searches[0].includes("fields=summary%2Cstatus%2Cassignee%2Creporter%2Cpriority%2Clabels%2Cduedate%2Cissuetype"), "asking only for the fields it writes", searches[0]);

  const props = await getProperties(databaseId);
  const byName = (name: string) => props.find((p) => p.name === name)!;
  check(
    ["Key", "Status", "Assignee", "Assignee (others)", "Reporter", "Priority", "Type", "Labels", "Due date", "Jira link"].every((n) =>
      props.some((p) => p.name === n),
    ),
    "with a property for each field",
    props.map((p) => `${p.name}:${p.type}`),
  );
  const rows = await rowsOf(databaseId);
  const rowOf = (key: string) => rows.find((r) => r.properties[byName("Key").id] === key)!;
  const one = rowOf("OPS-1");
  const statusProp = byName("Status");
  const optionName = (propName: string, id: unknown) => byName(propName).options.options?.find((o) => o.id === id)?.name;
  check(one.title === "Fix the login page", "the summary is the row's title", one.title);
  check(optionName("Status", one.properties[statusProp.id]) === "In Progress", "the status is an option", one.properties);
  check(statusProp.options.options?.find((o) => o.name === "In Progress")?.group === "in_progress", "in the stage of its Jira category", statusProp.options.options);
  check(JSON.stringify(one.properties[byName("Assignee").id]) === JSON.stringify([ids.ada]), "an assignee with a member's address is that person", one.properties);
  check(rowOf("OPS-2").properties[byName("Assignee (others)").id] === "Grace Hopper", "someone else is written by name", rowOf("OPS-2").properties);
  check(
    JSON.stringify(one.properties[byName("Reporter").id]) === JSON.stringify([ids.ada]) && !(rowOf("OPS-2").properties[byName("Reporter").id] as unknown[] | null)?.length,
    "a reporter with a member's address is that person; one without, nobody",
    one.properties,
  );
  check(optionName("Priority", one.properties[byName("Priority").id]) === "High" && optionName("Type", one.properties[byName("Type").id]) === "Bug", "priority and type are options");
  const labels = one.properties[byName("Labels").id] as string[];
  check(labels.map((id) => optionName("Labels", id)).join() === "web,urgent", "labels are a multi-select", labels);
  check(JSON.stringify(one.properties[byName("Due date").id]).includes("2026-11-02"), "the due date is a date", one.properties[byName("Due date").id]);
  check(one.properties[byName("Jira link").id] === `${SITE}/browse/OPS-1`, "and the link goes back to the issue");
  const views = await db.select().from(databaseView).where(eq(databaseView.databaseId, databaseId));
  check(views.some((v) => v.type === "board" && v.config.groupBy === statusProp.id), "there is a board by status", views.map((v) => v.type));
  const adaNotes = async () => (await db.select().from(notification).where(eq(notification.userId, ids.ada))).length;
  check((await adaNotes()) === 0, "old assignments aren't announced");
  const sync = await syncRow(databaseId);
  check(sync.lastCount === 3 && sync.enabled && sync.nextRunAt && sync.nextRunAt > new Date(), "the sync is recorded, next due in an hour", sync);
  check(!sync.secrets.includes(token) && !sync.secrets.includes(EMAIL), "its sign-in is sealed");
  const snapshot = await getDatabaseSnapshot(ids.owner, databaseId);
  check(snapshot.sync?.source === "jira" && snapshot.sync.siteUrl === SITE, "the database says where it syncs from", snapshot.sync);
  const shown = await manage.getJiraSync(ids.owner, databaseId);
  check(shown?.email === EMAIL && shown.canManage && !JSON.stringify(shown).includes(token), "the sync's dialog shows the email, never the token", shown);
  check(
    shown?.reporter === byName("Reporter").id && shown.personProperties.some((p) => p.name === "Assignee") && shown.personProperties.some((p) => p.name === "Reporter"),
    "…and where reporters go, among the database's person properties",
    shown,
  );
  // Reporters can go to another person property, or nowhere.
  const raisedBy = await addProperty(ids.owner, databaseId, { name: "Raised by", type: "person" });
  const moved = await manage.updateJiraSync(ids.owner, databaseId, { reporter: raisedBy.id });
  check(moved.reporter === raisedBy.id, "the reporter can go to another person property", moved);
  check(
    JSON.stringify((await rowsOf(databaseId)).find((r) => r.id === one.id)!.properties[raisedBy.id]) === JSON.stringify([ids.ada]),
    "…which the sync fills in at once",
  );
  check((await errorCode(() => manage.updateJiraSync(ids.owner, databaseId, { reporter: byName("Key").id }))) === "invalidInput", "…but only a person property");
  const unmapped = await manage.updateJiraSync(ids.owner, databaseId, { reporter: null });
  check(unmapped.reporter === null, "…or nowhere", unmapped);
  await manage.updateJiraSync(ids.owner, databaseId, { reporter: byName("Reporter").id });

  // Changes in Jira
  const notes = await addProperty(ids.owner, databaseId, { name: "Notes", type: "text" });
  await updateRowProperties(ids.owner, one.id, { [notes.id]: "Ours" });
  await archivePage(ids.owner, rowOf("OPS-3").id);
  issues[0].fields.summary = "Fix the login page for good";
  issues[0].fields.status = status("Done", "done");
  issues[1].fields.assignee = { accountId: "a-ada", displayName: "Ada Jira", emailAddress: adaEmail };
  issues.push({
    id: "4",
    key: "OPS-4",
    fields: {
      summary: "Block the release",
      status: status("Review", "indeterminate"),
      assignee: null,
      priority: { name: "Blocker" },
      labels: ["release"],
      duedate: null,
      issuetype: { name: "Bug" },
    },
  });
  check((await runDue(databaseId)) === 1, "a due sync runs");
  const after = await rowsOf(databaseId);
  const props2 = await getProperties(databaseId);
  const name2 = (propName: string, id: unknown) => props2.find((p) => p.name === propName)?.options.options?.find((o) => o.id === id)?.name;
  const one2 = after.find((r) => r.id === one.id)!;
  check(name2("Status", one2.properties[statusProp.id]) === "Done", "a changed status is written over", one2.properties);
  check(one2.properties[notes.id] === "Ours", "a property people added keeps its value");
  check(await waitForTitle(one.id, "Fix the login page for good"), "a changed summary renames the row");
  const two = after.find((r) => r.properties[byName("Key").id] === "OPS-2")!;
  check(
    JSON.stringify(two.properties[byName("Assignee").id]) === JSON.stringify([ids.ada]) && !(byName("Assignee (others)").id in two.properties),
    "a new assignee who is a member is the person, the name beside it cleared",
    two.properties,
  );
  check((await adaNotes()) >= 1, "and is told of the assignment");
  const four = after.find((r) => r.properties[byName("Key").id] === "OPS-4");
  check(four && name2("Priority", four.properties[byName("Priority").id]) === "Blocker", "a new issue adds a row, with a new option", four?.properties);
  check(props2.find((p) => p.name === "Status")?.options.options?.find((o) => o.name === "Review")?.group === "in_progress", "a new status gets its stage");
  const three = after.filter((r) => r.properties[byName("Key").id] === "OPS-3");
  check(three.length === 1 && three[0].archivedAt, "a row in the trash stays there, and isn't made again", three);

  const before = new Map(after.map((r) => [r.id, r.updatedAt.getTime()]));
  const again = await manage.syncJiraNow(ids.owner, databaseId);
  const unchanged = await rowsOf(databaseId);
  check(again.outcome.error === null && again.outcome.count === 4, "syncing by hand runs it now", again);
  check(unchanged.every((r) => before.get(r.id) === r.updatedAt.getTime()), "a run without changes changes no row");

  // Paused, and back
  token = "token-2";
  const refused = await manage.syncJiraNow(ids.owner, databaseId);
  check(refused.outcome.error === "unauthorized" && !refused.enabled, "a revoked token pauses the sync", refused);
  check((await runDue(databaseId)) === 0, "a paused sync isn't run when due");
  check((await errorCode(() => manage.updateJiraSync(ids.owner, databaseId, { email: EMAIL, token: "token-1" }))) === "unauthorized", "a new token is checked with Jira first");
  const renewed = await manage.updateJiraSync(ids.owner, databaseId, { email: EMAIL, token });
  check(renewed.enabled && renewed.lastError === null, "a new sign-in syncs it again", renewed);

  const badQuery = await manage.updateJiraSync(ids.owner, databaseId, { query: { project: "NOPE" } });
  check(badQuery.lastError === "badQuery" && badQuery.lastErrorDetail?.includes("NOPE") && !badQuery.enabled, "a refused query pauses it, with Jira's words", badQuery);
  const big = await manage.updateJiraSync(ids.owner, databaseId, { query: { project: "BIG" } });
  check(big.lastError === "tooManyIssues" && (await rowsOf(databaseId)).length === 4, "a query finding too many issues writes nothing", big);
  const loop = await manage.updateJiraSync(ids.owner, databaseId, { query: { project: "LOOP" } });
  check(loop.lastError === null && loopPages < 5, "an endless chain of page tokens ends", { loop, loopPages });
  await manage.updateJiraSync(ids.owner, databaseId, { query: { project: "OPS" } });

  await deleteProperty(ids.owner, byName("Key").id);
  const keyless = await manage.syncJiraNow(ids.owner, databaseId);
  check(keyless.outcome.error === "keyGone" && !keyless.enabled, "without its Key property it pauses", keyless);
  await restoreProperty(ids.owner, byName("Key").id);
  check((await manage.syncJiraNow(ids.owner, databaseId)).outcome.error === null, "and goes on when the property is back");

  const interval = await manage.updateJiraSync(ids.owner, databaseId, { intervalMinutes: 0 });
  check(interval.intervalMinutes === 0 && (await syncRow(databaseId)).nextRunAt === null, "only when asked: it never falls due");
  check((await errorCode(() => manage.updateJiraSync(ids.owner, databaseId, { intervalMinutes: 7 }))) === "invalidInput", "an interval it doesn't offer is refused");

  // Stopping
  await manage.stopJiraSync(ids.owner, databaseId);
  check(!(await syncRow(databaseId)) && (await rowsOf(databaseId)).filter((r) => !r.archivedAt).length === 3, "stopping forgets the sync and keeps the rows");
  check((await getDatabaseSnapshot(ids.owner, databaseId)).sync === null, "and the database no longer says it syncs");
  const live = await db.select({ id: page.id }).from(page).where(and(eq(page.id, databaseId), isNull(page.archivedAt)));
  check(live.length === 1, "the database stays");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(notification).where(eq(notification.workspaceId, workspaceId));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  hocuspocus.closeConnections();
  fake.close();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
