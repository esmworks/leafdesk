/**
 * End-to-end check that a page save the database refuses reaches whoever wrote: createPage rejects
 * (and leaves the page without the body), the REST API answers 500 to creating and updating a page,
 * an MCP update_page is an error, open editors hear that the save failed and, after a later save
 * went through, that it is saved again. A temporary CHECK constraint on page.content_text makes
 * the saves fail; it is dropped afterwards, after which writes save as usual. Creates its own
 * users, workspace and OAuth client and deletes them afterwards.
 *
 *   pnpm tsx scripts/save-failure-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Use a scratch
 * database: while the script runs, any save of a body containing its marker fails there.
 */
import { API_TOKEN_SCOPES as ALL_SCOPES } from "@/lib/api-scopes";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { oauthClient, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { PAGE_SAVE_FAILED_EVENT, PAGE_SAVED_EVENT } = await import("@/lib/collab-constants");
const { isPageSaveFailed, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { createPage } = await import("@/server/pages");
const { createApiToken } = await import("@/server/api/tokens");
const { handleApiRequest } = await import("@/server/api");

const RUN = `save-failure-e2e-${Date.now().toString(36)}`;
// Saves of a body with this text fail while the constraint is there.
const MARKER = `UNSAVABLE${Date.now().toString(36)}`;
const CONSTRAINT = `save_failure_e2e_${Date.now().toString(36)}`;

// The real collab service, so writes are saved the way the editor, MCP and the API save them.
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

const clientId = `${RUN}-client`;

/** Calls an MCP tool as `userId` through the test OAuth client, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId, scopes: [READ_SCOPE, WRITE_SCOPE] });
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "save-failure-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  return { isError: Boolean(result.isError), text: result.content[0].text };
}

/** A REST API call, handled in this process as the app's /api/v1 route handles it. */
async function api(method: string, path: string, token: string, body: unknown) {
  const res = await handleApiRequest(
    new Request(`http://localhost/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function stored(pageId: string) {
  const [row] = await db
    .select({ text: page.contentText, markdown: page.contentMarkdown, ydoc: page.ydoc })
    .from(page)
    .where(eq(page.id, pageId));
  return row;
}

async function rejection(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

const owner = `${RUN}-owner`;
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: owner, role: "owner" });
  await db.insert(oauthClient).values({ id: clientId, clientId, name: "Test AI", redirectUris: [] });
  const { secret } = await createApiToken(owner, { name: "e2e write", scopes: ALL_SCOPES });

  // NOT VALID: only rows written from now on are checked, so the scan of existing pages is skipped.
  await db.execute(sql.raw(`ALTER TABLE page ADD CONSTRAINT ${CONSTRAINT} CHECK (content_text NOT LIKE '%${MARKER}%') NOT VALID`));

  // ------------------------------------------------------------------ createPage
  const fine = await createPage({ userId: owner }, { workspaceId, title: "Fine", markdown: "Saved as usual" });
  check((await stored(fine.id)).text.includes("Saved as usual"), "a body the constraint allows saves as usual");

  const createError = await rejection(() =>
    createPage({ userId: owner }, { workspaceId, title: "Refused", markdown: `Lost body ${MARKER}` }),
  );
  check(isPageSaveFailed(createError), "createPage rejects when the body can't be saved", String(createError));
  const cause = (createError as Error).cause;
  check(String(cause).includes(CONSTRAINT) || String((cause as { cause?: unknown })?.cause).includes(CONSTRAINT), "…with the database's refusal as its cause", String(cause));
  const [refused] = await db.select({ id: page.id }).from(page).where(eq(page.title, "Refused"));
  check(refused, "the page itself was created");
  const refusedRow = await stored(refused.id);
  check(refusedRow.text === "" && refusedRow.markdown === "" && refusedRow.ydoc === null, "…without the body", refusedRow);

  // ------------------------------------------------------------------ REST API
  const target = await createPage({ userId: owner }, { workspaceId, title: "Target", markdown: "Before" });
  const update = await api("PATCH", `/pages/${target.id}`, secret, { markdown: `After ${MARKER}`, mode: "replace" });
  check(update.status === 500 && update.body?.error?.code === "internal_error", "PATCH /pages answers 500 when the body can't be saved", update);
  check(/couldn't be saved/.test(update.body.error.message), "…saying the page couldn't be saved", update.body);
  check(!update.body.error.message.includes(CONSTRAINT), "…without the database's own message", update.body);
  const after = await stored(target.id);
  check(after.text.includes("Before") && !after.text.includes(MARKER), "the stored body is the one before", after.text);

  const created = await api("POST", "/pages", secret, { workspace_id: workspaceId, title: "Via API", markdown: `Body ${MARKER}` });
  check(created.status === 500 && created.body?.error?.code === "internal_error", "POST /pages answers 500 when the body can't be saved", created);

  // ------------------------------------------------------------------ MCP
  const tool = await callTool(owner, "update_page", { page_id: target.id, markdown: `From the app ${MARKER}` });
  check(tool.isError && /couldn't save the page/.test(tool.text), "MCP update_page is an error when the body can't be saved", tool);
  check(!(await stored(target.id)).text.includes(MARKER), "…and nothing of it is stored");

  // ------------------------------------------------------------------ open editors
  // A connection held open keeps the document loaded, as an editor's would; its events are recorded.
  const held = await hocuspocus.openDirectConnection(`page:${target.id}`, { userId: owner });
  const events: string[] = [];
  const document = held.document!;
  const broadcast = document.broadcastStateless.bind(document);
  document.broadcastStateless = (payload: string, ...rest: unknown[]) => {
    events.push(payload);
    return (broadcast as (...args: unknown[]) => unknown)(payload, ...rest);
  };
  try {
    const openError = await rejection(() => service.replaceContent(target.id, `While open ${MARKER}`, { userId: owner }));
    check(isPageSaveFailed(openError), "a write to an open page rejects when it can't be saved", String(openError));
    check(events.includes(PAGE_SAVE_FAILED_EVENT), "open editors hear that the save failed", events);
    check((await service.readPage(target.id)).markdown.includes(MARKER), "the open document still has the change", await service.readPage(target.id));

    await service.replaceContent(target.id, "Saved again", { userId: owner });
    check(events.at(-1) === PAGE_SAVED_EVENT, "…and that the page is saved once a later save went through", events);
    check((await stored(target.id)).text.includes("Saved again"), "the later save is stored");

    const count = events.length;
    await service.replaceContent(target.id, "Saved once more", { userId: owner });
    check(events.length === count, "saves that follow a good one send nothing", events);
  } finally {
    await held.disconnect();
  }

  // ------------------------------------------------------------------ after the constraint
  await db.execute(sql.raw(`ALTER TABLE page DROP CONSTRAINT ${CONSTRAINT}`));
  await service.replaceContent(refused.id, `Now saved ${MARKER}`, { userId: owner });
  check((await stored(refused.id)).text.includes(MARKER), "once the database takes it, the same body saves");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.execute(sql.raw(`ALTER TABLE page DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
  await db.delete(user).where(inArray(user.id, [owner]));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
