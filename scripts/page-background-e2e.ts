/**
 * End-to-end check of page backgrounds against the database: colors set and removed, images
 * refused (a background never loads one), copies keeping the color, and the same over MCP.
 * Creates its own user and workspace and deletes them afterwards.
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
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { createPage, setPageBackground } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");

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

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: ids.owner, role: "owner" });
  const actor = { userId: ids.owner };
  const notes = await createPage(actor, { workspaceId, kind: "page", title: "Notes" });
  const stored = async (id: string) => (await db.select({ background: page.background }).from(page).where(eq(page.id, id)))[0].background;

  await setPageBackground(ids.owner, notes.id, { kind: "color", color: "green" });
  check((await stored(notes.id))?.color === "green", "a color background is kept");

  let refused = false;
  try {
    // Images aren't backgrounds any more, whatever a caller sends.
    await setPageBackground(ids.owner, notes.id, { kind: "image", url: "https://images.example/a.jpg" } as never);
  } catch {
    refused = true;
  }
  check(refused && (await stored(notes.id))?.color === "green", "an image is refused and the color stays");

  const copy = await duplicatePage(actor, notes.id, " (copy)");
  check((await stored(copy.id))?.color === "green", "a copy keeps the background", await stored(copy.id));

  await setPageBackground(ids.owner, notes.id, null);
  check((await stored(notes.id)) === null, "null removes it");

  // MCP
  const set = await callTool(ids.owner, "update_page", { page_id: notes.id, background: "color:purple" });
  check(set.data?.changed?.includes("background"), "update_page sets a background", set);
  const read = await callTool(ids.owner, "get_page", { page_id: notes.id });
  check(read.data?.background === "color:purple", "get_page shows it as one string", read.data);
  for (const wrong of ["https://images.example/a.jpg", "/api/files/AbCdEfGhIjKlMnOpQrStUvWx", "gradient:forest"]) {
    const answer = await callTool(ids.owner, "update_page", { page_id: notes.id, background: wrong });
    check(answer.isError && answer.text.includes("color:"), `update_page refuses ${wrong}`, answer.text);
  }
  check((await stored(notes.id))?.color === "purple", "…and keeps the color it had");
  const cleared = await callTool(ids.owner, "update_page", { page_id: notes.id, background: null });
  check(!cleared.isError && (await stored(notes.id)) === null, "null removes it over MCP too");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
