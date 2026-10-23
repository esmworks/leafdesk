/**
 * End-to-end check of a page's discussions beyond the comments themselves: the inbox notification
 * a comment's author gets when people react to it (collected into one while unread, taken back with
 * the reaction, never for one's own reactions or to agents, gone with the comment), and each
 * person's "come back later" marks and seen times of threads (their own, kept to people who can
 * open the page, gone with the thread). Creates its own users and workspace and deletes them
 * afterwards.
 *
 *   pnpm tsx scripts/discussions-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { notification, threadState, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { changeComments, listComments } = await import("@/server/comments");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { listInbox, markRead, recordReaction } = await import("@/server/notifications");
const { markThreadsSeen, setThreadMarked, threadStates } = await import("@/server/thread-state");
const { AccessError } = await import("@/server/access");
const { listComments: listCommentsOp } = await import("@/server/operations");

const RUN = `discussions-e2e-${Date.now().toString(36)}`;

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

async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch (error) {
    if (error instanceof AccessError) return true;
    throw error;
  }
}

const ids = {
  ann: `${RUN}-ann`,
  bob: `${RUN}-bob`,
  cy: `${RUN}-cy`,
  outsider: `${RUN}-outsider`,
  agent: `${RUN}-agent`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;

const reactions = (userId: string) =>
  db
    .select()
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.kind, "reaction"), eq(notification.workspaceId, workspaceId)));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.replace(`${RUN}-`, ""), email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.ann, role: "owner" },
    { workspaceId, userId: ids.bob, role: "member" },
    { workspaceId, userId: ids.cy, role: "member" },
    { workspaceId, userId: ids.agent, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  await db.insert(workspaceAgent).values({ workspaceId, userId: ids.agent, name: "Helper" });
  const doc = await createPage({ userId: ids.ann }, { workspaceId, title: "Plan" });
  await getCollab().replaceContent(doc.id, "Ship the reactions this week.\n\nSecond paragraph.", { userId: ids.ann });
  await setPagePermission(ids.ann, doc.id, ids.ann, "full");
  await setPagePermission(ids.ann, doc.id, null, "comment");

  const created = await changeComments(ids.ann, doc.id, { type: "createThread", body: "Can we ship this on Friday?", anchor: { quote: "reactions" } });
  const thread = created.thread!;
  const commentId = created.comment!.id;
  const react = (userId: string, emoji: string, type: "addReaction" | "deleteReaction" = "addReaction") =>
    changeComments(userId, doc.id, { type, threadId: thread.id, commentId, emoji });

  // Reactions tell the comment's author
  await react(ids.ann, "👍");
  check((await reactions(ids.ann)).length === 0, "reacting to one's own comment tells nobody");
  await react(ids.bob, "👍");
  let rows = await reactions(ids.ann);
  check(rows.length === 1 && rows[0].actorId === ids.bob && rows[0].commentId === commentId, "a reaction tells the comment's author", rows);
  check(rows[0].message === "Can we ship this on Friday?" && rows[0].emailDueAt === null, "…quoting the comment, and sends no email", rows[0]);
  await react(ids.cy, "🎉");
  await react(ids.bob, "🎉");
  rows = await reactions(ids.ann);
  check(rows.length === 1, "more reactions while it is unread stay one notification", rows);
  check(rows[0].actorId === ids.bob && JSON.stringify((rows[0].reactions ?? []).map((r) => ({ userId: r.userId, emoji: r.emoji }))) === JSON.stringify([
    { userId: ids.bob, emoji: "👍" },
    { userId: ids.cy, emoji: "🎉" },
    { userId: ids.bob, emoji: "🎉" },
  ]), "…listing who reacted with what, the latest last", rows[0].reactions);
  const [item] = (await listInbox(ids.ann, workspaceId)).filter((n) => n.kind === "reaction");
  check(
    item?.reaction?.commentId === commentId &&
      item.reaction.emojis.join("") === "🎉👍" &&
      item.reaction.people.map((p) => p.id).join() === [ids.bob, ids.cy].join() &&
      item.reaction.excerpt === "Can we ship this on Friday?" &&
      item.threadId === thread.id &&
      item.automationMessage === null,
    "the inbox shows the emojis, the people (latest first) and the comment",
    item,
  );

  // Taking reactions back
  await react(ids.bob, "🎉", "deleteReaction");
  rows = await reactions(ids.ann);
  check(rows.length === 1 && rows[0].actorId === ids.cy && (rows[0].reactions ?? []).length === 2, "taking a reaction back takes it out of the unread notification", rows[0]);
  await react(ids.bob, "👍", "deleteReaction");
  await react(ids.cy, "🎉", "deleteReaction");
  check((await reactions(ids.ann)).length === 0, "…and the notification away once nothing is left");

  // Read ones stay; a new reaction starts a new one
  await react(ids.bob, "👀");
  await markRead(ids.ann, workspaceId);
  await react(ids.cy, "👀");
  rows = await reactions(ids.ann);
  check(rows.length === 2 && rows.filter((r) => !r.readAt).length === 1, "after reading it, a new reaction is a new notification", rows);
  await react(ids.bob, "👀", "deleteReaction");
  check((await reactions(ids.ann)).length === 2, "…and taking back one already read leaves it");

  // Agents
  await recordReaction(ids.bob, workspaceId, { pageId: doc.id, threadId: thread.id, commentId: "agent-comment", authorId: ids.agent, emoji: "👍", excerpt: "x" });
  check((await reactions(ids.agent)).length === 0, "agents hear about no reactions to their comments");
  await recordReaction(ids.agent, workspaceId, { pageId: doc.id, threadId: thread.id, commentId: "other", authorId: ids.bob, emoji: "👍", excerpt: "Bob's" });
  check((await reactions(ids.bob)).length === 1, "…but people hear about agents' reactions");

  // A reaction someone else can't see
  await recordReaction(ids.bob, workspaceId, { pageId: doc.id, threadId: thread.id, commentId: "outsider", authorId: ids.outsider, emoji: "👍", excerpt: "x" });
  check((await db.select().from(notification).where(eq(notification.userId, ids.outsider))).length === 0, "nobody who can't open the page hears about reactions there");

  // Deleting the comment
  const reply = await changeComments(ids.bob, doc.id, { type: "addComment", threadId: thread.id, body: "Friday works." });
  await changeComments(ids.ann, doc.id, { type: "addReaction", threadId: thread.id, commentId: reply.comment!.id, emoji: "👍" });
  check((await reactions(ids.bob)).some((r) => r.commentId === reply.comment!.id), "reactions to a reply tell its author");
  await changeComments(ids.bob, doc.id, { type: "deleteComment", threadId: thread.id, commentId: reply.comment!.id });
  check(!(await reactions(ids.bob)).some((r) => r.commentId === reply.comment!.id), "deleting a comment takes back its reaction notifications");

  // Come back later
  check((await threadStates(ids.bob, doc.id)).marked.length === 0, "nothing is marked at first");
  await setThreadMarked(ids.bob, doc.id, thread.id, true);
  check((await threadStates(ids.bob, doc.id)).marked.join() === thread.id, "a person marks a thread to come back to later");
  check((await threadStates(ids.cy, doc.id)).marked.length === 0, "…for themselves only");
  const listed = await listCommentsOp({ userId: ids.bob, actor: { userId: ids.bob } }, { page_id: doc.id, include_resolved: false });
  check(listed.threads.find((t) => t.id === thread.id)?.marked === true, "list_comments says the asking user marked it", listed.threads);
  const listedByCy = await listCommentsOp({ userId: ids.cy, actor: { userId: ids.cy } }, { page_id: doc.id, include_resolved: false });
  check(listedByCy.threads.every((t) => !("marked" in t)), "…and not to others", listedByCy.threads);
  check(await refused(() => setThreadMarked(ids.outsider, doc.id, thread.id, true)), "people who can't open the page mark nothing there");
  check(await refused(() => threadStates(ids.outsider, doc.id)), "…nor read anyone's marks");
  await setThreadMarked(ids.bob, doc.id, thread.id, false);
  check((await threadStates(ids.bob, doc.id)).marked.length === 0, "taking the mark off");

  // Seen
  await markThreadsSeen(ids.bob, doc.id, [thread.id, "no-such-thread"]);
  const seen = (await threadStates(ids.bob, doc.id)).seen;
  check(Object.keys(seen).join() === thread.id, "seeing threads keeps when, for threads the page has", seen);

  // Deleting the thread
  await setThreadMarked(ids.cy, doc.id, thread.id, true);
  await changeComments(ids.ann, doc.id, { type: "deleteThread", threadId: thread.id });
  check(!(await listComments(ids.ann, doc.id)).some((t) => t.id === thread.id), "the thread is deleted");
  check((await db.select().from(threadState).where(eq(threadState.threadId, thread.id))).length === 0, "…and everyone's marks and seen times of it go too");
  check((await reactions(ids.ann)).length === 0, "…as do the reaction notifications about it, read ones too");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
process.exit(0);
