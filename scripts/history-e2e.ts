/**
 * End-to-end check of page history diffs against the database: an AI app's writes are saved as
 * versions named after the app, a version compares with the one before it and with the current
 * page (including edits still only in the open document), a restore leaves nothing to compare,
 * MCP get_page_history (compare) prints the same changes, and only people who can view the page can read
 * them. Creates its own users, workspace and OAuth client and deletes them afterwards.
 *
 *   pnpm tsx scripts/history-e2e.ts
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
const { oauthClient, user, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { serverEditor } = await import("@/server/blocknote");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { createPage, listSnapshots, restoreSnapshot } = await import("@/server/pages");
const { diffSnapshot } = await import("@/server/page-history");
const { AccessError } = await import("@/server/access");

const RUN = `history-e2e-${Date.now().toString(36)}`;

// The real collab service, so versions are saved the way MCP writes and the editor save them.
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "history-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
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
  await db.insert(oauthClient).values({ id: clientId, clientId, name: "Test AI", redirectUris: [] });

  const plan = await createPage({ userId: ids.owner }, { workspaceId, title: "Plan" });

  // Two AI writes: each saves the body before it as a version named after the app
  let r = await callTool(ids.owner, "update_page", {
    page_id: plan.id,
    markdown: "Intro\n\nThe quick fox jumps\n\nOld ending",
  });
  check(!r.isError, "the AI app writes the first body", r.text);
  await pause();
  r = await callTool(ids.owner, "update_page", {
    page_id: plan.id,
    title: "Plan v2",
    markdown: "Intro\n\nThe slow fox jumps\n\n* new item",
  });
  check(!r.isError, "…and rewrites it", r.text);
  await pause();

  const versions = await listSnapshots(ids.owner, plan.id);
  const mcpVersions = versions.filter((v) => v.reason === "before_mcp_write");
  check(mcpVersions.length === 2, "each AI write saved a version first", versions);
  check(
    mcpVersions.every((v) => v.clientName === "Test AI" && v.authorName === ids.owner),
    "the versions name the AI app and the person it acted for",
    versions,
  );
  const [second, first] = mcpVersions;

  // Compared with the previous version
  check((await diffSnapshot(ids.owner, first.id, "previous")) === null, "the oldest version has nothing to compare with");
  const grown = await diffSnapshot(ids.owner, second.id, "previous");
  check(
    grown !== null && grown.fromId === first.id && grown.toId === second.id,
    "the second version compares with the first",
    grown && { fromId: grown.fromId, toId: grown.toId },
  );
  check(
    grown.changes.filter((c) => c.op === "added").map((c) => c.block.text).join("|") === "Intro|The quick fox jumps|Old ending",
    "…showing the first write's blocks as added",
    grown.changes,
  );
  check(
    grown.actors.length === 1 && grown.actors[0].name === ids.owner && grown.actors[0].client === "Test AI",
    "…made by the AI app for the owner",
    grown.actors,
  );

  // Compared with the current page
  const now = await diffSnapshot(ids.owner, second.id, "current");
  check(now !== null && now.toId === null, "a version compares with the current page");
  const ops = now.changes.map((c) => `${c.op}:${c.block.type}:${c.block.text}`);
  check(
    ops.join("|") ===
      "same:paragraph:Intro|changed:paragraph:The slow fox jumps|removed:paragraph:Old ending|added:bulletListItem:new item",
    "…block by block",
    ops,
  );
  const edited = now.changes.find((c) => c.op === "changed");
  check(
    edited?.op === "changed" &&
      edited.words.filter((w) => w.op !== "eq").map((w) => `${w.op}:${w.text}`).join() === "del:quick,add:slow",
    "…with the changed words marked",
    edited,
  );
  check(now.title?.map((w) => `${w.op}:${w.text}`).join() === "eq:Plan,add: v2", "…and the title change", now.title);
  check(
    now.actors.length === 1 && now.actors[0].client === "Test AI",
    "…made by the AI app (its save is not counted as a separate edit)",
    now.actors,
  );

  // MCP prints the same diff
  r = await callTool(ids.owner, "get_page_history", { version_id: second.id, compare: "current" });
  check(!r.isError && r.data.changed === true, "MCP get_page_history compares with the current page", r.text);
  check(
    r.data.diff === "  Intro\n~ The [-quick-]{+slow+} fox jumps\n- Old ending\n+ * new item" &&
      r.data.changed_by.join() === `${ids.owner} via Test AI`,
    "…as text lines, naming the AI app",
    r.data,
  );

  // Edits still only in the open document count as the current page
  const conn = await hocuspocus.openDirectConnection(`page:${plan.id}`, { userId: ids.member });
  try {
    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
      const blocks = serverEditor.yXmlFragmentToBlocks(fragment);
      serverEditor.blocksToYXmlFragment([...blocks, { type: "paragraph", content: "Typed live" }] as any, fragment);
    });
    const live = await diffSnapshot(ids.owner, second.id, "current");
    check(
      live?.changes.at(-1)?.op === "added" && live.changes.at(-1)?.block.text === "Typed live",
      "an edit in the open document shows before it is saved",
      live?.changes.map((c) => `${c.op}:${c.block.text}`),
    );
  } finally {
    await conn.disconnect();
  }

  // Access: members who can view the page can compare, others can't
  check((await diffSnapshot(ids.member, second.id, "previous")) !== null, "a member who can view the page can compare versions");
  check(await rejectsAccess(() => diffSnapshot(ids.guest, second.id, "current")), "a guest without access can't");
  check(await rejectsAccess(() => diffSnapshot(ids.outsider, second.id, "previous")), "…nor can someone outside the workspace");
  check(await rejectsAccess(() => diffSnapshot(ids.owner, `${RUN}-missing`, "current")), "an unknown version is refused");
  const denied = await callTool(ids.outsider, "get_page_history", { version_id: second.id, compare: "current" });
  check(denied.isError, "MCP refuses the diff to someone without access", denied.text);

  // After restoring a version, it matches the current page
  await pause();
  await restoreSnapshot({ userId: ids.owner }, second.id);
  const restored = await diffSnapshot(ids.owner, second.id, "current");
  check(
    restored !== null && restored.title === null && restored.changes.every((c) => c.op === "same"),
    "a restored version has no changes against the current page",
    restored?.changes.map((c) => `${c.op}:${c.block.text}`),
  );
  const latest = (await listSnapshots(ids.owner, plan.id))[0];
  check(latest.reason === "before_restore", "restoring saved the page first", latest);
  const undo = await diffSnapshot(ids.owner, latest.id, "previous");
  check(
    undo !== null && undo.changes.some((c) => c.op === "added" && c.block.text === "Typed live"),
    "the version saved before the restore holds the live edit",
    undo?.changes.map((c) => `${c.op}:${c.block.text}`),
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
