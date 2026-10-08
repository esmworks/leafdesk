/**
 * End-to-end check of page backgrounds against the database: colors and images set and removed,
 * an uploaded image counted as a file the page uses (the trigger from drizzle/0044), files of
 * other workspaces refused, copies keeping the background, and the same over MCP.
 * Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/page-background-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, fileReference, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { createPage, setPageBackground } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { AccessError } = await import("@/server/access");

const RUN = `page-background-e2e-${Date.now().toString(36)}`;

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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "page-background-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = { owner: `${RUN}-owner` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspaceId = `${RUN}-other`;
/** File ids are 24 characters of [A-Za-z0-9_-]. */
const fileId = (n: number) => `${RUN.replace(/[^A-Za-z0-9]/g, "").slice(-20)}bg0${n}`.slice(-24).padStart(24, "x");

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspaceId, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId: otherWorkspaceId, userId: ids.owner, role: "owner" },
  ]);
  const actor = { userId: ids.owner };
  const notes = await createPage(actor, { workspaceId, kind: "page", title: "Notes" });
  const [mine, theirs] = [fileId(1), fileId(2)];
  await db.insert(file).values([
    { id: mine, workspaceId, pageId: notes.id, storageKey: `${RUN}/1`, name: "a.png", contentType: "image/png", size: 1, uploadedBy: ids.owner },
    { id: theirs, workspaceId: otherWorkspaceId, storageKey: `${RUN}/2`, name: "b.png", contentType: "image/png", size: 1, uploadedBy: ids.owner },
  ]);
  const stored = async (id: string) => (await db.select({ background: page.background }).from(page).where(eq(page.id, id)))[0].background;
  const references = async (id: string) =>
    (await db.select({ fileId: fileReference.fileId }).from(fileReference).where(eq(fileReference.pageId, id))).map((r) => r.fileId);

  await setPageBackground(ids.owner, notes.id, { kind: "color", color: "green" });
  check((await stored(notes.id) as { color?: string })?.color === "green", "a color background is kept");

  await setPageBackground(ids.owner, notes.id, { kind: "image", url: `/api/files/${mine}` });
  check((await references(notes.id)).includes(mine), "an uploaded image background counts as a file the page uses");
  const [used] = await db.select({ referencedAt: file.referencedAt }).from(file).where(eq(file.id, mine));
  check(used.referencedAt !== null, "…so the cleanup keeps it");

  let refused = false;
  try {
    await setPageBackground(ids.owner, notes.id, { kind: "image", url: `/api/files/${theirs}` });
  } catch (error) {
    refused = error instanceof AccessError;
  }
  check(refused && (await references(notes.id)).includes(mine), "a file of another workspace is refused");

  const copy = await duplicatePage(actor, notes.id, " (copy)");
  check(
    (await stored(copy.id))?.kind === "image" && (await stored(copy.id) as { url?: string })?.url === `/api/files/${mine}` &&
      (await references(copy.id)).includes(mine),
    "a copy keeps the background, and its image counts for the copy too",
    { background: await stored(copy.id), references: await references(copy.id) },
  );

  await setPageBackground(ids.owner, notes.id, null);
  check((await stored(notes.id)) === null && !(await references(notes.id)).includes(mine), "removing it clears the file's use by the page");

  // MCP
  const set = await callTool(ids.owner, "update_page", { page_id: notes.id, background: "color:purple" });
  check(set.data?.changed?.includes("background"), "update_page sets a background", set);
  const read = await callTool(ids.owner, "get_page", { page_id: notes.id });
  check(read.data?.background === "color:purple", "get_page shows it as one string", read.data);
  const image = await callTool(ids.owner, "update_page", { page_id: notes.id, background: `/api/files/${mine}` });
  const readImage = await callTool(ids.owner, "get_page", { page_id: notes.id });
  check(
    !image.isError && typeof readImage.data?.background === "string" && readImage.data.background.endsWith(`/api/files/${mine}`) && readImage.data.background.startsWith("http"),
    "an uploaded image shows as its full URL",
    readImage.data?.background,
  );
  const wrong = await callTool(ids.owner, "update_page", { page_id: notes.id, background: "gradient:forest" });
  check(wrong.isError && wrong.text.includes("color:"), "gradients are no longer taken", wrong.text);
  const cleared = await callTool(ids.owner, "update_page", { page_id: notes.id, background: null });
  check(!cleared.isError && (await stored(notes.id)) === null, "null removes it");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(file).where(and(inArray(file.workspaceId, [workspaceId, otherWorkspaceId])));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
