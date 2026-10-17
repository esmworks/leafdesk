/**
 * End-to-end check of watching pages against the database: who watches a page (its creator, the
 * people who edit it, those who chose to, people watching its teamspace) and who doesn't (those who
 * muted it, people who can't open it, people who have it open right now); an edit tells everyone
 * watching but its author, once; an unread update about the same page is replaced; database rows
 * aren't watched; a new comment thread tells the page's watchers; emails go out once per page and
 * cooldown, wait past the daily cap and then come as one digest, and follow the preferences and
 * snoozes. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/page-watch-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own sweeps would deliver the queued updates.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { notification, page, pageUpdateEmail, user, workspace, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { changeComments } = await import("@/server/comments");
const { listInbox, snoozeNotification } = await import("@/server/notifications");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { flushPageUpdates, isWatching, listWatches, pendingPageUpdates, setWatching, setWatchingTeamspace } = await import("@/server/page-watch");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { createTeamspace, joinTeamspace } = await import("@/server/teamspaces");
const { getPageHeaderInfo } = await import("@/server/page-meta");
const { PAGE_EMAIL_DAILY_CAP } = await import("@/lib/page-watch");
const ops = await import("@/server/operations");

const RUN = `pagewatch-e2e-${Date.now().toString(36)}`;

// The real collab service: bodies are saved through the page's document. Who has a page open is
// set by hand: no browser connects here.
const { hocuspocus, service } = createCollab();
const openNow = new Map<string, string[]>();
registerCollab({ ...service, openUserIds: (pageId: string) => openNow.get(pageId) ?? [] });

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

const ids = {
  owner: `${RUN}-owner`,
  editor: `${RUN}-editor`,
  watcher: `${RUN}-watcher`,
  muter: `${RUN}-muter`,
  fan: `${RUN}-fan`,
  guest: `${RUN}-guest`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const email = (id: string) => `${id}@example.test`;

/** The page updates in `userId`'s inbox about `pageId`, as the inbox shows them. */
const updates = async (userId: string, pageId: string) =>
  (await listInbox(userId, workspaceId)).filter((n) => n.kind === "page_updated" && n.pageId === pageId);
const comments = async (userId: string, pageId: string) =>
  (await listInbox(userId, workspaceId)).filter((n) => n.kind === "comment" && n.pageId === pageId);
const clearInboxes = () => db.delete(notification).where(eq(notification.workspaceId, workspaceId));
const mailsTo = (id: string) => mails.filter((m) => m.to === email(id));

/** Waits for the page's document save to queue `actorId`'s update (saves are asynchronous). */
async function waitForPending(pageId: string, actorId: string) {
  for (let i = 0; i < 300; i++) {
    if ((await pendingPageUpdates([pageId])).some((p) => p.actorId === actorId)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the document save queued no update");
}

/** `actorId` writes `markdown` as the page's body, and the save queues their update. */
async function edit(actorId: string, pageId: string, markdown: string) {
  await getCollab().replaceContent(pageId, markdown, { userId: actorId });
  await waitForPending(pageId, actorId);
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: email(id) })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.watcher, role: "member" },
    { workspaceId, userId: ids.muter, role: "member" },
    { workspaceId, userId: ids.fan, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);

  const space = await createTeamspace(ids.owner, workspaceId, { name: "Product", access: "open", memberLevel: "edit" });
  for (const id of [ids.editor, ids.watcher, ids.muter, ids.fan]) await joinTeamspace(id, space.id);
  const plan = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: space.id, title: "Launch plan", markdown: "First draft." });
  await setPagePermission(ids.owner, plan.id, ids.guest, "view");

  // Who watches
  check((await isWatching(ids.owner, plan.id)) === true, "a page's creator watches it");
  check((await isWatching(ids.editor, plan.id)) === false, "someone who hasn't touched it doesn't");
  check((await getPageHeaderInfo(ids.owner, plan.id)).watching === true, "the page menu shows the creator watching");
  await setWatching(ids.watcher, plan.id, true);
  await setWatching(ids.guest, plan.id, true);
  await setWatching(ids.muter, plan.id, false);
  await setWatchingTeamspace(ids.fan, space.id, true);
  await setWatchingTeamspace(ids.muter, space.id, true);
  check((await isWatching(ids.fan, plan.id)) === true, "watching a teamspace watches its pages");
  check((await isWatching(ids.muter, plan.id)) === false, "a mute wins over watching the teamspace");

  // Writing the new page's first draft is its creator's edit, which its teamspace's watchers hear about.
  await flushPageUpdates();
  check((await updates(ids.fan, plan.id)).map((n) => n.actorName).join() === "owner", "watchers of a teamspace hear about a new page in it");
  await clearInboxes();

  // An edit tells its watchers but its author
  await edit(ids.editor, plan.id, "Second draft, by the editor.");
  check((await isWatching(ids.editor, plan.id)) === true, "editing a page watches it");
  await flushPageUpdates();
  check((await updates(ids.owner, plan.id)).map((n) => n.actorName).join() === "editor", "the creator hears about someone else's edit");
  check((await updates(ids.watcher, plan.id)).length === 1, "someone who chose to watch hears too");
  check((await updates(ids.fan, plan.id)).length === 1, "…and someone watching the teamspace");
  check((await updates(ids.guest, plan.id)).length === 1, "…and a guest the page is shared with");
  check((await updates(ids.editor, plan.id)).length === 0, "the author doesn't hear about their own edit");
  check((await updates(ids.muter, plan.id)).length === 0, "someone who muted the page hears nothing");

  // Edits by the same person in a row are one update; an unread one is replaced, not stacked
  await edit(ids.editor, plan.id, "Third draft.");
  await edit(ids.editor, plan.id, "Fourth draft.");
  check((await pendingPageUpdates([plan.id])).length === 1, "one person's edits wait as one update");
  await flushPageUpdates();
  const ownerUpdates = await updates(ids.owner, plan.id);
  check(ownerUpdates.length === 1 && !ownerUpdates[0].read, "an unread update about the page is replaced by the newer one", ownerUpdates);

  // Muting stays through editing; watching again undoes it
  await edit(ids.muter, plan.id, "The muted member edits it.");
  check((await isWatching(ids.muter, plan.id)) === false, "editing a page someone muted doesn't watch it again");
  await flushPageUpdates();
  await setWatching(ids.muter, plan.id, true);
  check((await isWatching(ids.muter, plan.id)) === true, "watching it again undoes the mute");
  await setWatching(ids.muter, plan.id, false);

  // People who can no longer open it, or have it open, aren't told
  await clearInboxes();
  await setPagePermission(ids.owner, plan.id, ids.guest, "none");
  openNow.set(plan.id, [ids.watcher]);
  await edit(ids.owner, plan.id, "The owner edits.");
  await flushPageUpdates();
  check((await db.select().from(notification).where(and(eq(notification.userId, ids.guest), eq(notification.kind, "page_updated")))).length === 0, "a watcher who lost access isn't told");
  check((await updates(ids.watcher, plan.id)).length === 0, "a watcher with the page open isn't told (they saw it change)");
  check((await updates(ids.editor, plan.id)).length === 1, "…while the others are");
  openNow.clear();

  // Database rows are followed, not watched
  const tasks = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: space.id, kind: "database", title: "Tasks" });
  const row = await createPage({ userId: ids.owner }, { workspaceId, parentId: tasks.id, title: "A task" });
  check((await isWatching(ids.owner, row.id)) === null, "a database row isn't watched");
  await getCollab().replaceContent(row.id, "Row body.", { userId: ids.editor });
  await new Promise((r) => setTimeout(r, 500));
  check((await pendingPageUpdates([row.id])).length === 0, "editing a row queues no page update");

  // A new comment thread tells the page's watchers
  await clearInboxes();
  await changeComments(ids.editor, plan.id, { type: "createThread", body: "Is the date fixed?", anchor: { quote: "owner edits" } });
  check((await comments(ids.owner, plan.id)).length === 1, "a new thread tells the creator");
  check((await comments(ids.watcher, plan.id)).length === 1, "…and the page's other watchers");
  check((await comments(ids.fan, plan.id)).length === 1, "…people watching its teamspace included");
  check((await comments(ids.muter, plan.id)).length === 0, "…but not someone who muted it");
  check((await comments(ids.editor, plan.id)).length === 0, "…nor whoever started it");

  // Emails: one now, then a cooldown per page
  await clearInboxes();
  mails.length = 0;
  await edit(ids.editor, plan.id, "An edit for the email.");
  await flushPageUpdates();
  await flushShareEmails();
  check(mailsTo(ids.owner).length === 1 && mailsTo(ids.owner)[0].subject.includes("Launch plan"), "a watcher gets an email about the edit", mailsTo(ids.owner));
  check(mailsTo(ids.editor).length === 0, "…the author none");
  mails.length = 0;
  await edit(ids.editor, plan.id, "Another edit soon after.");
  await flushPageUpdates();
  await flushShareEmails();
  check(mailsTo(ids.owner).length === 0, "another edit within the cooldown sends no email yet");
  const [held] = await db
    .select({ emailDueAt: notification.emailDueAt })
    .from(notification)
    .where(and(eq(notification.userId, ids.owner), eq(notification.kind, "page_updated")));
  check(held?.emailDueAt && held.emailDueAt.getTime() > Date.now() + 3_600_000, "…its email waits for the cooldown to end", held);

  // Past the daily cap the rest wait, then come as one digest
  await clearInboxes();
  await db.delete(pageUpdateEmail).where(eq(pageUpdateEmail.userId, ids.owner));
  mails.length = 0;
  const other = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: space.id, title: "Budget", markdown: "Numbers." });
  const third = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: space.id, title: "Hiring", markdown: "Roles." });
  const earlier = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  await db.insert(pageUpdateEmail).values(Array.from({ length: PAGE_EMAIL_DAILY_CAP }, (_, i) => ({ userId: ids.owner, pageId: third.id, sentAt: earlier(20 - i) })));
  await edit(ids.editor, other.id, "Budget edit.");
  await flushPageUpdates();
  await flushShareEmails();
  check(mailsTo(ids.owner).length === 0, "with the day's emails used up, nothing goes out now");
  // One of the day's emails turns a day old: the held pages go out together.
  const [oldest] = await db.select().from(pageUpdateEmail).where(eq(pageUpdateEmail.userId, ids.owner)).orderBy(pageUpdateEmail.sentAt).limit(1);
  await db.update(pageUpdateEmail).set({ sentAt: earlier(25) }).where(eq(pageUpdateEmail.id, oldest.id));
  await edit(ids.editor, plan.id, "And the plan again.");
  await flushPageUpdates();
  await flushShareEmails();
  const digest = mailsTo(ids.owner);
  check(
    digest.length === 1 && digest[0].subject.startsWith("2 pages") && digest[0].text.includes("Budget") && digest[0].text.includes("Launch plan"),
    "two pages waiting past the cap come as one digest",
    digest,
  );
  const logged = await db.select().from(pageUpdateEmail).where(eq(pageUpdateEmail.userId, ids.owner));
  check(logged.filter((l) => l.pageId === other.id || l.pageId === plan.id).length === 2, "…which counts for both pages' cooldowns", logged);

  // Preferences and snoozes
  await clearInboxes();
  mails.length = 0;
  await setNotificationPreference(ids.watcher, "page_updated", "email", false);
  await edit(ids.editor, third.id, "Hiring edit.");
  await setWatching(ids.watcher, third.id, true);
  await setWatching(ids.fan, third.id, true);
  await flushPageUpdates();
  const fanUpdate = (await updates(ids.fan, third.id))[0];
  check(Boolean(fanUpdate), "a watcher of the page is told", fanUpdate);
  await snoozeNotification(ids.fan, fanUpdate.id, new Date(Date.now() + 3_600_000));
  await flushShareEmails();
  check(mailsTo(ids.watcher).length === 0, "someone who turned page-update emails off gets none");
  check(mailsTo(ids.fan).length === 0, "a snoozed update's email waits");
  await setNotificationPreference(ids.watcher, "page_updated", "inbox", false);
  check((await updates(ids.watcher, third.id)).length === 0, "turning them off in the inbox hides them there");
  await setNotificationPreference(ids.watcher, "page_updated", "inbox", true);

  // Settings list, MCP and REST
  const watched = await listWatches(ids.watcher);
  check(watched.pages.map((p) => p.title).sort().join() === "Hiring,Launch plan", "the settings list shows the pages chosen to watch", watched);
  check((await listWatches(ids.fan)).teamspaces.map((t) => t.name).join() === "Product", "…and the teamspaces watched");
  const ctx = { userId: ids.watcher, actor: { userId: ids.watcher } };
  check((await ops.getPage(ctx, { page_id: plan.id, offset: 0 })).watching === true, "get_page says the user watches it");
  await ops.watchPage(ctx, { page_id: plan.id, watching: false });
  check((await ops.getPage(ctx, { page_id: plan.id, offset: 0 })).watching === false, "watch_page mutes it");

  // Trash: nothing goes out about a page in the trash
  await clearInboxes();
  await edit(ids.editor, other.id, "Last budget edit.");
  await db.update(page).set({ archivedAt: new Date() }).where(eq(page.id, other.id));
  await flushPageUpdates();
  check((await db.select().from(notification).where(eq(notification.pageId, other.id))).length === 0, "an edit to a page moved to the trash before it went out tells no one");

  console.log(`\n${passed} checks passed`);
} finally {
  setShareMailer(null);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
