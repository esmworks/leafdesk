/**
 * Times the large workspace scripts/scale-seed.ts makes (5,000 pages, a database of 50,000 rows)
 * the way the app uses it, against a running server: opening the database and loading its rows,
 * filtering and sorting them (in the browser's own code, and through the REST API's query, as MCP
 * and agents read them), the search box, opening a page, the sidebar reloading after a change, and
 * connecting to a page's live document. Each is timed RUNS times after a warm-up; the median is
 * held to its limit in LIMITS, set for CI's runners with room for their noise, so that this catches
 * a path that became several times slower rather than a few percent.
 *
 *   pnpm tsx scripts/scale-seed.ts && pnpm tsx scripts/scale-e2e.ts
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL and BETTER_AUTH_SECRET (read from .env
 * when present; the server's own), SCALE_ASSERT=0 to print the times without failing. The server
 * must be a production build (`pnpm build && pnpm start`): a dev server compiles pages on demand
 * and is several times slower.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSignature } from "better-auth/crypto";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, asc, eq, isNotNull, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, session, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { env } = await import("@/lib/env");
const { applyView } = await import("@/lib/properties");
const { createApiToken, revokeApiToken } = await import("@/server/api/tokens");
const { getDatabaseSnapshot } = await import("@/server/databases");
const Y = await import("yjs");
const { HocuspocusProvider } = await import("@hocuspocus/provider");

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ASSERT = process.env.SCALE_ASSERT !== "0";
const RUNS = 5;
// The seed's owner (scripts/scale-seed.ts).
const OWNER = "scale-e2e-owner";

/**
 * Medians in milliseconds, on CI's runners (ubuntu-24.04, 4 cores). A limit is a few times the
 * median measured there, so a slow runner passes and a path several times slower fails.
 */
const LIMITS: Record<string, number> = {
  "open the database page": 3_000,
  "load the table's rows": 6_000,
  "filter in the browser": 400,
  "sort in the browser": 800,
  "API query with a filter": 4_000,
  "API query sorted": 4_000,
  "open the search box": 1_000,
  "search a common word": 1_000,
  "search a title": 1_000,
  "open a page": 3_000,
  "a page's links and mentions": 1_500,
  "reload the sidebar": 1_500,
  "connect to a page (first time)": 1_000,
  "connect to a page again": 500,
};

let failed = 0;
const results: { label: string; median: number; min: number; max: number; limit: number; note: string }[] = [];

function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail.slice(0, 2000) : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
}

/** Times `fn` RUNS times after one untimed warm-up; `fn` returns a note (a size, a count). */
async function time(label: string, fn: (run: number) => Promise<string | void>) {
  await fn(-1);
  const times: number[] = [];
  let note = "";
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    note = (await fn(run)) || note;
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const limit = LIMITS[label];
  results.push({ label, median, min: times[0], max: times.at(-1)!, limit, note });
  const over = median > limit;
  if (over) failed++;
  console.log(`${over ? "SLOW " : "ok   "} ${label.padEnd(32)} ${ms(median).padStart(8)}  (limit ${ms(limit)}, ${ms(times[0])}–${ms(times.at(-1)!)})${note ? `  ${note}` : ""}`);
}
const ms = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`;
const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString("en")} KB`;

/** The cookies of one browser, starting from a session made in the database. */
class Jar {
  private cookies = new Map<string, string>();
  constructor(cookie: string) {
    const at = cookie.indexOf("=");
    this.cookies.set(cookie.slice(0, at), cookie.slice(at + 1));
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** The server action's id, from the running build's manifests. */
function actionId(file: string, name: string) {
  const root = process.env.NEXT_DIR ?? ".next";
  const manifests: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "server-reference-manifest.json") manifests.push(path);
    }
  };
  walk(join(root, "server"));
  for (const manifest of manifests) {
    const { node = {} } = JSON.parse(readFileSync(manifest, "utf8")) as { node?: Record<string, { exportedName?: string; filename?: string }> };
    for (const [id, entry] of Object.entries(node)) if (entry.filename === file && entry.exportedName === name) return id;
  }
  throw new Error(`No id for ${file}#${name} under ${root}: is the server a production build of this checkout?`);
}

/** Calls a server action the way the page at `path` does, reading the whole answer. */
async function callAction(jar: Jar, path: string, file: string, name: string, args: unknown[]) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId(file, name),
      origin: BASE,
      cookie: jar.header(),
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  check(res.status === 200, `${name} answers`, { status: res.status, text: text.slice(0, 500) });
  return text;
}

async function getHtml(jar: Jar, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "text/html", "accept-language": "en", cookie: jar.header() }, redirect: "manual" });
  const text = await res.text();
  check(res.status === 200, `GET ${path}`, { status: res.status, location: res.headers.get("location") });
  return text;
}

/** A browser tab's live connection to a page; resolves once it synced. */
async function connect(jar: Jar, pageId: string) {
  const tokenRes = await fetch(`${BASE}/api/collab-token`, { headers: { cookie: jar.header() } });
  const { token, build } = (await tokenRes.json()) as { token: string; build?: string | null };
  const doc = new Y.Doc();
  let settle: (outcome: "synced" | "refused") => void = () => {};
  const settled = new Promise<"synced" | "refused">((resolve) => (settle = resolve));
  const provider = new HocuspocusProvider({
    url: `${BASE.replace(/^http/, "ws")}/collab${build ? `?build=${encodeURIComponent(build)}` : ""}`,
    name: `page:${pageId}`,
    document: doc,
    token,
    onSynced: () => settle("synced"),
    onAuthenticationFailed: () => settle("refused"),
  });
  const outcome = await Promise.race([settled, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]);
  const blocks = doc.getXmlFragment(COLLAB_FRAGMENT).length;
  provider.destroy();
  check(outcome === "synced" && blocks > 0, `the live document of ${pageId} syncs with its body`, { outcome, blocks });
}

const sessionToken = randomBytes(24).toString("hex");
const sessionId = `scale-e2e-session-${randomBytes(4).toString("hex")}`;
let apiTokenId: string | null = null;

try {
  // ---------------------------------------------------------------- the seeded workspace
  const [ws] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .innerJoin(workspaceMember, eq(workspaceMember.workspaceId, workspace.id))
    .where(and(eq(workspaceMember.userId, OWNER), eq(workspace.name, "Scale test")));
  check(ws, "the scale workspace is there (run scripts/scale-seed.ts first)");
  const workspaceId = ws.id;
  const [database] = await db
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), eq(page.kind, "database"), eq(page.title, "Scale tasks")));
  check(database, "the scale database is there");
  const [{ rows, pages }] = await db
    .select({
      rows: sql<number>`count(*) filter (where ${page.parentId} = ${database.id})::int`,
      pages: sql<number>`count(*) filter (where ${page.kind} = 'page' and (${page.parentId} is null or ${page.parentId} <> ${database.id}))::int`,
    })
    .from(page)
    .where(eq(page.workspaceId, workspaceId));
  console.log(`Workspace ${workspaceId}: ${pages.toLocaleString("en")} pages, a database of ${rows.toLocaleString("en")} rows\n`);
  // Pages three levels down with a body: the ones a deep link or the search box opens.
  const leaves = await db
    .select({ id: page.id, title: page.title })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), eq(page.kind, "page"), isNotNull(page.ydoc), sql`${page.title} ~ '\\d+\\.\\d+\\.\\d+$'`))
    .orderBy(asc(page.createdAt))
    .limit(RUNS + 2);
  check(leaves.length === RUNS + 2, "the workspace has pages three levels down", leaves.length);

  await db.insert(session).values({ id: sessionId, token: sessionToken, userId: OWNER, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  const jar = new Jar(`better-auth.session_token=${encodeURIComponent(`${sessionToken}.${await makeSignature(sessionToken, env.authSecret)}`)}`);
  const api = await createApiToken(OWNER, { name: "scale-e2e", scopes: ["pages:read"], workspaceId });
  apiTokenId = api.token.id;
  const databasePath = `/w/${workspaceId}/p/${database.id}`;

  // ---------------------------------------------------------------- the database
  await time("open the database page", async () => {
    const html = await getHtml(jar, databasePath);
    return kb(html.length);
  });
  await time("load the table's rows", async () => {
    const text = await callAction(jar, databasePath, "src/app/actions/databases.ts", "loadDatabaseAction", [database.id, {}]);
    check(text.includes("Task 1 "), "the rows come back", text.slice(0, 300));
    return kb(text.length);
  });

  // What the browser does when a filter or sort changes: the rows it holds, in the same code.
  const snapshot = await getDatabaseSnapshot(OWNER, database.id, {});
  const prop = (name: string) => snapshot.properties.find((p) => p.name === name)!;
  const high = prop("Priority").options.options!.find((o) => o.name === "High")!.id;
  const viewer = { viewerId: OWNER, people: snapshot.people };
  let shown = 0;
  await time("filter in the browser", async () => {
    shown = applyView(
      snapshot.rows,
      {
        filters: [
          { propertyId: prop("Priority").id, op: "equals", value: high },
          { propertyId: prop("Done").id, op: "equals", value: false },
        ],
      },
      snapshot.properties,
      viewer,
    ).length;
    return `${shown.toLocaleString("en")} rows shown`;
  });
  check(shown > 1000 && shown < snapshot.rows.length / 4, "the filter keeps about a sixth of the rows", shown);
  let first = "";
  await time("sort in the browser", async () => {
    const sorted = applyView(snapshot.rows, { sorts: [{ propertyId: prop("Amount").id, direction: "desc" }] }, snapshot.properties, viewer);
    first = sorted[0].title;
    return `${sorted.length.toLocaleString("en")} rows`;
  });
  check(first, "the sort puts a row first");

  const query = async (body: unknown) => {
    const res = await fetch(`${BASE}/api/v1/databases/${database.id}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { rows?: unknown[]; total?: number; error?: unknown };
    check(res.status === 200 && json.rows?.length === 50, "the query answers a page of rows", { status: res.status, error: json.error });
    return `${json.total?.toLocaleString("en")} matching`;
  };
  await time("API query with a filter", () =>
    query({ filters: [{ property: "Priority", op: "equals", value: "High" }, { property: "Done", op: "equals", value: false }], limit: 50 }),
  );
  await time("API query sorted", () => query({ sorts: [{ property: "Amount", direction: "desc" }], limit: 50 }));

  // ---------------------------------------------------------------- the search box
  const pagePath = `/w/${workspaceId}/p/${leaves[0].id}`;
  await time("open the search box", async () => {
    const text = await callAction(jar, pagePath, "src/app/actions/pages.ts", "recentSearchAction", [workspaceId]);
    return kb(text.length);
  });
  await time("search a common word", async () => {
    const text = await callAction(jar, pagePath, "src/app/actions/pages.ts", "searchAction", [workspaceId, "budget"]);
    check(text.includes("budget") || text.includes("Budget"), "a common word finds pages", text.slice(0, 300));
  });
  const wanted = leaves[1].title;
  await time("search a title", async () => {
    const text = await callAction(jar, pagePath, "src/app/actions/pages.ts", "searchAction", [workspaceId, wanted]);
    check(text.includes(leaves[1].id), "a page's title finds it", text.slice(0, 300));
  });

  // ---------------------------------------------------------------- a page
  await time("open a page", async () => {
    const html = await getHtml(jar, pagePath);
    return kb(html.length);
  });
  await time("a page's links and mentions", async () => {
    await callAction(jar, pagePath, "src/app/actions/mentions.ts", "backlinksAction", [leaves[0].id]);
    await callAction(jar, pagePath, "src/app/actions/mentions.ts", "unlinkedMentionsAction", [leaves[0].id]);
  });
  await time("reload the sidebar", async () => {
    const text = await callAction(jar, pagePath, "src/app/actions/pages.ts", "getSidebarAction", [workspaceId]);
    return kb(text.length);
  });

  // ---------------------------------------------------------------- live documents
  // A page nobody has open is loaded from the database; one open already is in the server's memory.
  // Each timed run of the first connects to another page (the warm-up takes leaves[RUNS + 1]).
  await time("connect to a page (first time)", (run) => connect(jar, leaves[run < 0 ? RUNS + 1 : run + 1].id));
  await time("connect to a page again", () => connect(jar, leaves[1].id));

  console.log(`\n${results.length} timings, ${failed} over their limit${ASSERT ? "" : " (SCALE_ASSERT=0: not failing)"}`);
  if (failed && ASSERT) process.exitCode = 1;
} finally {
  await db.delete(session).where(eq(session.id, sessionId));
  if (apiTokenId) await revokeApiToken(OWNER, apiTokenId);
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
