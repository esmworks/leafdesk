/**
 * End-to-end check of built-in icons against the database: a page's icon set over MCP as an emoji
 * or `icon:<name>:<color>` and read back as is, unknown names and colors refused; a callout's
 * built-in icon kept through Markdown and export; view and property icons set, validated and
 * removed; the icon picker's remembered skin tone and color; and a PDF of a page with built-in
 * icons drawn. Creates its own user and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/icons-e2e.ts
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
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { CALLOUT_BLOCK } = await import("@/lib/content-blocks");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { createPage, setPageIcon } = await import("@/server/pages");
const { addProperty, getDatabase, updateProperty, updateView } = await import("@/server/databases");
const { pageMarkdown } = await import("@/server/export");
const { pagePdf } = await import("@/server/pdf");
const { getIconPreferences, setIconPreferences, isIconColor, isSkinTone } = await import("@/server/icon-preferences");

const RUN = `icons-e2e-${Date.now().toString(36)}`;

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

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "icons-e2e", version: "1" } },
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
  const storedIcon = async (id: string) => (await db.select({ icon: page.icon }).from(page).where(eq(page.id, id)))[0].icon;

  // Pages over MCP
  const created = await callTool(ids.owner, "create_page", {
    workspace_id: workspaceId,
    title: "Launch plan",
    icon: "icon:rocket:blue",
    markdown: "> [!TIP]\n> icon:lightbulb:yellow Remember the checklist.\n\nPlain text.",
  });
  check(!created.isError, "create_page takes a built-in icon", created.text);
  const pageId = created.data.id as string;
  check((await storedIcon(pageId)) === "icon:rocket:blue", "it is stored as written");
  const read = await callTool(ids.owner, "get_page", { page_id: pageId });
  check(read.data?.icon === "icon:rocket:blue", "get_page returns it as is", read.data);
  check(String(read.data?.markdown ?? read.data?.body ?? "").includes("> icon:lightbulb:yellow Remember"), "a callout's built-in icon reads back in Markdown", read.data);
  const blocks = (await getCollab().readBlocks(pageId)).blocks as { type: string; props?: { icon?: string } }[];
  check(blocks.some((b) => b.type === CALLOUT_BLOCK && b.props?.icon === "icon:lightbulb:yellow"), "the callout keeps the built-in icon as its icon", blocks);
  const exported = await pageMarkdown(ids.owner, pageId);
  check(exported.body.includes("icon:lightbulb:yellow"), "Markdown export keeps the callout's icon token", exported.body);

  // The app and the REST API set an existing page's icon through setPageIcon.
  await setPageIcon(ids.owner, pageId, "icon:rocket");
  check((await storedIcon(pageId)) === "icon:rocket", "a built-in icon without a color is kept");
  for (const wrong of ["icon:not-an-icon:blue", "icon:rocket:teal", "icon:Rocket", "icon:", "icon:rocket:blue:x"]) {
    check((await failure(setPageIcon(ids.owner, pageId, wrong))) !== null, `setPageIcon refuses ${wrong}`);
  }
  check((await storedIcon(pageId)) === "icon:rocket", "…and keeps the icon it had");
  const refused = await callTool(ids.owner, "create_page", { workspace_id: workspaceId, title: "Wrong", icon: "icon:rocket:teal" });
  check(refused.isError && refused.text.includes("icon:<name>"), "create_page refuses an unknown color and says what fits", refused.text);
  await setPageIcon(ids.owner, pageId, "📘");
  check((await storedIcon(pageId)) === "📘", "an emoji still works");
  await setPageIcon(ids.owner, pageId, "icon:rocket:green");

  // PDF: draws the page's and the callout's icons (no raw tokens; the unit test reads the layout).
  const pdf = await pagePdf(ids.owner, pageId);
  check(pdf.bytes.subarray(0, 5).toString() === "%PDF-" && pdf.bytes.length > 1000, "a PDF of a page with built-in icons renders", pdf.bytes.length);
  check(!pdf.bytes.toString("latin1").includes("icon:rocket"), "the PDF holds no icon token as text");

  // Views and properties
  const database = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const status = await addProperty(ids.owner, database.id, { name: "Stage", type: "select" });
  const { views } = await getDatabase(ids.owner, database.id);
  const view = views[0];
  check(view, "the database has a view");

  await updateView(ids.owner, view.id, { config: { ...view.config, icon: "icon:kanban:purple" } });
  let fresh = await getDatabase(ids.owner, database.id);
  check(fresh.views.find((v) => v.id === view.id)?.config.icon === "icon:kanban:purple", "a view keeps a built-in icon", fresh.views[0].config);
  check((await failure(updateView(ids.owner, view.id, { config: { ...view.config, icon: "icon:kanban:teal" } }))) === "invalidIcon", "a view refuses an unknown color");
  check((await failure(updateView(ids.owner, view.id, { config: { ...view.config, icon: "not an icon" } }))) === "invalidIcon", "a view refuses text");
  await updateView(ids.owner, view.id, { config: { ...view.config, icon: "🗂️" } });
  fresh = await getDatabase(ids.owner, database.id);
  check(fresh.views.find((v) => v.id === view.id)?.config.icon === "🗂️", "a view takes an emoji");
  await updateView(ids.owner, view.id, { config: { ...view.config, icon: undefined } });
  fresh = await getDatabase(ids.owner, database.id);
  check(fresh.views.find((v) => v.id === view.id)?.config.icon === undefined, "a view's icon can be removed");

  await updateProperty(ids.owner, status.id, { icon: "icon:flag:red" });
  fresh = await getDatabase(ids.owner, database.id);
  check(fresh.properties.find((p) => p.id === status.id)?.options.icon === "icon:flag:red", "a property keeps a built-in icon");
  check((await failure(updateProperty(ids.owner, status.id, { icon: "icon:nope" }))) === "invalidIcon", "a property refuses an unknown icon");
  await updateProperty(ids.owner, status.id, { name: "Phase" });
  fresh = await getDatabase(ids.owner, database.id);
  check(fresh.properties.find((p) => p.id === status.id)?.options.icon === "icon:flag:red", "renaming the property keeps its icon");
  await updateProperty(ids.owner, status.id, { icon: null });
  fresh = await getDatabase(ids.owner, database.id);
  check(fresh.properties.find((p) => p.id === status.id)?.options.icon === undefined, "null removes a property's icon", fresh.properties.find((p) => p.id === status.id)?.options);

  // The icon picker's remembered choices
  check((await getIconPreferences(ids.owner)).skinTone === null, "no skin tone until one is picked");
  await setIconPreferences(ids.owner, { skinTone: 3 });
  await setIconPreferences(ids.owner, { iconColor: "green" });
  const prefs = await getIconPreferences(ids.owner);
  check(prefs.skinTone === 3 && prefs.iconColor === "green", "skin tone and icon color are remembered apart", prefs);
  await setIconPreferences(ids.owner, { skinTone: null });
  check((await getIconPreferences(ids.owner)).skinTone === null && (await getIconPreferences(ids.owner)).iconColor === "green", "the plain tone clears only the tone");
  check(!isSkinTone(6) && !isSkinTone(2.5) && isSkinTone(5) && !isIconColor("teal") && isIconColor("blue"), "only real tones and colors pass");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
