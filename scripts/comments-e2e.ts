/**
 * End-to-end check of comments on pages: who may read and write them, anchoring threads to quoted
 * text, keeping anchors through server writes, cleaning comment bodies, notifications and emails to
 * the people in a thread, muting a thread's replies, threads on a row's property values (who sees
 * them, with property and row access), and the MCP tools.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/comments-e2e.ts
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
const { db } = await import("@/db");
const { notification, page, threadMute, user, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { CommentError, commentText: commentTextOf, THREADS_MAP } = await import("@/lib/comments");
const { changeComments, commentUsers, listComments } = await import("@/server/comments");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { threadQuotes } = await import("@/server/collab/comment-marks");
const { commentMentionCandidates } = await import("@/server/mentions");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { mutedThreads, setThreadMuted } = await import("@/server/thread-mute");
const { markThreadsSeen, setThreadMarked, threadStates } = await import("@/server/thread-state");
const { addProperty, deleteProperty, restoreProperty, updateRowProperties } = await import("@/server/databases");
const { setPropertyAccess } = await import("@/server/property-access");
const { setRowAccess } = await import("@/server/row-access");
const { AccessError, requirePageAccess } = await import("@/server/access");
const { authorizeCollab } = await import("@/server/collab/authorize");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createServer } = await import("node:http");
const crossws = (await import("crossws/adapters/node")).default;
const { HocuspocusProvider } = await import("@hocuspocus/provider");
const { issueCollabToken } = await import("@/server/collab/token");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");

const RUN = `comments-e2e-${Date.now().toString(36)}`;

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
    if (error instanceof CommentError) return error.code;
    throw error;
  }
}

/** The page's document as stored or, while open, live. */
async function withDoc<T>(pageId: string, fn: (doc: InstanceType<typeof Y.Doc>) => T): Promise<T> {
  const live = hocuspocus.documents.get(`page:${pageId}`);
  if (live) return fn(live);
  const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId));
  const doc = new Y.Doc();
  if (row?.ydoc) Y.applyUpdate(doc, row.ydoc);
  try {
    return fn(doc);
  } finally {
    doc.destroy();
  }
}
const quotes = (pageId: string) => withDoc(pageId, (doc) => threadQuotes(doc.getXmlFragment(COLLAB_FRAGMENT)));
const threadCount = (pageId: string) => withDoc(pageId, (doc) => doc.getMap(THREADS_MAP).size);

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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "comments-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const unread = (userId: string, threadId: string) =>
  db
    .select()
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.kind, "comment"), eq(notification.threadId, threadId)));

const ids = {
  owner: `${RUN}-owner`,
  editor: `${RUN}-editor`,
  commenter: `${RUN}-commenter`,
  viewer: `${RUN}-viewer`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const mails: { to: string; subject: string; text: string }[] = [];
setShareMailer(async (mail) => void mails.push(mail));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
    { workspaceId, userId: ids.commenter, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  const doc = await createPage({ userId: ids.owner }, { workspaceId, title: "Plan" });
  await getCollab().replaceContent(doc.id, "Ship the comments feature this week.\n\nSecond paragraph stays.", { userId: ids.owner });
  // Members only view; the owner keeps full access and one member may edit.
  await setPagePermission(ids.owner, doc.id, ids.owner, "full");
  await setPagePermission(ids.owner, doc.id, null, "view");
  await setPagePermission(ids.owner, doc.id, ids.editor, "edit");
  await setPagePermission(ids.owner, doc.id, ids.commenter, "comment");

  const [before] = await db.select({ updatedAt: page.updatedAt, updatedBy: page.updatedBy }).from(page).where(eq(page.id, doc.id));

  // Who may comment
  check((await listComments(ids.viewer, doc.id)).length === 0, "people who can view a page read its comments");
  check((await failure(() => listComments(ids.outsider, doc.id))) === "access", "people outside the workspace can't read them");
  check(
    (await failure(() => changeComments(ids.viewer, doc.id, { type: "createThread", body: "hi", anchor: { quote: "comments" } }))) === "access",
    "viewing a page isn't enough to comment on it",
  );

  // Anchoring to quoted text
  check(
    (await failure(() => changeComments(ids.editor, doc.id, { type: "createThread", body: "hi", anchor: { quote: "not on the page" } }))) === "notFound",
    "a quote the page doesn't have is refused",
  );
  check((await threadCount(doc.id)) === 0, "…and leaves no thread behind");
  const created = await changeComments(
    ids.editor,
    doc.id,
    {
      type: "createThread",
      body: [{ type: "paragraph", content: [{ type: "link", href: "javascript:alert(1)", content: "Is this" }, " realistic?"] }],
      anchor: { quote: "comments feature" },
    },
  );
  const thread = created.thread!;
  check(created.anchored === true && thread.comments.length === 1 && thread.comments[0].userId === ids.editor, "an editor starts a thread on quoted text", created);
  check(
    JSON.stringify(thread.comments[0].body) === JSON.stringify([{ type: "paragraph", content: [{ type: "text", text: "Is this", styles: {} }, { type: "text", text: " realistic?", styles: {} }] }]),
    "script links in comments are dropped to their text",
    thread.comments[0].body,
  );
  check((await quotes(doc.id)).get(thread.id) === "comments feature", "the thread marks the quoted text", Object.fromEntries(await quotes(doc.id)));
  const content = await getCollab().readPage(doc.id);
  check(content.markdown.includes("Ship the comments feature this week."), "text under a comment still reads as page content", content.markdown);
  const [after] = await db.select({ updatedAt: page.updatedAt, updatedBy: page.updatedBy }).from(page).where(eq(page.id, doc.id));
  check(
    after.updatedBy === ids.owner && after.updatedAt.getTime() === before.updatedAt.getTime(),
    "commenting doesn't count as editing the page",
    { before, after },
  );
  check((await unread(ids.owner, thread.id)).length === 1, "a new thread tells the page's author");
  check((await unread(ids.editor, thread.id)).length === 0, "…but not the person who wrote it");

  // Replies and notifications
  const reply = await changeComments(ids.owner, doc.id, { type: "addComment", threadId: thread.id, body: "Yes, by Friday." });
  check(reply.thread?.comments.length === 2 && reply.comment?.userId === ids.owner, "the owner replies", reply);
  check((await unread(ids.editor, thread.id)).length === 1, "a reply tells the others in the thread");
  await changeComments(ids.owner, doc.id, { type: "addComment", threadId: thread.id, body: "Actually Thursday." });
  const pending = await unread(ids.editor, thread.id);
  check(pending.length === 1 && pending[0].actorId === ids.owner && pending[0].emailDueAt !== null, "more replies stay one unread notification with its email queued", pending);
  await flushShareEmails();
  const commentMails = mails.filter((m) => m.to === `${ids.editor}@example.test` && m.subject.includes("commented"));
  check(
    commentMails.length === 1 && commentMails[0].subject.includes(ids.owner) && commentMails[0].text.includes("Actually Thursday."),
    "one email quotes the latest reply",
    commentMails,
  );
  await setNotificationPreference(ids.editor, "comment", "email", false);
  await changeComments(ids.owner, doc.id, { type: "addComment", threadId: thread.id, body: "Quiet one." });
  mails.length = 0;
  await flushShareEmails();
  check(!mails.some((m) => m.to === `${ids.editor}@example.test`), "people who turned comment emails off get none", mails);

  // Who may change what
  const ownerComment = reply.comment!.id;
  const editorComment = thread.comments[0].id;
  check(
    (await failure(() =>
      changeComments(ids.editor, doc.id, { type: "updateComment", threadId: thread.id, commentId: ownerComment, body: "edited" }),
    )) === "notAllowed",
    "people edit only their own comments",
  );
  check((await failure(() => changeComments(ids.editor, doc.id, { type: "deleteThread", threadId: thread.id }))) === "notAllowed", "editing isn't enough to delete a thread");
  await changeComments(ids.editor, doc.id, { type: "updateComment", threadId: thread.id, commentId: editorComment, body: "Is this realistic now?" });
  await changeComments(ids.editor, doc.id, { type: "resolveThread", threadId: thread.id });
  let threads = await listComments(ids.viewer, doc.id);
  check(
    threads[0].resolved && threads[0].resolvedBy === ids.editor && threads[0].comments[0].body?.[0].content[0].type === "text",
    "people edit their comments and resolve threads",
    threads[0],
  );
  await changeComments(ids.editor, doc.id, { type: "unresolveThread", threadId: thread.id });
  check(
    (await failure(() => changeComments(ids.editor, doc.id, { type: "addReaction", threadId: thread.id, commentId: ownerComment, emoji: "<b>" }))) ===
      "invalidBody",
    "reactions are emoji",
  );
  await changeComments(ids.editor, doc.id, { type: "addReaction", threadId: thread.id, commentId: ownerComment, emoji: "👍" });
  threads = await listComments(ids.viewer, doc.id);
  check(threads[0].comments[1].reactions[0]?.userIds.join() === ids.editor, "people react to comments", threads[0].comments[1]);
  check((await failure(() => changeComments(ids.editor, doc.id, { type: "createThread", body: "x".repeat(10_001), anchor: { quote: "Second" } }))) === "tooLong", "overlong comments are refused");
  check((await failure(() => changeComments(ids.editor, doc.id, { type: "addComment", threadId: "nope", body: "hi" }))) === "notFound", "replies need a thread");

  // People who may only comment
  const commenterConnection = await authorizeCollab(ids.commenter, { kind: "page", id: doc.id });
  check(commenterConnection.suggestOnly && !commenterConnection.readOnly, "people who can comment open the page to suggest edits only");
  check((await failure(() => requirePageAccess(ids.commenter, doc.id, "edit"))) === "access", "…and can't edit it");
  const [firstBlock] = (await getCollab().readBlocks(doc.id)).blocks;
  const byCommenter = await changeComments(ids.commenter, doc.id, {
    type: "createThread",
    body: "Which week?",
    anchor: { quote: "this week", blockId: (firstBlock as { id: string }).id, offset: 26 },
  });
  check(
    byCommenter.anchored && (await quotes(doc.id)).get(byCommenter.thread!.id) === "this week",
    "…but comment on a selection, which the server marks",
    Object.fromEntries(await quotes(doc.id)),
  );
  check(
    (await failure(() => changeComments(ids.commenter, doc.id, { type: "deleteThread", threadId: thread.id }))) === "notAllowed",
    "…and can't delete other people's threads",
  );
  await changeComments(ids.commenter, doc.id, { type: "deleteComment", threadId: byCommenter.thread!.id, commentId: byCommenter.comment!.id });
  check(!(await listComments(ids.commenter, doc.id)).some((t) => t.id === byCommenter.thread!.id), "…but delete their own");
  const offered = (await commentMentionCandidates(ids.commenter, doc.id, "")).people.map((p) => p.id).sort();
  check(
    offered.join() === [ids.editor, ids.owner, ids.viewer].sort().join(),
    "the @ menu in a comment offers the people who can open the page, not the writer or outsiders",
    offered,
  );
  check(
    (await commentMentionCandidates(ids.commenter, doc.id, "EDITOR")).people.map((p) => p.id).join() === ids.editor,
    "…matching what was typed",
  );
  check((await failure(() => commentMentionCandidates(ids.viewer, doc.id, ""))) === "access", "…and is only for people who may comment");
  const secret = await createPage({ userId: ids.owner }, { workspaceId, title: "Secret" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  await setPagePermission(ids.owner, secret.id, ids.commenter, "comment");
  const offeredSecret = (await commentMentionCandidates(ids.commenter, secret.id, "")).people.map((p) => p.id);
  check(offeredSecret.join() === ids.owner, "…leaving out members who can't open the page", offeredSecret);

  // Server writes keep anchors
  await getCollab().replaceContent(doc.id, "New intro.\n\nShip the comments feature this week.\n\nSecond paragraph stays.", { userId: ids.owner });
  check((await quotes(doc.id)).get(thread.id) === "comments feature", "rewriting the page keeps comments on text that is still there", Object.fromEntries(await quotes(doc.id)));

  // People in comments
  const people = await commentUsers(ids.viewer, doc.id, [ids.owner, ids.editor, ids.outsider]);
  check(people.map((p) => p.id).sort().join() === [ids.editor, ids.owner].sort().join(), "comment UIs learn names of workspace people only", people);

  // MCP
  let r = await callTool(ids.owner, "add_comment", { page_id: doc.id, text: "From the assistant.\nTwo lines.", quote: "Second paragraph" });
  check(!r.isError && r.data.thread_id && r.data.url, "add_comment starts a thread on quoted text", r.text);
  const aiThread = r.data.thread_id as string;
  r = await callTool(ids.owner, "add_comment", { page_id: doc.id, text: "x", quote: "nowhere to be found" });
  check(r.isError && r.text.includes("exact text"), "add_comment explains quotes it can't find", r.text);
  r = await callTool(ids.owner, "add_comment", { page_id: doc.id, text: "x" });
  check(r.isError && r.text.includes("either quote"), "add_comment needs a quote or a thread", r.text);
  r = await callTool(ids.owner, "add_comment", { page_id: doc.id, text: "x", thread_id: aiThread }, [READ_SCOPE]);
  check(r.isError && r.text.includes("read-only"), "add_comment needs pages:write", r.text);
  r = await callTool(ids.editor, "add_comment", { page_id: doc.id, text: "Agreed.", thread_id: aiThread });
  check(!r.isError, "add_comment replies in a thread", r.text);
  r = await callTool(ids.viewer, "list_comments", { page_id: doc.id }, [READ_SCOPE]);
  const listed = r.data?.threads.find((t: { id: string }) => t.id === aiThread);
  check(
    listed?.quote === "Second paragraph" &&
      listed.comments.map((c: { author: string; text: string }) => `${c.author}: ${c.text}`).join(" | ") ===
        `${ids.owner}: From the assistant.\nTwo lines. | ${ids.editor}: Agreed.`,
    "list_comments shows quotes, authors and text",
    r.data,
  );
  check(r.data.threads.length === 2, "…of every open thread", r.data.threads);
  r = await callTool(ids.outsider, "list_comments", { page_id: doc.id }, [READ_SCOPE]);
  check(r.isError, "list_comments needs access to the page");

  // Browsers get comments live but can't write them
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
  const browserDoc = new Y.Doc();
  const closes: number[] = [];
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: `page:${doc.id}`,
    document: browserDoc,
    token: issueCollabToken(ids.editor, ids.editor),
    onClose: ({ event }) => void closes.push(event.code),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the browser never synced")), 5000);
      provider.on("synced", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    check(browserDoc.getMap(THREADS_MAP).has(aiThread), "browsers receive the page's comments with the document");
    const forged = new Y.Map();
    browserDoc.getMap(THREADS_MAP).set("forged", forged);
    for (let i = 0; i < 100 && !closes.length; i++) await new Promise((r) => setTimeout(r, 20));
    check(closes.length > 0, "a browser writing comments into the document is disconnected", closes);
    check(!(await listComments(ids.owner, doc.id)).some((t) => t.id === "forged"), "…and its forged thread never reaches the page");
  } finally {
    provider.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  // Muting a thread's replies
  const clearInbox = (userId: string) =>
    db.delete(notification).where(and(eq(notification.userId, userId), eq(notification.threadId, thread.id)));
  const mention = (userId: string, name: string, text: string) => [
    { type: "paragraph", content: [{ type: "mention", props: { kind: "user", id: `${RUN}-m`, userId, name } }, { type: "text", text, styles: {} }] },
  ];
  await changeComments(ids.commenter, doc.id, { type: "addComment", threadId: thread.id, body: "Following along." });
  await setThreadMuted(ids.editor, doc.id, thread.id, true);
  check((await mutedThreads(ids.editor, doc.id)).join() === thread.id, "people mute the replies in a thread");
  check((await mutedThreads(ids.commenter, doc.id)).length === 0, "…for themselves only");
  check((await failure(() => setThreadMuted(ids.outsider, doc.id, thread.id, true))) === "access", "…if they can open the page");
  check((await failure(() => setThreadMuted(ids.editor, doc.id, "nope", true))) === "notFound", "…and the thread exists");
  await Promise.all([clearInbox(ids.editor), clearInbox(ids.commenter)]);
  await changeComments(ids.owner, doc.id, { type: "addComment", threadId: thread.id, body: "Moving on." });
  check((await unread(ids.editor, thread.id)).length === 0, "a muted thread's replies tell its muter nothing");
  check((await unread(ids.commenter, thread.id)).length === 1, "…and still tell everyone else");
  const mentioned = await changeComments(ids.owner, doc.id, { type: "addComment", threadId: thread.id, body: mention(ids.editor, "Editor", " what do you think?") });
  check(commentTextOf(mentioned.comment?.body) === "@Editor what do you think?", "a mention in a comment is kept as the person's name", mentioned.comment?.body);
  check((await unread(ids.editor, thread.id)).length === 1, "a reply mentioning the muter still tells them");
  check((await mutedThreads(ids.editor, doc.id)).length === 0, "…and ends their mute");
  await setThreadMuted(ids.editor, doc.id, thread.id, true);
  await changeComments(ids.editor, doc.id, { type: "addComment", threadId: thread.id, body: "Back in." });
  check((await mutedThreads(ids.editor, doc.id)).length === 0, "posting in a muted thread ends the mute");
  await setThreadMuted(ids.editor, doc.id, thread.id, true);
  await setThreadMuted(ids.commenter, doc.id, thread.id, true);
  await setThreadMuted(ids.commenter, doc.id, thread.id, false);
  check((await mutedThreads(ids.commenter, doc.id)).length === 0, "unmuting a thread hears about it again");
  await clearInbox(ids.editor);
  await changeComments(ids.owner, doc.id, {
    type: "updateComment",
    threadId: thread.id,
    commentId: mentioned.comment!.id,
    body: mention(ids.editor, "Editor", " what do you think now?"),
  });
  check((await unread(ids.editor, thread.id)).length === 1, "a person an edit mentions hears about it");
  check((await mutedThreads(ids.editor, doc.id)).length === 0, "…and their mute ends");

  // Comments on a row's property values: kept out of the row's document, and only for people who
  // see the value (property access, and the row's own access).
  const tasks = (await createPage({ userId: ids.owner }, { workspaceId, kind: "database", title: "Tasks" })).id;
  await setPagePermission(ids.owner, tasks, ids.owner, "full");
  await setPagePermission(ids.owner, tasks, null, "comment");
  const assignee = await addProperty(ids.owner, tasks, { name: "Assignee", type: "person" });
  const budget = await addProperty(ids.owner, tasks, { name: "Budget", type: "number" });
  const row = (await createPage({ userId: ids.owner }, { workspaceId, parentId: tasks, title: "Launch" })).id;
  await updateRowProperties(ids.owner, row, { [assignee.id]: [ids.editor], [budget.id]: 1200 });
  await setPropertyAccess(ids.owner, budget.id, { everyone: "none", exceptions: [{ userId: ids.editor, level: "view" }] });

  const onBudget = await changeComments(ids.editor, row, { type: "createThread", body: "Isn't this too high?", propertyId: budget.id });
  const budgetThread = onBudget.thread!;
  check(budgetThread.property?.name === "Budget", "a thread starts on a property's value", onBudget.thread);
  check((await threadCount(row)) === 0, "…kept out of the row's document, which everyone who opens the row receives");
  check((await listComments(ids.editor, row)).some((t) => t.id === budgetThread.id && t.property?.id === budget.id), "people who see the value read it");
  check(!(await listComments(ids.commenter, row)).some((t) => t.id === budgetThread.id), "people who don't see the value don't");
  check(
    (await failure(() => changeComments(ids.commenter, row, { type: "addComment", threadId: budgetThread.id, body: "Let me in" }))) === "notFound",
    "…nor reply to it",
  );
  check(
    (await failure(() => changeComments(ids.commenter, row, { type: "createThread", body: "Hm", propertyId: budget.id }))) === "notFound",
    "…nor start one on that value",
  );
  check(
    (await failure(() => changeComments(ids.editor, doc.id, { type: "createThread", body: "Hm", propertyId: budget.id }))) === "notFound",
    "pages that aren't rows have no property threads",
  );
  const onAssignee = await changeComments(ids.commenter, row, { type: "createThread", body: "Who else could take this?", propertyId: assignee.id });
  check(onAssignee.thread?.property?.name === "Assignee", "anyone who may comment on the row discusses a value they see");

  const budgetReply = await changeComments(ids.owner, row, {
    type: "addComment",
    threadId: budgetThread.id,
    body: [...mention(ids.commenter, "Commenter", " and "), ...mention(ids.editor, "Editor", " see the number")],
  });
  check(budgetReply.comment?.userId === ids.owner, "replies go into the property's thread");
  check((await unread(ids.editor, budgetThread.id)).length === 1, "people in the thread hear about replies");
  check((await unread(ids.commenter, budgetThread.id)).length === 0, "…but nobody it mentions who can't see the value");

  await markThreadsSeen(ids.editor, row, [budgetThread.id]);
  check(Boolean((await threadStates(ids.editor, row)).seen[budgetThread.id]), "a property thread is marked seen like any other");
  await setThreadMarked(ids.editor, row, budgetThread.id, true);
  check((await threadStates(ids.editor, row)).marked.includes(budgetThread.id), "…and marked to come back to");
  await setThreadMuted(ids.editor, row, budgetThread.id, true);
  check((await mutedThreads(ids.editor, row)).includes(budgetThread.id), "…and muted");
  check(
    (await failure(() => setThreadMarked(ids.commenter, row, budgetThread.id, true))) === "notFound",
    "people who don't see the value can't mark its thread",
  );
  await changeComments(ids.editor, row, { type: "resolveThread", threadId: budgetThread.id });
  check((await listComments(ids.editor, row)).find((t) => t.id === budgetThread.id)?.resolved === true, "property threads resolve");

  const listedByEditor = await callTool(ids.editor, "list_comments", { page_id: row, include_resolved: true });
  check(
    listedByEditor.data?.threads.some((t: { id: string; property?: string }) => t.id === budgetThread.id && t.property === "Budget"),
    "list_comments names the property a thread is about",
    listedByEditor.data,
  );
  const listedByCommenter = await callTool(ids.commenter, "list_comments", { page_id: row, include_resolved: true });
  check(
    !listedByCommenter.data?.threads.some((t: { id: string }) => t.id === budgetThread.id),
    "…and leaves out threads on values the caller doesn't see",
    listedByCommenter.data,
  );

  await deleteProperty(ids.owner, budget.id);
  check(!(await listComments(ids.editor, row)).some((t) => t.id === budgetThread.id), "a deleted property's threads go away");
  await restoreProperty(ids.owner, budget.id);
  check((await listComments(ids.editor, row)).some((t) => t.id === budgetThread.id), "…and come back with it");

  // Rows kept from everyone but the people they name: those left out read none of the row's threads.
  await setRowAccess(ids.owner, tasks, { restricted: true, rules: [{ kind: "person", propertyId: assignee.id, level: "comment" }] });
  check((await failure(() => listComments(ids.commenter, row))) === "access", "people a restricted row doesn't name read none of its threads");
  check(
    (await failure(() => changeComments(ids.commenter, row, { type: "addComment", threadId: onAssignee.thread!.id, body: "Still here?" }))) === "access",
    "…nor write in them",
  );
  check((await listComments(ids.editor, row)).some((t) => t.id === onAssignee.thread!.id), "the people it names still do");
  await setRowAccess(ids.owner, tasks, { restricted: false, rules: [] });

  // Deleting
  await changeComments(ids.owner, doc.id, { type: "addComment", threadId: thread.id, body: "Unread one." });
  await changeComments(ids.owner, doc.id, { type: "deleteThread", threadId: thread.id });
  check(!(await listComments(ids.owner, doc.id)).some((t) => t.id === thread.id), "full access deletes whole threads");
  check((await unread(ids.editor, thread.id)).filter((n) => !n.readAt).length === 0, "…taking back their unread notifications");
  check((await db.select().from(threadMute).where(eq(threadMute.threadId, thread.id))).length === 0, "…and forgetting who muted them");
  await archivePage(ids.owner, doc.id);
  check((await failure(() => changeComments(ids.owner, doc.id, { type: "createThread", body: "hi", anchor: { quote: "Second" } }))) === "notAllowed", "pages in the trash take no comments");

  console.log(`\n${passed} checks passed`);
} finally {
  setShareMailer(null);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
