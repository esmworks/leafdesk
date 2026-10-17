/**
 * End-to-end check of presence (who has a page open) over real websockets: people who may only
 * view are counted, each person shows once however many tabs they have, nobody can pose as someone
 * else, and people drop off when they leave. Open connections are dropped when narrowing a share or
 * moving a page takes away what they allow.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/presence-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { inArray } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { user, workspace, workspaceMember } = await import("@/db/schema");
const { PRESENCE_FIELD, viewersOf } = await import("@/lib/presence");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { authorizeCollab } = await import("@/server/collab/authorize");
const { issueCollabToken } = await import("@/server/collab/token");
const { archivePage, createPage, movePage, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { createServer } = await import("node:http");
const crossws = (await import("crossws/adapters/node")).default;
const { HocuspocusProvider } = await import("@hocuspocus/provider");

const RUN = `presence-e2e-${Date.now().toString(36)}`;

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

/** Polls until `fn` holds (awareness travels asynchronously); returns whether it did. */
async function eventually(fn: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

const ids = { owner: `${RUN}-owner`, viewer: `${RUN}-viewer`, editor: `${RUN}-editor` };
const names = { owner: "Olive Owner", viewer: "Vera Viewer", editor: "Emre Editor" };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

const ws = crossws({
  hooks: {
    open(peer) {
      (peer as unknown as { hp: ReturnType<typeof hocuspocus.handleConnection> }).hp = hocuspocus.handleConnection(
        peer.websocket as never,
        peer.request as Request,
      );
    },
    message(peer, message) {
      (peer as unknown as { hp?: { handleMessage(m: Uint8Array): void } }).hp?.handleMessage(message.uint8Array());
    },
    close(peer, event) {
      (peer as unknown as { hp?: { handleClose(e: unknown): void } }).hp?.handleClose({ code: event.code, reason: event.reason });
    },
  },
});
const server = createServer();
server.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

type Tab = InstanceType<typeof HocuspocusProvider>;
const tabs: Tab[] = [];

/** A browser tab with the page open, signed in as `who`. */
async function openTab(pageId: string, who: keyof typeof ids): Promise<Tab> {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: `page:${pageId}`,
    document: new Y.Doc(),
    token: issueCollabToken(ids[who], names[who]),
  });
  tabs.push(provider);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${who}'s tab never synced`)), 5000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return provider;
}

/** Close codes of `tab`'s connection from now on. */
function watchCloses(tab: Tab) {
  const codes: number[] = [];
  tab.on("close", ({ event }: { event: { code: number } }) => void codes.push(event.code));
  return codes;
}

/** Who `tab` sees on the page, as the page header would list them. */
const seenBy = (tab: Tab, who: keyof typeof ids) =>
  viewersOf(tab.awareness!.getStates() as Map<number, Record<string, unknown>>, ids[who], tab.awareness!.clientID);
const seenIds = (tab: Tab, who: keyof typeof ids) => seenBy(tab, who).map((p) => p.id);

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.viewer, role: "member" },
    { workspaceId, userId: ids.editor, role: "member" },
  ]);
  const doc = await createPage({ userId: ids.owner }, { workspaceId, title: "Launch plan" });
  await setPagePermission(ids.owner, doc.id, ids.owner, "full");
  await setPagePermission(ids.owner, doc.id, null, "view");
  await setPagePermission(ids.owner, doc.id, ids.editor, "edit");
  check((await authorizeCollab(ids.viewer, { kind: "page", id: doc.id })).readOnly, "the viewer's connection is read-only");

  const owner = await openTab(doc.id, "owner");
  owner.setAwarenessField(PRESENCE_FIELD, { id: ids.owner, name: names.owner });
  const viewer = await openTab(doc.id, "viewer");
  // A browser claiming to be someone else is named after the user it signed in as.
  viewer.setAwarenessField(PRESENCE_FIELD, { id: ids.editor, name: "Not Vera" });

  check(
    await eventually(() => seenIds(owner, "owner").includes(ids.viewer)),
    "people who may only view show up for the others",
    seenBy(owner, "owner"),
  );
  check(
    JSON.stringify(seenBy(owner, "owner")) === JSON.stringify([{ id: ids.viewer, name: names.viewer }]),
    "…under the name they signed in with, whatever their browser claimed",
    seenBy(owner, "owner"),
  );
  check(
    await eventually(() => seenIds(viewer, "viewer").join() === ids.owner),
    "a read-only viewer sees who else is on the page, without themselves",
    seenBy(viewer, "viewer"),
  );

  const editorTab1 = await openTab(doc.id, "editor");
  editorTab1.setAwarenessField(PRESENCE_FIELD, { id: ids.editor, name: names.editor });
  const editorTab2 = await openTab(doc.id, "editor");
  editorTab2.setAwarenessField(PRESENCE_FIELD, { id: ids.editor, name: names.editor });
  // Cursors share the awareness state; they must not count as presence on their own.
  editorTab2.setAwarenessField("user", { name: names.editor, color: "#0090ff" });
  check(
    await eventually(() => owner.awareness!.getStates().size === 4 && seenIds(owner, "owner").length === 2),
    "someone with two tabs open shows once",
    seenBy(owner, "owner"),
  );
  check(
    seenIds(editorTab1, "editor").sort().join() === [ids.owner, ids.viewer].sort().join(),
    "your other tab doesn't show you",
    seenBy(editorTab1, "editor"),
  );

  // Leaving the page clears presence right away, even while the provider lingers.
  viewer.setAwarenessField(PRESENCE_FIELD, null);
  check(
    await eventually(() => !seenIds(owner, "owner").includes(ids.viewer)),
    "leaving the page takes you off it for the others",
    seenBy(owner, "owner"),
  );
  check(owner.awareness!.getStates().size === 4, "…while the connection itself stays open");

  editorTab1.destroy();
  check(
    await eventually(() => owner.awareness!.getStates().size === 3) && seenIds(owner, "owner").includes(ids.editor),
    "closing one of two tabs keeps the person on the page",
    seenBy(owner, "owner"),
  );
  editorTab2.destroy();
  check(
    await eventually(() => !seenIds(owner, "owner").includes(ids.editor)),
    "closing the last tab takes them off",
    seenBy(owner, "owner"),
  );

  // Access is checked when a connection opens; taking it away later drops the connections it no longer allows.
  const notes = await createPage({ userId: ids.owner }, { workspaceId, title: "Team notes" });
  await setPagePermission(ids.owner, notes.id, ids.owner, "full");
  await setPagePermission(ids.owner, notes.id, null, "edit");
  const draft = await createPage({ userId: ids.owner }, { workspaceId, parentId: notes.id, title: "Draft" });
  const viewerDraft = await openTab(draft.id, "viewer");
  const viewerDraftCloses = watchCloses(viewerDraft);
  await movePage(ids.owner, draft.id, doc.id);
  check(
    await eventually(() => viewerDraftCloses.length > 0),
    "moving a page where someone may only view drops their editable connection",
    viewerDraftCloses,
  );

  const editorTab = await openTab(doc.id, "editor");
  const editorCloses = watchCloses(editorTab);
  const ownerCloses = watchCloses(owner);
  await setPagePermission(ids.owner, doc.id, ids.editor, "view");
  check(
    await eventually(() => editorCloses.length > 0),
    "lowering a member's share to view drops their editable connection",
    editorCloses,
  );

  const viewerCloses = watchCloses(viewer);
  await setPagePermission(ids.owner, doc.id, null, "none");
  check(
    await eventually(() => viewerCloses.length > 0),
    "closing a page to everyone drops the connections of those it shut out",
    viewerCloses,
  );
  check(ownerCloses.length === 0, "…and leaves the owner's open", ownerCloses);

  // A page in the trash doesn't change: open editors turn read-only, and writable again once it is back.
  const trashable = await createPage({ userId: ids.owner }, { workspaceId, title: "Old plan" });
  const trashTab = await openTab(trashable.id, "owner");
  const live = () => hocuspocus.documents.get(`page:${trashable.id}`);
  const probe = () => live()?.getText("probe").toString();
  trashTab.document.getText("probe").insert(0, "a");
  check(await eventually(() => probe() === "a"), "an open editor's change reaches the page", probe());
  await archivePage(ids.owner, trashable.id);
  const connections = live()?.getConnections() ?? [];
  check(connections.length > 0 && connections.every((c) => c.readOnly), "moving the page to the trash turns its open connections read-only");
  trashTab.document.getText("probe").insert(1, "b");
  await new Promise((r) => setTimeout(r, 300));
  check(probe() === "a", "…so a change from the open tab no longer lands", probe());
  await restorePage(ids.owner, trashable.id);
  check((live()?.getConnections() ?? []).every((c) => !c.readOnly), "restoring it makes them writable again");
  // As the page does once it hears of the restore (components/page/page-view).
  trashTab.forceSync();
  trashTab.document.getText("probe").insert(0, "c");
  check(await eventually(() => probe() === "cab"), "…and changes land again, the refused one with them", probe());

  console.log(`\n${passed} checks passed`);
} finally {
  for (const tab of tabs) tab.destroy();
  await new Promise((resolve) => server.close(resolve));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
