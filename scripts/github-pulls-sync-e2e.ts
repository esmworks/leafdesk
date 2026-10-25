/**
 * End-to-end check of GitHub pull request syncs against the database and a fake GitHub (an HTTP
 * server started here on 127.0.0.1, answering the REST calls a sync makes): private addresses, bad
 * repository names, a private repository without a token and a wrong token are refused; setting
 * one up makes a database of the open pull requests (number, title, state by stage, an author and
 * assignees who sign in with GitHub as people and others as logins, labels, branches, dates, link)
 * with a board by state, without telling anyone of their old assignments; the token is sealed. A
 * due run writes GitHub's changes over, finishes rows of pull requests that were merged or closed
 * since, adds new ones but no row for a closed pull request it never had, and tells a newly assigned
 * member; a run without changes changes nothing. Taking all pull requests reads them page by page.
 * A spent rate limit passes; a refused token and a missing Number property pause the sync. Jira's
 * functions leave a GitHub sync alone; stopping keeps the rows. Creates its own users and workspace
 * and deletes them afterwards.
 *
 *   pnpm tsx scripts/github-pulls-sync-e2e.ts
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

// The fake GitHub is on this machine: let the connections' fetch reach it (read when env loads).
process.env.CONNECTOR_ALLOWED_HOSTS = "127.0.0.1";

const RUN = `ghpulls-${Date.now()}`;
let token = "token-1";
let rateLimited = false;

type FakePull = {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged_at: string | null;
  updated_at: string;
  user: { id: number; login: string };
  assignees: { id: number; login: string }[];
  labels: { name: string }[];
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  html_url: string;
};

const ADA = { id: 101, login: "ada" };
const GRACE = { id: 202, login: "grace" };
let clock = Date.parse("2026-10-01T10:00:00Z");
const pull = (number: number, fields: Partial<FakePull> = {}): FakePull => ({
  number,
  title: `Pull ${number}`,
  state: "open",
  draft: false,
  merged_at: null,
  updated_at: new Date((clock += 60_000)).toISOString(),
  user: GRACE,
  assignees: [],
  labels: [],
  head: { ref: `branch-${number}` },
  base: { ref: "main" },
  created_at: "2026-10-01T09:00:00Z",
  html_url: `https://github.com/acme/app/pull/${number}`,
  ...fields,
});

const pulls: FakePull[] = [
  pull(1, { title: "Draft the new login", draft: true, user: ADA, labels: [{ name: "auth" }] }),
  pull(2, { title: "Fix the footer", assignees: [GRACE], labels: [{ name: "ui" }, { name: "bug" }] }),
  pull(3, { title: "An old merged one", state: "closed", merged_at: "2026-09-01T00:00:00Z" }),
];
const big = Array.from({ length: 130 }, (_, i) => pull(i + 1, { title: `Big ${i + 1}`, state: i % 2 ? "closed" : "open" }));

const requests: string[] = [];

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://fake");
  requests.push(`${url.pathname}${url.search}`);
  if (rateLimited) return send(res, 403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
  const auth = req.headers.authorization;
  if (auth && auth !== `Bearer ${token}`) return send(res, 401, { message: "Bad credentials" });
  const match = /^\/api\/v3\/repos\/([^/]+\/[^/]+)(\/pulls)?$/.exec(url.pathname);
  const repo = match?.[1];
  // acme/secret is private: without a token it isn't there.
  if (!repo || !["acme/app", "acme/big", "acme/secret"].includes(repo) || (repo === "acme/secret" && !auth)) {
    return send(res, 404, { message: "Not Found" });
  }
  if (!match[2]) return send(res, 200, { full_name: repo, private: repo === "acme/secret" });
  const state = url.searchParams.get("state") ?? "open";
  const size = Number(url.searchParams.get("per_page") ?? 30);
  const pageNumber = Number(url.searchParams.get("page") ?? 1);
  const found = (repo === "acme/big" ? big : repo === "acme/app" ? pulls : [])
    .filter((p) => state === "all" || p.state === state)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return send(res, 200, found.slice((pageNumber - 1) * size, pageNumber * size));
}

const fake = createServer(handle);
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const API = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { db } = await import("@/db");
const { account, databaseSync, databaseView, notification, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { AccessError } = await import("@/server/access");
const { addProperty, deleteProperty, getDatabaseSnapshot, getProperties, restoreProperty, updateRowProperties } = await import("@/server/databases");
const { JiraError } = await import("@/server/jira-sync/client");
const jira = await import("@/server/jira-sync/manage");
const manage = await import("@/server/github-pulls/manage");
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

const setup = (fields: Partial<Parameters<typeof manage.createGithubPullsSync>[1]>) =>
  manage.createGithubPullsSync({ userId: ids.owner }, { workspaceId, parentId: null, apiUrl: API, query: { repo: "acme/app" }, token, ...fields });

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner", email: `${ids.owner}@example.test` },
    { id: ids.ada, name: "Ada", email: `${ids.ada}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.ada, role: "member" },
  ]);
  // Ada signs in with her GitHub account.
  await db.insert(account).values({ id: `${RUN}-acc`, accountId: String(ADA.id), providerId: "github", userId: ids.ada, updatedAt: new Date() });

  // What is refused before anything is made
  check((await errorCode(() => setup({ apiUrl: "http://10.1.2.3" }))) === "invalidSite", "a private address is refused");
  check((await errorCode(() => setup({ query: { repo: "not a repo" } }))) === "invalidInput", "a bad repository name is refused");
  check((await errorCode(() => setup({ query: { repo: "acme/secret" }, token: "" }))) === "notFound", "a private repository without a token isn't found");
  check((await errorCode(() => setup({ token: "wrong" }))) === "unauthorized", "a wrong token is refused");
  const before = await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId));
  check(before.length === 0, "and nothing was made");

  // Setting up
  requests.length = 0;
  const result = await setup({ intervalMinutes: 60 });
  const databaseId = result.pages[0].id;
  check(result.created.rows === 2 && result.pages[0].title === "acme/app", "setting up makes a database of the open pull requests, named after the repository", result);
  check(
    requests.some((r) => r.includes("state=open") && r.includes("sort=updated")) && requests.some((r) => r.includes("state=closed")),
    "it reads the open ones, most recently updated first, and the last closed ones",
    requests,
  );
  const props = await getProperties(databaseId);
  const byName = (name: string) => props.find((p) => p.name === name)!;
  check(
    ["Number", "State", "Author", "Author (others)", "Assignees", "Assignees (others)", "Labels", "Branch", "Base branch", "Created", "Merged", "GitHub link"].every(
      (n) => props.some((p) => p.name === n),
    ),
    "with a property for each field",
    props.map((p) => `${p.name}:${p.type}`),
  );
  const rows = await rowsOf(databaseId);
  const rowOf = (n: number) => rows.find((r) => r.properties[byName("Number").id] === n)!;
  const optionName = (propName: string, id: unknown) => byName(propName).options.options?.find((o) => o.id === id)?.name;
  const one = rowOf(1);
  const stateProp = byName("State");
  check(one.title === "Draft the new login", "the title is the row's title", one.title);
  check(optionName("State", one.properties[stateProp.id]) === "Draft", "a draft is in Draft", one.properties);
  check(
    ["Draft", "Open", "Merged", "Closed"].every((n) => stateProp.options.options?.some((o) => o.name === n)) &&
      stateProp.options.options?.find((o) => o.name === "Merged")?.group === "done",
    "the state has the four stages, merged among done",
    stateProp.options.options,
  );
  check(JSON.stringify(one.properties[byName("Author").id]) === JSON.stringify([ids.ada]), "an author who signs in with GitHub is that person", one.properties);
  const two = rowOf(2);
  check(two.properties[byName("Author (others)").id] === "grace" && two.properties[byName("Assignees (others)").id] === "grace", "someone else is written by login", two.properties);
  check(
    (two.properties[byName("Labels").id] as string[]).map((id) => optionName("Labels", id)).join() === "ui,bug" &&
      two.properties[byName("Branch").id] === "branch-2" &&
      two.properties[byName("Base branch").id] === "main",
    "labels are a multi-select, branches text",
    two.properties,
  );
  check(two.properties[byName("GitHub link").id] === "https://github.com/acme/app/pull/2", "and the link goes back to the pull request");
  check(!rows.some((r) => r.properties[byName("Number").id] === 3), "a merged pull request it never had isn't added");
  const views = await db.select().from(databaseView).where(eq(databaseView.databaseId, databaseId));
  check(views.some((v) => v.type === "board" && v.config.groupBy === stateProp.id), "there is a board by state");
  const adaNotes = async () => (await db.select().from(notification).where(eq(notification.userId, ids.ada))).length;
  check((await adaNotes()) === 0, "old assignments aren't announced");
  const sync = await syncRow(databaseId);
  check(sync.source === "github" && sync.siteUrl === `${API}/api/v3` && sync.lastCount === 2 && sync.nextRunAt && sync.nextRunAt > new Date(), "the sync is recorded", sync);
  check(!sync.secrets.includes(token), "its token is sealed");
  const snapshot = await getDatabaseSnapshot(ids.owner, databaseId);
  check(snapshot.sync?.source === "github", "the database says it syncs from GitHub", snapshot.sync);
  const shown = await manage.getGithubPullsSync(ids.owner, databaseId);
  check(shown?.repo === "acme/app" && shown.hasToken && shown.canManage && !JSON.stringify(shown).includes(token), "the sync's dialog shows the repository, never the token", shown);
  check((await jira.getJiraSync(ids.owner, databaseId)) === null, "Jira's functions don't see a GitHub sync");
  check((await errorCode(() => jira.stopJiraSync(ids.owner, databaseId))) === "access", "…and can't stop it");

  // Changes on GitHub
  const notes = await addProperty(ids.owner, databaseId, { name: "Notes", type: "text" });
  await updateRowProperties(ids.owner, one.id, { [notes.id]: "Ours" });
  Object.assign(pulls[0], { draft: false, title: "Ship the new login", updated_at: new Date((clock += 60_000)).toISOString() });
  Object.assign(pulls[1], { state: "closed", merged_at: "2026-10-03T12:00:00Z", updated_at: new Date((clock += 60_000)).toISOString() });
  pulls.push(pull(4, { title: "Add dark mode", assignees: [ADA], labels: [{ name: "design" }] }));
  pulls.push(pull(5, { title: "Closed without a row", state: "closed" }));
  check((await runDue(databaseId)) === 1, "a due sync runs");
  const after = await rowsOf(databaseId);
  const props2 = await getProperties(databaseId);
  const name2 = (propName: string, id: unknown) => props2.find((p) => p.name === propName)?.options.options?.find((o) => o.id === id)?.name;
  const one2 = after.find((r) => r.id === one.id)!;
  check(name2("State", one2.properties[stateProp.id]) === "Open", "a draft made ready is Open", one2.properties);
  check(one2.properties[notes.id] === "Ours", "a property people added keeps its value");
  check(await waitForTitle(one.id, "Ship the new login"), "a changed title renames the row");
  const two2 = after.find((r) => r.id === two.id)!;
  check(
    name2("State", two2.properties[stateProp.id]) === "Merged" && String(two2.properties[byName("Merged").id]).startsWith("2026-10-03"),
    "a pull request merged since is finished: Merged, with the date",
    two2.properties,
  );
  const four = after.find((r) => r.properties[byName("Number").id] === 4);
  check(four && JSON.stringify(four.properties[byName("Assignees").id]) === JSON.stringify([ids.ada]), "a new pull request adds a row, its assignee a person", four?.properties);
  check(props2.find((p) => p.name === "Labels")?.options.options?.some((o) => o.name === "design"), "with a new label option");
  check(!after.some((r) => r.properties[byName("Number").id] === 5), "a closed pull request it never had isn't added");
  // Assigning Ada on an existing row tells her.
  pulls[0].assignees = [ADA];
  pulls[0].updated_at = new Date((clock += 60_000)).toISOString();
  await manage.syncGithubPullsNow(ids.owner, databaseId);
  check((await adaNotes()) >= 1, "a member newly assigned on a later run is told");

  const stamps = new Map((await rowsOf(databaseId)).map((r) => [r.id, r.updatedAt.getTime()]));
  const again = await manage.syncGithubPullsNow(ids.owner, databaseId);
  check(again.outcome.error === null && again.outcome.count === 2, "syncing by hand runs it now", again);
  check((await rowsOf(databaseId)).every((r) => stamps.get(r.id) === r.updatedAt.getTime()), "a run without changes changes no row");

  // Passing problems and pauses
  rateLimited = true;
  const limited = await manage.syncGithubPullsNow(ids.owner, databaseId);
  check(limited.outcome.error === "unreachable" && limited.enabled, "a spent rate limit is passing: the sync stays on", limited);
  rateLimited = false;
  token = "token-2";
  const refused = await manage.syncGithubPullsNow(ids.owner, databaseId);
  check(refused.outcome.error === "unauthorized" && !refused.enabled, "a revoked token pauses the sync", refused);
  check((await runDue(databaseId)) === 0, "a paused sync isn't run when due");
  check((await errorCode(() => manage.updateGithubPullsSync(ids.owner, databaseId, { token: "token-1" }))) === "unauthorized", "a new token is checked with GitHub first");
  const renewed = await manage.updateGithubPullsSync(ids.owner, databaseId, { token });
  check(renewed.enabled && renewed.lastError === null, "a new token syncs it again", renewed);

  const all = await manage.updateGithubPullsSync(ids.owner, databaseId, { state: "all" });
  check(all.state === "all" && all.lastCount === 5, "taking all pull requests syncs at once", all);
  check((await rowsOf(databaseId)).filter((r) => !r.archivedAt).length === 5, "…adding the closed ones too");

  await deleteProperty(ids.owner, byName("Number").id);
  const keyless = await manage.syncGithubPullsNow(ids.owner, databaseId);
  check(keyless.outcome.error === "keyGone" && !keyless.enabled, "without its Number property it pauses", keyless);
  await restoreProperty(ids.owner, byName("Number").id);
  check((await manage.syncGithubPullsNow(ids.owner, databaseId)).outcome.error === null, "and goes on when the property is back");

  const interval = await manage.updateGithubPullsSync(ids.owner, databaseId, { intervalMinutes: 0 });
  check(interval.intervalMinutes === 0 && (await syncRow(databaseId)).nextRunAt === null, "only when asked: it never falls due");
  check((await errorCode(() => manage.updateGithubPullsSync(ids.owner, databaseId, { state: "closed" }))) === "invalidInput", "a state it doesn't offer is refused");

  // Many pull requests, page by page
  requests.length = 0;
  const many = await setup({ query: { repo: "acme/big", state: "all" }, token: "" });
  check(many.created.rows === 130, "all pull requests of a bigger repository are read", many.created);
  check(requests.filter((r) => r.includes("/pulls?")).length === 2 && requests.some((r) => r.includes("page=2")), "…page by page", requests);
  check(!(await manage.getGithubPullsSync(ids.owner, many.pages[0].id))?.hasToken, "a public repository syncs without a token");

  // Stopping
  await manage.stopGithubPullsSync(ids.owner, databaseId);
  check(!(await syncRow(databaseId)) && (await rowsOf(databaseId)).filter((r) => !r.archivedAt).length === 5, "stopping forgets the sync and keeps the rows");
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
