/**
 * End-to-end check of suggested edits: a commenter's browser connection takes their own
 * suggestions and nothing else, each suggestion gets a comment thread in its author's name, the
 * page reads as if pending suggestions were not made, who may accept, reject or withdraw them, what
 * accepting and rejecting do, the inbox notices, and server writes that keep suggestions.
 * Creates its own users and workspace and deletes them afterwards; runs its own collab server.
 *
 *   pnpm tsx scripts/suggestions-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const Y = await import("yjs");
const { EditorState } = await import("prosemirror-state");
const { prosemirrorToYXmlFragment } = await import("y-prosemirror");
const { db } = await import("@/db");
const { notification, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT, SUGGESTION_REFUSED_EVENT } = await import("@/lib/collab-constants");
const { commentText } = await import("@/lib/comments");
const { suggestTransaction } = await import("@/lib/suggest-changes");
const { isAiSuggestion, newSuggestionId, rejectedView, suggestionAuthor } = await import("@/lib/suggestions");
const { listComments } = await import("@/server/comments");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { bodyRoot } = await import("@/server/collab/suggestion-doc");
const { authorizeCollab } = await import("@/server/collab/authorize");
const { issueCollabToken } = await import("@/server/collab/token");
const { createPage, setPageLocked } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { answerSuggestions, listSuggestedEdits } = await import("@/server/suggested-edits");
const { AccessError } = await import("@/server/access");
const { createServer } = await import("node:http");
const crossws = (await import("crossws/adapters/node")).default;
const { HocuspocusProvider } = await import("@hocuspocus/provider");

type Doc = InstanceType<typeof Y.Doc>;
type PmNode = ReturnType<typeof bodyRoot>;
type Tr = InstanceType<typeof EditorState>["tr"];

const RUN = `suggestions-e2e-${Date.now().toString(36)}`;

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

async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AccessError) return "access";
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    throw error;
  }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
    value = await read();
  }
  return value;
}

/** Position of `text` in the body. */
function at(doc: PmNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    return true;
  });
  if (found < 0) throw new Error(`no "${text}" in the body`);
  return found;
}

/** Changes a browser's copy of the body as its editor would: suggested in `authorId`'s name, or for real. */
function edit(browser: Doc, authorId: string, change: (tr: Tr, doc: PmNode) => void, { real = false } = {}) {
  const fragment = browser.getXmlFragment(COLLAB_FRAGMENT);
  const state = EditorState.create({ doc: bodyRoot(fragment) });
  const tr = state.tr;
  change(tr, state.doc);
  const next = real ? tr : suggestTransaction(tr, state, { authorId, newId: () => newSuggestionId(authorId) }).tr;
  prosemirrorToYXmlFragment(state.apply(next).doc, fragment);
}

const notices = (userId: string, pageId: string) =>
  db
    .select({ message: notification.message, actorId: notification.actorId, threadId: notification.threadId })
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.kind, "comment"), eq(notification.pageId, pageId)));

const ids = {
  owner: `${RUN}-owner`,
  editor: `${RUN}-editor`,
  commenter: `${RUN}-commenter`,
  viewer: `${RUN}-viewer`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

// The collab server on a port of its own, as server.ts runs it.
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
const providers: InstanceType<typeof HocuspocusProvider>[] = [];

/** A browser with the page open as `userId`. */
async function browser(userId: string, pageId: string) {
  const doc = new Y.Doc();
  const closes: number[] = [];
  const events: string[] = [];
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: `page:${pageId}`,
    document: doc,
    token: issueCollabToken(userId, userId),
    onClose: ({ event }) => void closes.push(event.code),
    onStateless: ({ payload }) => void events.push(payload),
  });
  providers.push(provider);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${userId}'s browser never synced`)), 5000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return { doc, closes, events, provider };
}

const markdownOf = async (pageId: string) => (await getCollab().readPage(pageId)).markdown;
const pending = (pageId: string) => getCollab().readSuggestions(pageId);
const live = (pageId: string) => hocuspocus.documents.get(`page:${pageId}`)!;
const rawText = (pageId: string) => bodyRoot(live(pageId).getXmlFragment(COLLAB_FRAGMENT)).textContent;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.commenter, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
  ]);
  const doc = await createPage({ userId: ids.owner }, { workspaceId, title: "Plan" });
  await getCollab().replaceContent(doc.id, "Hello world.\n\nSecond paragraph.", { userId: ids.owner });
  await setPagePermission(ids.owner, doc.id, ids.owner, "full");
  await setPagePermission(ids.owner, doc.id, null, "view");
  await setPagePermission(ids.owner, doc.id, ids.editor, "edit");
  await setPagePermission(ids.owner, doc.id, ids.commenter, "comment");


  // Who may write what over the live connection
  const asCommenter = await authorizeCollab(ids.commenter, { kind: "page", id: doc.id });
  check(asCommenter.suggestOnly && !asCommenter.readOnly, "a commenter's connection takes suggestions", asCommenter);
  const asViewer = await authorizeCollab(ids.viewer, { kind: "page", id: doc.id });
  check(asViewer.readOnly && !asViewer.suggestOnly, "a viewer's connection stays read-only", asViewer);

  // A commenter suggests
  const commenter = await browser(ids.commenter, doc.id);
  edit(commenter.doc, ids.commenter, (tr, d) => tr.insertText(" dear", at(d, " world")));
  const [first] = await until(() => pending(doc.id), (s) => s.length === 1, "the commenter's suggestion");
  check(first.authorId === ids.commenter && first.inserted === " dear", "the commenter's suggestion reaches the page in their name", first);
  check(rawText(doc.id).includes("Hello dear world."), "…and everyone with the page open sees it", rawText(doc.id));
  check((await markdownOf(doc.id)).includes("Hello world.") && !(await markdownOf(doc.id)).includes("dear"), "the page reads as if it weren't made", await markdownOf(doc.id));
  const thread = await until(
    () => listComments(ids.viewer, doc.id),
    (threads) => threads.some((t) => t.suggestion === first.id),
    "the suggestion's thread",
  ).then((threads) => threads.find((t) => t.suggestion === first.id)!);
  check(thread.comments[0].userId === ids.commenter && commentText(thread.comments[0].body).includes("dear"), "it gets a thread in its author's name, quoting it", thread);
  const [stored] = await db.select({ markdown: page.contentMarkdown, text: page.contentText }).from(page).where(eq(page.id, doc.id));
  check(!stored.markdown?.includes("dear") && !stored.text?.includes("dear"), "the saved Markdown and search text leave it out", stored);
  const told = await until(() => notices(ids.owner, doc.id), (n) => n.some((x) => x.message === "suggested"), "the owner's notice");
  check(told.some((n) => n.message === "suggested" && n.actorId === ids.commenter && n.threadId === thread.id), "the page's watchers hear about it", told);

  // An editor suggests too, from their own browser
  const editor = await browser(ids.editor, doc.id);
  await until(async () => editor.doc.getXmlFragment(COLLAB_FRAGMENT).toString().includes("dear"), Boolean, "the editor's copy");
  edit(editor.doc, ids.editor, (tr, d) => tr.delete(at(d, "Second "), at(d, "Second ") + 7));
  const both = await until(() => pending(doc.id), (s) => s.length === 2, "the editor's suggestion");
  const second = both.find((s) => s.authorId === ids.editor)!;
  check(second.deleted === "Second ", "an editor's deletion is suggested, the text kept", second);
  check((await markdownOf(doc.id)).includes("Second paragraph."), "…and the page still reads it", await markdownOf(doc.id));

  // A commenter can't make a real edit
  const tampered = await browser(ids.commenter, doc.id);
  edit(tampered.doc, ids.commenter, (tr, d) => tr.insertText("!!", at(d, "Hello")), { real: true });
  await until(async () => tampered.closes.length, Boolean, "the tampered browser's disconnect");
  check(tampered.closes.length > 0, "a commenter's browser making a real edit is disconnected", tampered.closes);
  check(tampered.events.includes(SUGGESTION_REFUSED_EVENT), "…told why, so the tab forgets its copy", tampered.events);
  check(!rawText(doc.id).includes("!!") && !(await markdownOf(doc.id)).includes("!!"), "…and the edit never reaches the page", rawText(doc.id));
  const forger = await browser(ids.commenter, doc.id);
  edit(forger.doc, ids.editor, (tr, d) => tr.insertText("forged", at(d, "paragraph")));
  await until(async () => forger.closes.length, Boolean, "the forger's disconnect");
  check(!rawText(doc.id).includes("forged"), "a commenter can't suggest in someone else's name", rawText(doc.id));
  const thief = await browser(ids.commenter, doc.id);
  thief.doc.transact(() => {
    const fragment = thief.doc.getXmlFragment(COLLAB_FRAGMENT);
    prosemirrorToYXmlFragment(rejectedView(bodyRoot(fragment)), fragment);
  });
  await until(async () => thief.closes.length, Boolean, "the thief's disconnect");
  check((await pending(doc.id)).length === 2, "…nor take back someone else's", await pending(doc.id));
  thief.doc.getMap("meta").set("title", "Mine");
  check((await getCollab().readPage(doc.id)).title === "Plan", "a commenter's connection doesn't change the title");

  // Who may answer
  check((await failure(() => answerSuggestions(ids.viewer, doc.id, "reject", [first.id]))) === "access", "viewers can't answer suggestions");
  check((await failure(() => answerSuggestions(ids.commenter, doc.id, "accept", [first.id]))) === "access", "commenters can't accept, not even their own");
  check((await failure(() => answerSuggestions(ids.commenter, doc.id, "reject", [second.id]))) === "access", "…nor reject other people's");
  check((await failure(() => answerSuggestions(ids.commenter, doc.id, "reject", null))) === "access", "…nor reject them all");
  check((await listSuggestedEdits(ids.viewer, doc.id)).length === 2, "anyone who can view the page lists them");

  // Accepting and rejecting
  const accepted = await answerSuggestions(ids.editor, doc.id, "accept", [first.id]);
  check(accepted.length === 1 && accepted[0].threadId === thread.id, "an editor accepts a suggestion", accepted);
  check((await markdownOf(doc.id)).includes("Hello dear world."), "…which the page now reads", await markdownOf(doc.id));
  const resolved = (await listComments(ids.owner, doc.id)).find((t) => t.id === thread.id);
  check(resolved?.resolved, "…and its thread is resolved", resolved);
  check((await notices(ids.commenter, doc.id)).some((n) => n.message === "accepted" && n.actorId === ids.editor), "its author hears it was accepted");
  check((await answerSuggestions(ids.editor, doc.id, "accept", [first.id])).length === 0, "answering it again finds nothing");
  const rejected = await answerSuggestions(ids.owner, doc.id, "reject", [second.id]);
  check(rejected.length === 1 && (await markdownOf(doc.id)).includes("Second paragraph."), "rejecting a deletion keeps the text", await markdownOf(doc.id));
  check((await pending(doc.id)).length === 0, "…and no suggestion is left", await pending(doc.id));
  const editorNotices = await until(() => notices(ids.editor, doc.id), (n) => n.some((x) => x.message === "rejected"), "the editor's notice");
  check(editorNotices.some((n) => n.message === "rejected" && n.actorId === ids.owner), "its author hears it was rejected", editorNotices);

  // Withdrawing one's own
  await until(async () => commenter.doc.getXmlFragment(COLLAB_FRAGMENT).toString().includes("dear"), Boolean, "the commenter's copy");
  edit(commenter.doc, ids.commenter, (tr, d) => tr.insertText("new ", at(d, "paragraph")));
  const [third] = await until(() => pending(doc.id), (s) => s.length === 1, "the third suggestion");
  check((await answerSuggestions(ids.commenter, doc.id, "reject", [third.id])).length === 1, "a commenter withdraws their own suggestion");
  check(!rawText(doc.id).includes("new") && (await pending(doc.id)).length === 0, "…which goes", rawText(doc.id));

  // Server writes keep suggestions; all at once
  edit(commenter.doc, ids.commenter, (tr, d) => tr.insertText(" big", at(d, " world")));
  await until(() => pending(doc.id), (s) => s.length === 1, "the fourth suggestion");
  await getCollab().replaceContent(doc.id, "Hello dear world.\n\nSecond paragraph, rewritten.", { userId: ids.owner });
  check((await pending(doc.id)).length === 1 && rawText(doc.id).includes("dear big world"), "a server write leaves the suggestions of blocks it doesn't change", rawText(doc.id));
  check((await markdownOf(doc.id)).includes("Second paragraph, rewritten."), "…and writes the rest", await markdownOf(doc.id));
  edit(commenter.doc, ids.commenter, (tr, d) => tr.delete(at(d, ", rewritten"), at(d, ", rewritten") + 11));
  await until(() => pending(doc.id), (s) => s.length === 2, "the fifth suggestion");
  check(suggestionAuthor((await pending(doc.id))[0].id) === ids.commenter, "suggestion ids name their author");
  check((await answerSuggestions(ids.editor, doc.id, "accept", null)).length === 2, "accept all answers every pending one");
  check((await markdownOf(doc.id)).includes("Hello dear big world.") && (await markdownOf(doc.id)).includes("Second paragraph."), "…applying them all", await markdownOf(doc.id));

  // The AI chat of someone who asked for suggestions
  const before = await markdownOf(doc.id);
  await getCollab().replaceContent(doc.id, "Hello dear big world.\n\nSecond paragraph, by the AI.", { userId: ids.editor, asSuggestions: true }, true);
  const fromAi = await pending(doc.id);
  check(fromAi.length === 1 && fromAi[0].authorId === ids.editor && isAiSuggestion(fromAi[0].id), "the AI's write goes in as its suggestion in the person's name", fromAi);
  check((await markdownOf(doc.id)) === before, "…and the page reads as before", await markdownOf(doc.id));
  await answerSuggestions(ids.editor, doc.id, "accept", null);
  check((await markdownOf(doc.id)).includes("Second paragraph, by the AI."), "…until it is accepted", await markdownOf(doc.id));

  // A locked page takes no answers
  edit(commenter.doc, ids.commenter, (tr, d) => tr.insertText(" again", at(d, "Second")));
  await until(() => pending(doc.id), (s) => s.length === 1, "the sixth suggestion");
  await setPageLocked(ids.owner, doc.id, true);
  check((await failure(() => answerSuggestions(ids.owner, doc.id, "reject", null))) === "pageLocked", "a locked page's suggestions wait until it is unlocked");

  console.log(`\n${passed} checks passed`);
} finally {
  for (const provider of providers) provider.destroy();
  // Saves the open page now rather than after the database connection is gone.
  await service.saveOpen();
  hocuspocus.closeConnections();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
