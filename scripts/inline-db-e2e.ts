/**
 * End-to-end check of databases inside page bodies against the database: creating an inline
 * database under a page (what the editor's "Database" slash command calls), its access following
 * the page until the database is restricted on its own, linked views of restricted databases
 * showing nothing (block info, MCP, published pages), trash and restore taking inline databases
 * along, duplicates pointing at copied inline databases but not moving linked views, and MCP
 * reading the blocks and keeping them through a rewrite.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/inline-db-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { referenceLine, serializeLinkedView } = await import("@/lib/embed-blocks");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { serverEditor } = await import("@/server/blocknote");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { createRows, getDatabaseSnapshot } = await import("@/server/databases");
const { duplicatePage } = await import("@/server/duplicate");
const { createInlineDatabase, getEmbedInfo, resolveEmbeds } = await import("@/server/embeds");
const { getPublishedPage, publishPage } = await import("@/server/publication");
const { archivePage, createPage, ENGLISH_SEED_NAMES, getPage, getTree, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { AccessError } = await import("@/server/access");

const RUN = `inline-db-e2e-${Date.now().toString(36)}`;

// The real collab service, so page bodies are stored the way the editor stores them.
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

async function rejectsAccess(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof AccessError;
  }
}

async function rejects(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

/** Calls an MCP tool as `userId` with read and write access, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE, WRITE_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "inline-db-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

/** Writes blocks into a page's live document, the way the editor does (e.g. a linked view's settings). */
async function writeBlocks(pageId: string, userId: string, blocks: unknown[]) {
  const conn = await hocuspocus.openDirectConnection(`page:${pageId}`, { userId });
  try {
    await conn.transact((doc) => {
      serverEditor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(COLLAB_FRAGMENT));
    });
  } finally {
    await conn.disconnect();
  }
}

/** The blocks stored for a page (its saved Yjs document). */
async function storedBlocks(pageId: string) {
  const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId));
  const doc = new Y.Doc();
  if (row?.ydoc) Y.applyUpdate(doc, row.ydoc);
  const blocks = serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
  doc.destroy();
  return blocks;
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const owner = { userId: ids.owner };

  // Creating an inline database: a database page under the page, like a subpage
  const host = await createPage(owner, { workspaceId, title: "Plan" });
  const inline = await createInlineDatabase(owner, host.id, ENGLISH_SEED_NAMES);
  const [stored] = await db.select().from(page).where(eq(page.id, inline.id));
  check(stored.kind === "database" && stored.parentId === host.id, "an inline database is a database under its page", stored);
  const snapshot = await getDatabaseSnapshot(ids.owner, inline.id);
  check(snapshot.views.length === 1 && snapshot.properties.length === 2, "it starts with a table view and starter properties", snapshot.views);
  const tree = await getTree(ids.owner, workspaceId);
  check(tree.find((n) => n.id === inline.id)?.parentId === host.id, "the sidebar lists it under its page");
  await db.update(page).set({ title: "Secret roadmap" }).where(eq(page.id, inline.id));
  await createRows(ids.owner, inline.id, [{ title: "Alpha row" }, { title: "Beta row" }]);
  check(await rejects(() => createInlineDatabase(owner, inline.id)), "a database can't hold an inline database");

  // Members get every page unless "everyone" is narrowed; then their own entry decides.
  await setPagePermission(ids.owner, host.id, ids.owner, "full");
  await setPagePermission(ids.owner, host.id, null, "none");
  await setPagePermission(ids.owner, host.id, ids.member, "view");
  check(await rejectsAccess(() => createInlineDatabase({ userId: ids.member }, host.id)), "viewers of a page can't add databases to it");
  await setPagePermission(ids.owner, host.id, ids.member, "edit");

  // The block in the page body: a title-free reference line
  await service.replaceContent(host.id, `Intro\n\n${referenceLine("database", inline.id)}\n\nOutro`, owner);
  const [body] = await db.select({ markdown: page.contentMarkdown, text: page.contentText }).from(page).where(eq(page.id, host.id));
  check(body.markdown.includes(`<!-- leafdesk:database ${inline.id} -->`), "the page's Markdown holds the database's reference line", body);
  check(!body.markdown.includes("Secret") && !body.text.includes("Secret"), "the page's Markdown and search text never name the database", body);
  check((await storedBlocks(host.id)).some((b) => b.type === "database" && b.props.databaseId === inline.id), "the reference is stored as a database block");

  // Access follows the page, until the database is restricted on its own
  const memberInfo = await getEmbedInfo(ids.member, inline.id);
  check(memberInfo.state === "ok" && memberInfo.level === "edit", "someone who may edit the page may edit its inline database", memberInfo);
  check((await getEmbedInfo(ids.guest, inline.id)).state === "unavailable", "a guest without the page sees nothing of its database");
  await setPagePermission(ids.owner, host.id, ids.guest, "view");
  const guestInfo = await getEmbedInfo(ids.guest, inline.id);
  check(guestInfo.state === "ok" && guestInfo.level === "view" && guestInfo.guest, "sharing the page shares its inline database", guestInfo);
  await setPagePermission(ids.owner, inline.id, ids.guest, "none");
  await getPage(ids.guest, host.id);
  check((await getEmbedInfo(ids.guest, inline.id)).state === "unavailable", "restricting the database hides it inside a page the guest can see");
  check(await rejectsAccess(() => getDatabaseSnapshot(ids.guest, inline.id)), "…and its rows");
  const [hidden] = await resolveEmbeds(ids.guest, [{ type: "database", databaseId: inline.id }]);
  check(hidden.database === null, "…and its title", hidden);
  const guestRead = await callTool(ids.guest, "get_page", { page_id: host.id });
  check(
    !guestRead.isError &&
      guestRead.data.embedded_databases?.[0]?.database_id === inline.id &&
      guestRead.data.embedded_databases[0].title === null &&
      guestRead.data.embedded_databases[0].accessible === false,
    "MCP get_page lists the block without naming a database the reader can't see",
    guestRead.text,
  );
  check(!/Secret|Alpha row|Beta row/.test(guestRead.text), "…nor its rows", guestRead.text);
  check((await getEmbedInfo(ids.guest, `${RUN}-missing`)).state === "unavailable", "a missing database reads the same as a hidden one");

  // Linked views: a view of a database kept in the block, never more than the reader may see
  const payroll = await createPage(owner, { workspaceId, kind: "database", title: "Payroll" });
  await createRows(ids.owner, payroll.id, [{ title: "Salary sheet" }]);
  await setPagePermission(ids.owner, payroll.id, ids.owner, "full");
  await setPagePermission(ids.owner, payroll.id, null, "none");
  const report = await createPage(owner, { workspaceId, title: "Report" });
  const sorted = serializeLinkedView({ type: "board", config: { sorts: [{ propertyId: "title", direction: "desc" }] } });
  await writeBlocks(report.id, ids.owner, [
    { type: "paragraph", content: "Numbers" },
    { type: "linkedView", props: { databaseId: payroll.id, view: sorted } },
    { type: "linkedView", props: { databaseId: inline.id, view: sorted } },
  ]);
  check((await getEmbedInfo(ids.member, payroll.id)).state === "unavailable", "a linked view of a restricted database shows nothing");
  const memberRead = await callTool(ids.member, "get_page", { page_id: report.id });
  check(
    !memberRead.isError && memberRead.data.embedded_databases.length === 2 && memberRead.data.embedded_databases[0].title === null,
    "MCP names only the linked databases the reader can see",
    memberRead.text,
  );
  check(!/Payroll|Salary/.test(memberRead.text), "…and nothing of the restricted one", memberRead.text);
  check(memberRead.data.embedded_databases[1].title === "Secret roadmap", "…while one they can see is named", memberRead.text);

  // Published pages: an inline database is published with its page; other databases are not
  const { token } = await publishPage(ids.owner, report.id);
  const publishedReport = await getPublishedPage(token);
  const reportEmbeds = publishedReport?.body.filter((b) => b.kind === "embed") ?? [];
  check(reportEmbeds.length === 2 && reportEmbeds.every((b) => b.kind === "embed" && b.database === null), "a published page shows no database it doesn't contain", reportEmbeds);
  check(!/Payroll|Salary|Secret|Alpha/.test(JSON.stringify(publishedReport)), "…and leaks nothing about them", publishedReport);

  await writeBlocks(host.id, ids.owner, [
    { type: "paragraph", content: "Intro" },
    { type: "database", props: { databaseId: inline.id } },
    { type: "linkedView", props: { databaseId: inline.id, view: sorted } },
    { type: "linkedView", props: { databaseId: payroll.id, view: "" } },
  ]);
  const { token: planToken } = await publishPage(ids.owner, host.id);
  const publishedPlan = await getPublishedPage(planToken);
  const [own, view, other] = (publishedPlan?.body ?? []).filter((b) => b.kind === "embed");
  const titles = (b: typeof own) => (b?.kind === "embed" ? (b.database?.table.rows.map((r) => r.title) ?? null) : null);
  check(own?.kind === "embed" && own.database?.id === inline.id, "a published page shows its inline database", own);
  check(JSON.stringify(titles(own)) === JSON.stringify(["Alpha row", "Beta row"]), "…with its rows as its first view orders them", titles(own));
  check(JSON.stringify(titles(view)) === JSON.stringify(["Beta row", "Alpha row"]), "a linked view of it is published with the view's own sorting", titles(view));
  check(other?.kind === "embed" && other.database === null && !/Payroll|Salary/.test(JSON.stringify(publishedPlan)), "a linked view of a database elsewhere stays unpublished", other);
  check(!publishedPlan?.children.some((c) => c.id === inline.id), "the inline database isn't listed again as a subpage", publishedPlan?.children);
  check((await getPublishedPage(planToken, inline.id))?.database?.rows.length === 2, "its own published page works like any published database");

  // Trash and restore take the inline database along with its page
  await archivePage(ids.owner, host.id);
  const [trashed] = await db.select({ archivedAt: page.archivedAt }).from(page).where(eq(page.id, inline.id));
  check(trashed.archivedAt !== null, "trashing the page trashes its inline database");
  const trashedInfo = await getEmbedInfo(ids.owner, inline.id);
  check(trashedInfo.state === "ok" && trashedInfo.archived, "blocks showing it say it is in the trash", trashedInfo);
  await restorePage(ids.owner, host.id);
  const [restored] = await db.select({ archivedAt: page.archivedAt }).from(page).where(eq(page.id, inline.id));
  check(restored.archivedAt === null, "restoring the page restores its inline database");

  // Duplicating the page copies its inline database; linked views keep their source
  const copy = await duplicatePage(owner, host.id);
  const [copiedDb] = await db.select({ id: page.id }).from(page).where(eq(page.parentId, copy.id));
  check(copiedDb && copiedDb.id !== inline.id, "the duplicate has its own copy of the inline database", copiedDb);
  const copyBlocks = await storedBlocks(copy.id);
  const copiedEmbeds = copyBlocks.filter((b) => b.type === "database" || b.type === "linkedView");
  check(
    copiedEmbeds[0]?.type === "database" && copiedEmbeds[0].props.databaseId === copiedDb.id,
    "the copied page's database block points at the copy",
    copiedEmbeds,
  );
  check(
    copiedEmbeds[1]?.type === "linkedView" && copiedEmbeds[1].props.databaseId === inline.id && copiedEmbeds[1].props.view === sorted,
    "its linked views still show their source, settings included",
    copiedEmbeds,
  );
  const [copyBody] = await db.select({ markdown: page.contentMarkdown }).from(page).where(eq(page.id, copy.id));
  check(
    copyBody.markdown.includes(`leafdesk:database ${copiedDb.id}`) && !copyBody.markdown.includes(`leafdesk:database ${inline.id}`),
    "…and its Markdown says so too",
    copyBody,
  );
  check((await getDatabaseSnapshot(ids.owner, copiedDb.id)).rows.length === 2, "the copied database has the rows");

  // MCP: reading the blocks and keeping them through a rewrite
  const read = await callTool(ids.owner, "get_page", { page_id: host.id });
  check(
    !read.isError &&
      read.data.markdown.includes(referenceLine("database", inline.id)) &&
      read.data.embedded_databases[0].kind === "inline_database" &&
      read.data.embedded_databases[0].title === "Secret roadmap",
    "MCP get_page shows the database block and names it for someone who can see it",
    read.text,
  );
  const rewrite = await callTool(ids.owner, "update_page", { page_id: host.id, markdown: "Rewritten from scratch" });
  check(!rewrite.isError, "MCP rewrites the page", rewrite.text);
  const afterRewrite = await storedBlocks(host.id);
  check(
    afterRewrite[0]?.type === "paragraph" && afterRewrite.some((b) => b.type === "database" && b.props.databaseId === inline.id),
    "a rewrite that leaves the inline database out keeps it on the page",
    afterRewrite.map((b) => b.type),
  );
  check(!afterRewrite.some((b) => b.type === "linkedView"), "…while linked views it leaves out are removed");
  const [kept] = await db.select({ archivedAt: page.archivedAt }).from(page).where(eq(page.id, inline.id));
  check(kept.archivedAt === null, "the database itself is untouched");

  await writeBlocks(report.id, ids.owner, [
    { type: "paragraph", content: "Numbers" },
    { type: "linkedView", props: { databaseId: inline.id, view: sorted } },
  ]);
  const moved = await callTool(ids.owner, "update_page", {
    page_id: report.id,
    markdown: `${referenceLine("linkedView", inline.id)}\n\nNumbers below`,
  });
  check(!moved.isError, "MCP moves a linked view", moved.text);
  const movedBlocks = await storedBlocks(report.id);
  check(
    movedBlocks[0]?.type === "linkedView" && movedBlocks[0].props.view === sorted,
    "a linked view named again keeps its own settings",
    movedBlocks,
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
