/**
 * End-to-end check of following database rows against the database: who follows a row (its
 * creator, the people its person properties name, commenters, people mentioned on it, those who
 * chose to) and who doesn't (those who chose not to, agents, people who can't open it); a burst of
 * one person's edits is one notification to everyone but them, saying what changed from what to
 * what; edits by two people are two; values changed back tell nothing; a follower who may not see a
 * property isn't told about it, also when its access is narrowed after they were told; an unread
 * update by the same person is folded in; titles and body edits saved through the row's document
 * count; the email says the same. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/row-follow-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own sweep would deliver the queued updates.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { notification, page, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const databases = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { changeComments } = await import("@/server/comments");
const { listInbox, snoozeNotification } = await import("@/server/notifications");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { flushRowUpdates, isFollowing, pendingRowUpdates, setFollowing } = await import("@/server/row-follow");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { getPageHeaderInfo } = await import("@/server/page-meta");
const ops = await import("@/server/operations");
const { AccessError } = await import("@/server/access");

const RUN = `rowfollow-e2e-${Date.now().toString(36)}`;

// The real collab service: titles and bodies are saved through the row's document.
const { hocuspocus, service } = createCollab();
registerCollab(service);

const mails: { to: string; subject: string; text: string }[] = [];
setShareMailer(async (mail) => void mails.push(mail));

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
    return error instanceof AccessError;
  }
}

const ids = {
  owner: `${RUN}-owner`,
  member: `${RUN}-member`,
  commenter: `${RUN}-commenter`,
  watcher: `${RUN}-watcher`,
  mentioned: `${RUN}-mentioned`,
  outsider: `${RUN}-outsider`,
  agent: `${RUN}-agent`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** The row updates in `userId`'s inbox about `rowId`, as the inbox shows them. */
const updates = async (userId: string, rowId: string) => (await listInbox(userId, workspaceId)).filter((n) => n.kind === "row_update" && n.pageId === rowId);
/** What a shown update says, as "Property: from → to" with values by option name, person or text. */
const said = (item: Awaited<ReturnType<typeof updates>>[number]) =>
  item.rowUpdate!.changes.map((c) => {
    const text = (v: (typeof c)["from"]) =>
      v.type === "options" ? v.options.map((o) => o.name).join(",") : v.type === "text" ? v.text : v.type === "number" ? String(v.value) : v.type === "empty" ? "" : v.type;
    return `${c.property?.name ?? "Title"}: ${text(c.from)} → ${text(c.to)}`;
  });
const clearInboxes = () => db.delete(notification).where(eq(notification.workspaceId, workspaceId));

/** Waits for the row's document save to queue `actorId`'s update (saves are asynchronous). */
async function waitForPending(rowId: string, actorId: string) {
  for (let i = 0; i < 300; i++) {
    if ((await pendingRowUpdates([rowId])).some((p) => p.actorId === actorId)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the document save queued no update");
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.commenter, role: "member" },
    { workspaceId, userId: ids.watcher, role: "member" },
    { workspaceId, userId: ids.mentioned, role: "member" },
    { workspaceId, userId: ids.agent, role: "guest" },
  ]);
  await db.insert(workspaceAgent).values({ workspaceId, userId: ids.agent, name: "Helper", icon: "🤖", createdBy: ids.owner });

  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  // Members get edit access, not the workspace-wide default (full access sees every property).
  await setPagePermission(ids.owner, tasks.id, ids.owner, "full");
  await setPagePermission(ids.owner, tasks.id, null, "none");
  for (const id of [ids.member, ids.commenter, ids.watcher, ids.mentioned, ids.agent]) await setPagePermission(ids.owner, tasks.id, id, "edit");
  const props = await databases.getProperties(tasks.id);
  const status = props.find((p) => p.type === "status")!;
  const [notStarted, inProgress, done] = status.options.options!;
  const notes = await databases.addProperty(ids.owner, tasks.id, { name: "Notes", type: "text" });
  const salary = await databases.addProperty(ids.owner, tasks.id, { name: "Salary", type: "number" });
  const assignee = await databases.addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });

  const row = await createPage(actor, {
    workspaceId,
    parentId: tasks.id,
    title: "Ship it",
    properties: { [status.id]: notStarted.id, [assignee.id]: [ids.member] },
  });
  // People pickers don't offer agents; a value naming one (set some other way) mustn't tell it anything.
  const [{ properties: stored }] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, row.id));
  await db.update(page).set({ properties: { ...stored, [assignee.id]: [ids.member, ids.agent] } }).where(eq(page.id, row.id));

  // Who follows
  check((await isFollowing(ids.owner, row.id)) === true, "the row's creator follows it");
  check((await isFollowing(ids.member, row.id)) === true, "someone its person property names follows it");
  check((await isFollowing(ids.watcher, row.id)) === false, "someone else doesn't");
  check((await isFollowing(ids.owner, tasks.id)) === null, "a database itself is not a row to follow");
  check((await getPageHeaderInfo(ids.member, row.id)).following === true, "the page menu knows the assignee follows the row");
  check((await getPageHeaderInfo(ids.owner, tasks.id)).following === null, "…and offers nothing to follow on a database");
  check(await refused(() => setFollowing(ids.outsider, row.id, true)), "someone who can't open the row can't follow it");
  await setFollowing(ids.watcher, row.id, true);
  check((await isFollowing(ids.watcher, row.id)) === true, "anyone who can open it may choose to follow it");
  check((await pendingRowUpdates([row.id])).length === 0, "making a row tells no one");

  // A burst of one person's edits is one notification, to everyone but them
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: inProgress.id });
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: done.id });
  const queued = await pendingRowUpdates([row.id]);
  check(queued.length === 1 && queued[0].dueAt > new Date(), "two quick changes wait as one update, for a while", queued);
  await flushRowUpdates();
  let memberUpdates = await updates(ids.member, row.id);
  check(memberUpdates.length === 1, "the assignee gets one notification for the burst", memberUpdates);
  check(
    said(memberUpdates[0]).join("|") === `Status: ${notStarted.name} → ${done.name}` && memberUpdates[0].actorName === "owner",
    "it says what changed from the first value to the last, and who changed it",
    memberUpdates[0],
  );
  check((await updates(ids.watcher, row.id)).length === 1, "someone who chose to follow is told too");
  check((await updates(ids.owner, row.id)).length === 0, "the one who made the change isn't told about it");
  const agentInbox = await db.select().from(notification).where(and(eq(notification.userId, ids.agent), eq(notification.kind, "row_update")));
  check(agentInbox.length === 0, "an agent its person property names hears nothing");
  check((await updates(ids.commenter, row.id)).length === 0, "nor does someone who doesn't follow the row");

  // Emails say the same
  await flushShareEmails();
  const memberMail = mails.find((m) => m.to === `${ids.member}@example.test` && m.subject.includes("changed"));
  check(
    memberMail?.subject.includes("Ship it") && memberMail.text.includes(`Status: ${notStarted.name} → ${done.name}`),
    "the follower's email lists the change",
    mails.map((m) => [m.to, m.subject]),
  );
  mails.length = 0;

  // Two people at once: two updates, each told to the other
  await clearInboxes();
  await databases.updateRowProperties(ids.owner, row.id, { [notes.id]: "draft" });
  await databases.updateRowProperties(ids.member, row.id, { [notes.id]: "draft 2" });
  check((await pendingRowUpdates([row.id])).length === 2, "edits by two people wait apart");
  await flushRowUpdates();
  check((await updates(ids.owner, row.id)).map((n) => n.actorName).join() === "member", "the creator hears about the assignee's edit only");
  check((await updates(ids.member, row.id)).map((n) => n.actorName).join() === "owner", "…and the assignee about the creator's only");
  check((await updates(ids.watcher, row.id)).length === 2, "a third follower hears about both");

  // Changed back: nothing to tell
  await clearInboxes();
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: inProgress.id });
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: done.id });
  check((await pendingRowUpdates([row.id])).length === 0, "a value changed back to where it was leaves nothing waiting");
  await flushRowUpdates();
  check((await updates(ids.member, row.id)).length === 0, "…and tells no one");

  // An unread update by the same person is folded in
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: inProgress.id });
  await flushRowUpdates();
  await databases.updateRowProperties(ids.owner, row.id, { [notes.id]: "final" });
  await flushRowUpdates();
  memberUpdates = await updates(ids.member, row.id);
  check(
    memberUpdates.length === 1 && said(memberUpdates[0]).join("|") === `Status: ${done.name} → ${inProgress.name}|Notes: draft 2 → final`,
    "a second update before the first was read joins it",
    memberUpdates.map(said),
  );
  await snoozeNotification(ids.member, memberUpdates[0].id, new Date(Date.now() + 3_600_000));
  await databases.updateRowProperties(ids.owner, row.id, { [notes.id]: "final 2" });
  await flushRowUpdates();
  const afterSnooze = await db.select().from(notification).where(and(eq(notification.userId, ids.member), eq(notification.kind, "row_update")));
  check(afterSnooze.length === 2 && afterSnooze.filter((n) => n.snoozedUntil).length === 1, "a snoozed update stays snoozed; the next one comes on its own", afterSnooze);

  // Choosing not to follow wins over being assigned
  await clearInboxes();
  await setFollowing(ids.member, row.id, false);
  check((await isFollowing(ids.member, row.id)) === false, "the assignee may stop following");
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: done.id });
  await flushRowUpdates();
  check((await updates(ids.member, row.id)).length === 0, "…and then hears nothing");
  await setFollowing(ids.member, row.id, true);

  // Property access: told only about what they may see, then and when the inbox reads it
  await clearInboxes();
  await setPropertyAccess(ids.owner, salary.id, { everyone: "none", exceptions: [] });
  await databases.updateRowProperties(ids.owner, row.id, { [salary.id]: 5000, [status.id]: inProgress.id });
  await flushRowUpdates();
  memberUpdates = await updates(ids.member, row.id);
  check(memberUpdates.length === 1 && said(memberUpdates[0]).join("|") === `Status: ${done.name} → ${inProgress.name}`, "a follower isn't told about a property hidden from them", memberUpdates.map(said));
  const storedChanges = await db.select({ changes: notification.changes }).from(notification).where(and(eq(notification.userId, ids.member), eq(notification.kind, "row_update")));
  check(!JSON.stringify(storedChanges).includes("5000"), "…not even in what is stored for them", storedChanges);
  await clearInboxes();
  await databases.updateRowProperties(ids.owner, row.id, { [salary.id]: 6000 });
  await flushRowUpdates();
  check((await updates(ids.member, row.id)).length === 0, "a change only to a hidden property tells them nothing");
  await setPropertyAccess(ids.owner, salary.id, { everyone: "edit", exceptions: [] });
  await databases.updateRowProperties(ids.owner, row.id, { [salary.id]: 7000 });
  await flushRowUpdates();
  memberUpdates = await updates(ids.member, row.id);
  check(memberUpdates.length === 1 && said(memberUpdates[0]).join() === "Salary: 6000 → 7000", "once they may see it, they are told", memberUpdates.map(said));
  await setPropertyAccess(ids.owner, salary.id, { everyone: "none", exceptions: [] });
  check((await updates(ids.member, row.id)).length === 0, "narrowing the property's access later takes it out of their inbox");
  await flushShareEmails();
  check(!mails.some((m) => m.to === `${ids.member}@example.test` && m.text.includes("7000")), "…and out of the email that hadn't gone yet", mails.map((m) => m.text));
  await setPropertyAccess(ids.owner, salary.id, { everyone: "edit", exceptions: [] });
  mails.length = 0;

  // Losing access to the row: no longer told
  await clearInboxes();
  await setPagePermission(ids.owner, tasks.id, ids.watcher, "none");
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: done.id });
  await flushRowUpdates();
  const watcherRows = await db.select().from(notification).where(and(eq(notification.userId, ids.watcher), eq(notification.kind, "row_update")));
  check(watcherRows.length === 0, "a follower who can no longer open the row is told nothing");

  // Commenting and being mentioned follow the row
  await clearInboxes();
  // Mentions in Markdown name people by name.
  await getCollab().replaceContent(row.id, "Ask @mentioned about the launch plan.", actor);
  await waitForPending(row.id, ids.owner);
  check((await isFollowing(ids.mentioned, row.id)) === true, "someone mentioned on the row follows it");
  await changeComments(ids.commenter, row.id, { type: "createThread", body: "Which plan?", anchor: { quote: "launch plan" } });
  check((await isFollowing(ids.commenter, row.id)) === true, "someone who commented on it follows it");
  await flushRowUpdates();
  const bodyUpdate = (await updates(ids.member, row.id))[0];
  check(bodyUpdate?.rowUpdate?.body === true && bodyUpdate.rowUpdate.changes.length === 0, "editing the body is an update of its own", bodyUpdate);

  // Titles and bodies saved through the document (the REST API and MCP path), by someone else
  await clearInboxes();
  await ops.updateDatabaseRow({ userId: ids.member, actor: { userId: ids.member } }, { row_id: row.id, title: "Ship it now" });
  await waitForPending(row.id, ids.member);
  await flushRowUpdates();
  const renamed = await updates(ids.commenter, row.id);
  check(renamed.length === 1 && said(renamed[0]).join() === "Title: Ship it → Ship it now", "a new title tells followers from what to what", renamed.map(said));
  check((await updates(ids.mentioned, row.id)).length === 1, "…the person mentioned on it included");
  check((await updates(ids.member, row.id)).length === 0, "…but not the one who renamed it");

  // Turning the kind off keeps it out of the inbox (and so out of push)
  await setNotificationPreference(ids.commenter, "row_update", "inbox", false);
  check((await updates(ids.commenter, row.id)).length === 0, "a follower who turned row updates off in the inbox doesn't see them");
  await setNotificationPreference(ids.commenter, "row_update", "inbox", true);

  // Trash: nothing goes out about a row in the trash
  await clearInboxes();
  await databases.updateRowProperties(ids.owner, row.id, { [status.id]: notStarted.id });
  await db.update(page).set({ archivedAt: new Date() }).where(eq(page.id, row.id));
  await flushRowUpdates();
  check((await db.select().from(notification).where(eq(notification.pageId, row.id))).length === 0, "an update to a row moved to the trash before it went out tells no one");

  console.log(`\n${passed} checks passed`);
} finally {
  setShareMailer(null);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
