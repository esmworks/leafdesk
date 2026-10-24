/**
 * End-to-end check of database views (B) against the database: feed views (made through the
 * operations the MCP tools and the REST API share, newest post first unless sorted), their posts
 * (body excerpts, comments, authors) and reactions to rows, which follow page access (viewers
 * can't react, commenters can, outsiders learn nothing); database tabs, a dashboard laid out as
 * tabs, which a rewrite of the page's Markdown keeps as tabs; and row page layout (pinned
 * properties and properties beside the body), which takes full access and pins only a few.
 * Creates its own users and workspace and deletes them afterwards. Runs its own collaboration
 * service, so it needs no server.
 *
 *   pnpm tsx scripts/feed-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { addProperty, addView, deleteProperty, getProperties, getRow, setPropertiesBeside, setPropertyPinned } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { changeComments } = await import("@/server/comments");
const { listReactions, setReaction, ReactionError } = await import("@/server/reactions");
const { feedBody, feedPosts } = await import("@/server/feed");
const { queryDatabase } = await import("@/server/operations");
const { dashboardsOutput } = await import("@/server/mcp/dashboards");
const { AccessError, resolvePageAccess } = await import("@/server/access");
const { DASHBOARD_BLOCK, dashboardLine, newTab, serializeDashboard } = await import("@/lib/dashboard");
const { MAX_PINNED } = await import("@/lib/row-layout");

const RUN = `feed-e2e-${Date.now().toString(36)}`;
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

/** How a call failed: "AccessError", a reaction error's code, another error's message, or "resolved". */
async function failure(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "resolved";
  } catch (error) {
    if (error instanceof AccessError) return "AccessError";
    if (error instanceof ReactionError) return error.code;
    return (error as { code?: string }).code ?? String(error);
  }
}

const owner = `${RUN}-owner`;
const commenter = `${RUN}-commenter`;
const viewer = `${RUN}-viewer`;
const outsider = `${RUN}-outsider`;
const people = [owner, commenter, viewer, outsider];
const workspaceId = `${RUN}-ws`;

try {
  for (const id of people) await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  for (const id of people) await db.insert(workspaceMember).values({ workspaceId, userId: id, role: id === owner ? "owner" : "member" });
  const actor = { userId: owner };
  const ctx = { userId: owner, actor };

  // A private database of the owner's, shared with one person to comment and one to view.
  const news = await createPage(actor, { workspaceId, kind: "database", title: "News", teamspaceId: null });
  await setPagePermission(owner, news.id, commenter, "comment");
  await setPagePermission(owner, news.id, viewer, "view");
  const first = await createPage(actor, { workspaceId, parentId: news.id, title: "First", markdown: "Hello **team**.\n\nSecond paragraph." });
  await new Promise((r) => setTimeout(r, 20));
  const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} ${"word ".repeat(30)}`).join("\n\n");
  const second = await createPage(actor, { workspaceId, parentId: news.id, title: "Second", markdown: long });

  // Feed views: newest first, through the shared operations.
  const feed = await addView(owner, news.id, { name: "Feed", type: "feed" });
  check(feed.type === "feed", "a feed view is added", feed);
  const listed = await queryDatabase(ctx, { database_id: news.id, view_id: feed.id, limit: 50 });
  check(listed.rows.map((r) => r.title).join() === "Second,First", "a feed lists the newest post first", listed.rows.map((r) => r.title));

  // Posts: an excerpt with "show more" when the body goes on, and the author.
  const posts = await feedPosts(owner, news.id, [first.id, second.id]);
  const [p1, p2] = posts.posts;
  check(p1.excerpt.includes("Hello **team**.") && !p1.more, "a short body shows whole", p1);
  check(p2.more && p2.excerpt.length < long.length, "a long body shows its start, with more to come", { more: p2.more, length: p2.excerpt.length });
  check(p1.authorId === owner && posts.people.some((p) => p.id === owner), "a post names its author", { author: p1.authorId, people: posts.people });
  const body = await feedBody(owner, second.id);
  check(body.markdown.includes("Paragraph 12") && !body.cut, "show more reads the whole body", body.cut);

  // Reactions follow page access.
  const viewerReacts = await failure(() => setReaction(viewer, first.id, "👍", true));
  check(viewerReacts === "AccessError", "a viewer can't react", { viewerReacts, level: (await resolvePageAccess(viewer, first.id)).level });
  check((await failure(() => setReaction(outsider, first.id, "👍", true))) === "AccessError", "someone without access can't react");
  const afterCommenter = await setReaction(commenter, first.id, "👍", true);
  check(afterCommenter[0]?.emoji === "👍" && afterCommenter[0].count === 1 && afterCommenter[0].mine, "a commenter reacts", afterCommenter);
  await setReaction(owner, first.id, "👍", true);
  await setReaction(owner, first.id, "👍", true);
  const both = (await listReactions(viewer, [first.id]))[first.id];
  check(both?.[0]?.count === 2 && !both[0].mine, "reacting twice counts once, and viewers see the count", both);
  check(Object.keys(await listReactions(outsider, [first.id])).length === 0, "someone without access sees no reactions");
  check((await failure(() => setReaction(commenter, first.id, "ok", true))) === "invalidEmoji", "a reaction is one emoji");
  await setReaction(commenter, first.id, "👍", false);
  const taken = (await listReactions(owner, [first.id]))[first.id];
  check(taken?.[0]?.count === 1 && taken[0].mine, "a reaction is taken back", taken);

  // Comments show under their post; outsiders get nothing.
  await changeComments(commenter, first.id, { type: "createThread", body: [{ type: "paragraph", content: "Nice" }] } as never);
  const withComment = (await feedPosts(viewer, news.id, [first.id])).posts[0];
  check(withComment.threads[0]?.comments[0]?.userId === commenter, "a post shows its row's comments", withComment.threads);
  check((await failure(() => feedPosts(outsider, news.id, [first.id]))) === "AccessError", "posts of a database one can't open are refused");

  // Database tabs: a dashboard laid out as tabs, kept as tabs when the page's Markdown is rewritten.
  const host = await createPage(actor, { workspaceId, title: "Overview" });
  const blockId = crypto.randomUUID();
  const tabs = serializeDashboard([newTab("t1", news.id), { ...newTab("t2", news.id), title: "Posts", view: { type: "feed", config: {} } }]);
  await getCollab().appendBlocks(host.id, [{ id: blockId, type: DASHBOARD_BLOCK, props: { widgets: tabs, layout: "tabs" } }], actor);
  await getCollab().replaceContent(host.id, `Intro\n\n${dashboardLine(blockId)}`, actor);
  const [found] = await dashboardsOutput(owner, (await getCollab().readBlocks(host.id)).blocks);
  check(found?.layout === "tabs" && found.widgets.length === 2, "tabs stay tabs when the page's Markdown is rewritten", found);
  const [seen] = await dashboardsOutput(outsider, (await getCollab().readBlocks(host.id)).blocks);
  check(seen.widgets.every((w) => w.accessible === false && !("database_title" in w)), "a tab's database stays private to those who can't open it", seen);

  // Row page layout: full access only, a few pins at most.
  for (const prop of await getProperties(news.id)) await deleteProperty(owner, prop.id);
  const props: { id: string }[] = [];
  for (let i = 0; i <= MAX_PINNED; i++) props.push(await addProperty(owner, news.id, { name: `P${i}`, type: "text" }));
  await setPagePermission(owner, news.id, commenter, "edit");
  check((await failure(() => setPropertyPinned(commenter, props[0].id, true))) === "AccessError", "pinning takes full access");
  check((await failure(() => setPropertiesBeside(commenter, news.id, true))) === "AccessError", "moving properties beside the body takes full access");
  for (const prop of props.slice(0, MAX_PINNED)) await setPropertyPinned(owner, prop.id, true);
  check((await failure(() => setPropertyPinned(owner, props[MAX_PINNED].id, true))) === "tooManyPinned", `no more than ${MAX_PINNED} properties are pinned`);
  await setPropertiesBeside(owner, news.id, true);
  const row = await getRow(viewer, first.id);
  check(row.propertiesBeside === true, "everyone's row pages show the properties beside the body", row.propertiesBeside);
  check(row.properties.filter((p) => p.options.pinned).length === MAX_PINNED, "everyone's row pages pin the same properties");
  await setPropertyPinned(owner, props[0].id, false);
  await setPropertyPinned(owner, props[MAX_PINNED].id, true);
  check((await getProperties(news.id)).filter((p) => p.options.pinned).length === MAX_PINNED, "an unpinned property makes room for another");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(page).where(eq(page.workspaceId, workspaceId));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, people));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
