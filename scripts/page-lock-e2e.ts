/**
 * End-to-end check of locked pages against the database: while a page (or a database row) is
 * locked, every server-side write of its title, icon, background and body is refused (the server
 * functions behind the app's actions, the collab service's own writes, MCP tools, the REST API and
 * the AI writing assistant) and its live connections open read-only; comments, sharing, moving it
 * to the trash and back, a row's property values and duplicating it stay open, and unlocking
 * brings the writes back. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/page-lock-e2e.ts
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
const { apiToken, file, page, pageSnapshot, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { env } = await import("@/lib/env");
const { AccessError } = await import("@/server/access");
const { AiError } = await import("@/server/ai");
const { snapshotBeforeAiEdit } = await import("@/server/ai-writing");
const { handleApiRequest } = await import("@/server/api");
const { createApiToken } = await import("@/server/api/tokens");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { authorizeCollab } = await import("@/server/collab/authorize");
const { createCollab } = await import("@/server/collab/service");
const { changeComments, listComments } = await import("@/server/comments");
const { duplicatePage } = await import("@/server/duplicate");
const { createMcpServer } = await import("@/server/mcp/tools");
const { FILES_SCOPE, READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const pages = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");

const RUN = `page-lock-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

/** Why `fn` failed: "locked" for a locked page, "access", the AI error's code, or null when it didn't. */
async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if ((error as { code?: unknown }).code === "pageLocked") return "locked";
    if (error instanceof AiError) return `ai:${error.code}`;
    if (error instanceof AccessError) return "access";
    throw error;
  }
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "page-lock-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

/** Calls the REST API in this process, with a token of the owner. */
async function rest(token: string, method: string, path: string, body?: unknown) {
  const res = await handleApiRequest(
    new Request(`${env.appUrl}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
}

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor`, viewer: `${RUN}-viewer` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
  ]);
  const owner = { userId: ids.owner };
  const collab = getCollab();
  const notes = await pages.createPage(owner, { workspaceId, title: "Notes", icon: "📝", markdown: "Keep this text." });
  // Members only view; the owner keeps full access and one member may edit.
  await setPagePermission(ids.owner, notes.id, ids.owner, "full");
  await setPagePermission(ids.owner, notes.id, null, "view");
  await setPagePermission(ids.owner, notes.id, ids.editor, "edit");
  await collab.snapshot(notes.id, "manual", owner);
  const [version] = await db.select({ id: pageSnapshot.id }).from(pageSnapshot).where(eq(pageSnapshot.pageId, notes.id));
  const stored = async (id: string) =>
    (await db.select({ title: page.title, icon: page.icon, background: page.background, lockedAt: page.lockedAt }).from(page).where(eq(page.id, id)))[0];
  const body = async (id: string) => (await collab.readPage(id)).markdown;

  // Who may lock
  check((await failure(() => pages.setPageLocked(ids.viewer, notes.id, true))) === "access", "people who can only view can't lock a page");
  await pages.setPageLocked(ids.editor, notes.id, true);
  check((await stored(notes.id)).lockedAt !== null, "anyone who can edit it locks it");
  check((await authorizeCollab(ids.owner, { kind: "page", id: notes.id })).readOnly, "its live connections open read-only, full access included");

  // The app's own writes
  check((await failure(() => pages.renamePage(owner, notes.id, "Renamed"))) === "locked", "renaming is refused");
  check((await failure(() => pages.setPageIcon(ids.owner, notes.id, "🔥"))) === "locked", "changing the icon is refused");
  check(
    (await failure(() => pages.setPageBackground(ids.owner, notes.id, { color: "green", pattern: null }))) === "locked",
    "changing the background is refused",
  );
  check((await failure(() => pages.restoreSnapshot(owner, version.id))) === "locked", "restoring a version is refused");
  const kept = await stored(notes.id);
  check(kept.title === "Notes" && kept.icon === "📝" && kept.background === null, "title, icon and background stay", kept);

  // The collab service's own writes (MCP, the REST API, agents and imports go through these)
  check((await failure(() => collab.replaceContent(notes.id, "Gone", owner, true))) === "locked", "replacing the body is refused");
  check((await failure(() => collab.appendContent(notes.id, "More", owner))) === "locked", "appending to it is refused");
  check(
    (await failure(() => collab.appendBlocks(notes.id, [{ type: "paragraph", content: "x" }], owner))) === "locked",
    "adding blocks is refused",
  );
  check((await failure(() => collab.setTitle(notes.id, "Renamed", owner))) === "locked", "writing the title into the document is refused");
  check((await body(notes.id)) === "Keep this text.", "the body stays", await body(notes.id));
  check(
    (await failure(() => snapshotBeforeAiEdit(ids.owner, notes.id))) === "ai:noAccess",
    "the AI writing assistant is refused before it starts",
  );

  // MCP
  const update = await callTool(ids.owner, "update_page", { page_id: notes.id, title: "Renamed", markdown: "Gone" });
  check(update.isError && /locked/.test(update.text) && /unlock/.test(update.text), "update_page refuses with a clear message", update.text);
  const attach = await callTool(
    ids.owner,
    "attach_file",
    { page_id: notes.id, base64: Buffer.from("hello").toString("base64"), name: "hello.txt" },
    [READ_SCOPE, WRITE_SCOPE, FILES_SCOPE],
  );
  check(attach.isError && /locked/.test(attach.text), "attach_file refuses to add to the body", attach.text);
  check((await db.select({ id: file.id }).from(file).where(eq(file.pageId, notes.id))).length === 0, "…and leaves no upload behind");
  const restore = await callTool(ids.owner, "restore_page_version", { version_id: version.id });
  check(restore.isError && /locked/.test(restore.text), "restore_page_version refuses", restore.text);
  const read = await callTool(ids.owner, "get_page", { page_id: notes.id });
  check(read.data?.locked === true, "get_page says it is locked", read.data);

  // REST
  const { secret } = await createApiToken(ids.owner, { name: RUN, scopes: ["pages:read", "pages:write"] });
  const patched = await rest(secret, "PATCH", `/pages/${notes.id}`, { title: "Renamed", icon: "🔥" });
  check(
    patched.status === 400 && patched.body?.error?.code === "invalid_request" && /locked/.test(patched.body.error.message),
    "PATCH /pages/{id} refuses with a clear message",
    patched,
  );
  const got = await rest(secret, "GET", `/pages/${notes.id}`);
  check(got.status === 200 && got.body.locked === true, "GET /pages/{id} says it is locked", got);
  check((await stored(notes.id)).title === "Notes", "nothing of the refused calls was written");

  // What stays open
  const thread = await changeComments(ids.owner, notes.id, { type: "createThread", body: "Still open for comments", anchor: { quote: "Keep" } });
  check(thread.anchored === true && (await listComments(ids.owner, notes.id)).length === 1, "comments can be added, anchored to its text");
  await setPagePermission(ids.owner, notes.id, ids.viewer, "comment");
  await changeComments(ids.viewer, notes.id, { type: "addComment", threadId: thread.thread!.id, body: "Thanks" });
  check((await listComments(ids.owner, notes.id))[0].comments.length === 2, "it can be shared: someone it was just shared with replies");
  await pages.archivePage(ids.owner, notes.id);
  await pages.restorePage(ids.owner, notes.id);
  check((await stored(notes.id)).lockedAt !== null, "it can go to the trash and back, still locked");
  const child = await pages.createPage(owner, { workspaceId, parentId: notes.id, title: "Child" });
  check(Boolean(child.id), "sub-pages can be added under it");
  const copy = await duplicatePage(owner, notes.id, " (copy)");
  check((await stored(copy.id)).lockedAt === null, "a copy starts unlocked");
  await pages.renamePage(owner, copy.id, "Copy renamed");
  check((await collab.readPage(copy.id)).title === "Copy renamed", "…and can be edited");

  // A database row
  const tasks = await pages.createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  const row = await pages.createPage(owner, { workspaceId, parentId: tasks.id, title: "Write the docs" });
  await pages.setPageLocked(ids.owner, row.id, true);
  const values = await callTool(ids.owner, "update_database_row", { row_id: row.id, properties: { Status: "Done" } });
  check(!values.isError && values.data?.properties?.Status === "Done", "a locked row's properties stay editable", values.text);
  const retitle = await callTool(ids.owner, "update_database_row", { row_id: row.id, title: "Renamed", properties: { Status: "In progress" } });
  check(retitle.isError && /locked/.test(retitle.text), "renaming it is refused, the whole call", retitle.text);
  const after = await callTool(ids.owner, "get_page", { page_id: row.id });
  check(after.data?.properties?.Status === "Done" && after.data?.title === "Write the docs", "…so its values didn't change either", after.data);
  let refused = false;
  try {
    await pages.setPageLocked(ids.owner, tasks.id, true);
  } catch {
    refused = true;
  }
  check(refused && (await stored(tasks.id)).lockedAt === null, "a database isn't locked this way (its menu locks its schema)");

  // A database's lock means its schema: its own title stays editable
  await db.update(page).set({ lockedAt: new Date() }).where(eq(page.id, tasks.id));
  check(!(await authorizeCollab(ids.owner, { kind: "page", id: tasks.id })).readOnly, "a locked database's document stays writable");
  await pages.renamePage(owner, tasks.id, "Tasks renamed");
  check((await collab.readPage(tasks.id)).title === "Tasks renamed", "…and it can be renamed");

  // Unlocking
  await pages.setPageLocked(ids.editor, notes.id, false);
  check((await stored(notes.id)).lockedAt === null, "anyone who can edit it unlocks it");
  check(!(await authorizeCollab(ids.owner, { kind: "page", id: notes.id })).readOnly, "its connections open writable again");
  await pages.renamePage(owner, notes.id, "Notes again");
  await collab.appendContent(notes.id, "Added after the unlock.", owner);
  const reopened = await collab.readPage(notes.id);
  check(reopened.title === "Notes again" && reopened.markdown.includes("Added after the unlock."), "writes work again", reopened);
  const unlocked = await callTool(ids.owner, "update_page", { page_id: notes.id, background: "color:green" });
  check(!unlocked.isError, "and so does MCP", unlocked.text);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(apiToken).where(inArray(apiToken.userId, userIds));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
