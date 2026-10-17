/**
 * End-to-end check of synced pages: what the block may show each reader of the page it shows (per
 * reader, not per host page), the Markdown line written and read by MCP (update_page keeps the
 * block), the host page's stored Markdown and search holding none of the shown page's text,
 * backlinks, and published pages showing a link line, never the shown page's body.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/synced-page-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { SYNCED_PAGE_BLOCK } = await import("@/lib/mentions");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, setPageLocked } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { listBacklinks, syncedPageInfo } = await import("@/server/mentions");
const { getPublishedPage, publishPage } = await import("@/server/publication");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");

const RUN = `synced-e2e-${Date.now().toString(36)}`;

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

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>, scopes = [READ_SCOPE, WRITE_SCOPE]) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes });
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synced-page-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

/** The synced page blocks of a page's body, as stored: the pages they show. */
async function syncedIn(pageId: string) {
  const { blocks } = await getCollab().readBlocks(pageId);
  return (blocks as { type: string; props?: { pageId?: string } }[]).filter((b) => b.type === SYNCED_PAGE_BLOCK).map((b) => b.props?.pageId);
}

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor`, viewer: `${RUN}-viewer`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const line = (pageId: string, text = "page") => `[${text}](/w/${workspaceId}/p/${pageId}) <!-- leafdesk:synced-page -->`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  const owner = { userId: ids.owner };
  const source = await createPage(owner, { workspaceId, title: "Team rules", markdown: "Be kind to each other.\n\nShip small changes." });
  const host = await createPage(owner, { workspaceId, title: "Weekly notes", markdown: `Intro.\n\n${line(source.id, "Whatever")}\n\nOutro.` });
  // The source: the owner full, the editor edit, the viewer view, the rest of the workspace nothing.
  await setPagePermission(ids.owner, source.id, ids.owner, "full");
  await setPagePermission(ids.owner, source.id, null, "none");
  await setPagePermission(ids.owner, source.id, ids.editor, "edit");
  await setPagePermission(ids.owner, source.id, ids.viewer, "view");

  // The block, from Markdown
  check(JSON.stringify(await syncedIn(host.id)) === JSON.stringify([source.id]), "a synced-page line in Markdown becomes the block", await syncedIn(host.id));

  // Access, per reader of the shown page
  const asOwner = await syncedPageInfo(ids.owner, source.id);
  check(asOwner.status === "ok" && asOwner.level === "full" && asOwner.editable && asOwner.title === "Team rules", "the owner may edit the shown page", asOwner);
  const asEditor = await syncedPageInfo(ids.editor, source.id);
  check(asEditor.status === "ok" && asEditor.editable, "someone with edit access to it may edit it in place", asEditor);
  const asViewer = await syncedPageInfo(ids.viewer, source.id);
  check(asViewer.status === "ok" && asViewer.level === "view" && !asViewer.editable, "someone who may only view it reads it", asViewer);
  await setPagePermission(ids.owner, source.id, ids.viewer, "none");
  const asNobody = await syncedPageInfo(ids.viewer, source.id);
  check(asNobody.status === "noAccess" && Object.keys(asNobody).sort().join() === "id,status", "without access: \"No access\", and nothing about the page", asNobody);
  const fromOutside = await syncedPageInfo(ids.outsider, source.id);
  check(fromOutside.status === "noAccess", "…the same for someone outside the workspace", fromOutside);
  const hostForViewer = await syncedPageInfo(ids.viewer, host.id);
  check(hostForViewer.status === "ok", "…however much of the page showing it they may see", hostForViewer);
  check((await syncedPageInfo(ids.viewer, "no-such-page")).status === "deleted", "a page that isn't there reads as deleted");

  await setPageLocked(ids.owner, source.id, true);
  const locked = await syncedPageInfo(ids.editor, source.id);
  check(locked.status === "ok" && !locked.editable, "a locked page opens read-only, even for its editors", locked);
  await setPageLocked(ids.owner, source.id, false);

  const database = await createPage(owner, { workspaceId, title: "Tasks", kind: "database" });
  const asDatabase = await syncedPageInfo(ids.owner, database.id);
  check(asDatabase.status === "ok" && asDatabase.kind === "database", "a database is told apart (the block reads as a link to it)", asDatabase);

  // The host page's own text, search and links
  const [hostRow] = await db.select({ markdown: page.contentMarkdown }).from(page).where(eq(page.id, host.id));
  check(
    hostRow.markdown === `Intro.\n\n${line(source.id)}\n\nOutro.`,
    "the host page's stored Markdown holds the line, not the shown page's text",
    hostRow.markdown,
  );
  const [hits] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${page} where ${page.workspaceId} = ${workspaceId} and ${page.contentMarkdown} ilike ${"%Be kind to each other%"}`,
  );
  check(Number(hits.n) === 1, "the shown page's text is in one page's index: its own", hits);
  check((await listBacklinks(ids.owner, source.id)).some((b) => b.id === host.id), "the shown page lists the host page among the pages linking to it");

  // MCP: reading and writing the host page keeps the block
  let r = await callTool(ids.owner, "get_page", { page_id: host.id }, [READ_SCOPE]);
  check(!r.isError && r.data.markdown.includes(line(source.id, "Team rules")), "get_page shows the block's line with the page's title", r.data?.markdown);
  check(!r.data.markdown.includes("Be kind"), "…and not the page's text", r.data.markdown);
  r = await callTool(ids.viewer, "get_page", { page_id: host.id }, [READ_SCOPE]);
  check(!r.isError && r.data.markdown.includes(line(source.id, "No access")) && !r.text.includes("Team rules"), "…as \"No access\" to someone who can't open it", r.data?.markdown);
  const read = (await callTool(ids.owner, "get_page", { page_id: host.id }, [READ_SCOPE])).data.markdown as string;
  r = await callTool(ids.owner, "update_page", { page_id: host.id, markdown: `${read}\n\nOne more line.` });
  check(!r.isError, "update_page takes the Markdown get_page gave", r.text);
  check(JSON.stringify(await syncedIn(host.id)) === JSON.stringify([source.id]), "…and the synced page stays", await syncedIn(host.id));
  r = await callTool(ids.owner, "update_page", { page_id: host.id, markdown: line(host.id), mode: "append" });
  check(!r.isError && (await syncedIn(host.id)).includes(host.id), "a page may be written to show itself: the editor guards it when showing it", r.text);

  // Published pages: a link line, never the shown page's body
  const published = await publishPage(ids.owner, host.id);
  const view = await getPublishedPage(published.token);
  const html = view?.body.map((b) => (b.kind === "html" ? b.html : "")).join("") ?? "";
  check(html.includes("Team rules") && html.includes("Intro.") && !html.includes("Be kind"), "a published page shows the synced page as its title, not its text", html);
  check(!html.includes(`/w/${workspaceId}`), "…without an address into the workspace", html);

  // The trash
  await archivePage(ids.owner, source.id);
  check((await syncedPageInfo(ids.owner, source.id)).status === "deleted", "a page in the trash reads as deleted");

  console.log(`\n${passed} checks passed`);
} finally {
  hocuspocus.closeConnections();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

process.exit(0);
