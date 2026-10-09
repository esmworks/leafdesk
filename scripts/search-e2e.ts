/**
 * End-to-end check of the search box's filters against the database: `in:` (a title, quoted or
 * not, several pages of one title, a page the person can't see), `type:` (pages, databases, rows),
 * filters without text, filters with text, and the pages last edited before anything is typed.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/search-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage, recentPages, searchWithQuery } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");

const RUN = `search-e2e-${Date.now().toString(36)}`;

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

const ids = { owner: `${RUN}-owner`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const titlesOf = (hits: { title: string }[]) => hits.map((h) => h.title).sort();

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const owner = { userId: ids.owner };
  const make = (title: string, parentId: string | null = null, kind: "page" | "database" = "page") =>
    createPage(owner, { workspaceId, parentId, title, kind });

  const projects = await make("Projects");
  await make("Budget plan", projects.id);
  const tracker = await make("Tracker", projects.id, "database");
  await make("Budget row", tracker.id);
  const launch = await make("Launch plan");
  await make("Budget notes", launch.id);
  const archive = await make("Archive");
  const oldProjects = await make("projects", archive.id);
  await make("Old budget", oldProjects.id);
  await make("Budget elsewhere");

  const search = (query: string, userId = ids.owner) => searchWithQuery(userId, workspaceId, query);

  check(titlesOf(await search("budget")).length === 5, "plain text finds every page with the word", titlesOf(await search("budget")));
  check(
    JSON.stringify(titlesOf(await search("budget in:Projects"))) === JSON.stringify(["Budget plan", "Budget row", "Old budget"]),
    "in: limits the search to the pages under every page of that title (without case)",
    titlesOf(await search("budget in:Projects")),
  );
  check(
    JSON.stringify(titlesOf(await search('budget in:"Launch plan"'))) === JSON.stringify(["Budget notes"]),
    "a quoted title with spaces works",
  );
  check(
    JSON.stringify(titlesOf(await search("in:Projects in:Archive budget"))) ===
      JSON.stringify(["Budget plan", "Budget row", "Old budget"].sort()),
    "several in: filters find pages under any of them",
  );
  check((await search("budget in:Nowhere")).length === 0, "an in: naming no page finds nothing (not everything)");

  check(
    JSON.stringify(titlesOf(await search("type:database"))) === JSON.stringify(["Tracker"]),
    "type:database alone lists the databases",
  );
  check(
    JSON.stringify(titlesOf(await search("budget type:row"))) === JSON.stringify(["Budget row"]),
    "type:row finds database rows",
  );
  check(
    !titlesOf(await search("budget type:page")).includes("Budget row") && titlesOf(await search("budget type:page")).length === 4,
    "type:page leaves the rows out",
    titlesOf(await search("budget type:page")),
  );
  const inside = titlesOf(await search("in:Launch"));
  check(inside.length === 0, "in: matches whole titles, not parts", inside);
  const underLaunch = titlesOf(await search('in:"launch plan"'));
  check(
    JSON.stringify(underLaunch) === JSON.stringify(["Budget notes", "Launch plan"]),
    "in: alone lists the page and everything under it",
    underLaunch,
  );
  check((await search("type:folder")).length === 0 && (await search("")).length === 0, "an unknown type is text, and an empty query finds nothing");

  // Someone who can only see one page doesn't reach others through in:
  await setPagePermission(ids.owner, launch.id, ids.guest, "view");
  check(
    JSON.stringify(titlesOf(await search("budget", ids.guest))) === JSON.stringify(["Budget notes"]),
    "a guest finds only what is shared with them",
    titlesOf(await search("budget", ids.guest)),
  );
  check((await search("budget in:Projects", ids.guest)).length === 0, "…and in: naming a page they can't see finds nothing");

  const recent = await recentPages(ids.owner, workspaceId, 3);
  check(recent.length === 3 && recent[0].updatedAt >= recent[2].updatedAt, "the pages last edited come newest first", recent);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
