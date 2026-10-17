/**
 * End-to-end check of person properties against the database: values resolve from "me", ids,
 * emails and names; guests see only the people already assigned and can't look anyone up;
 * "me" filters show each viewer their own rows; former members keep showing where assigned;
 * people assigned by someone else get one email after the delay, queued in the database, in their
 * own language once it is known, unless they turned them off; board drags swap assignees; rows sort by assignee name; a "created by"
 * property shows each row's creator, filters on "me" and can't be written; assignments land in the
 * assignee's inbox right away and unread ones disappear when undone.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/person-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { notification, page, pendingAssignmentEmail, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, getDatabaseSnapshot, getLookups, getRow, listRows, moveRow, updateRowProperties } = await import(
  "@/server/databases"
);
const { flushAssignmentEmails, setAssignmentMailer } = await import("@/server/assignments");
const { rememberLocale } = await import("@/server/mail/locale");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { listInbox, markRead, unreadCount } = await import("@/server/notifications");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { archivePage } = await import("@/server/pages");
const { createPage } = await import("@/server/pages");
const { removePagePermission, setPagePermission } = await import("@/server/permissions");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `person-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
// Broadcasts are recorded so the inbox signal can be checked.
const broadcasts: string[] = [];
registerCollab({
  async pagesTrashed() {},
  broadcast: (channel: string, event: string) => void broadcasts.push(`${channel} ${event}`),
  async disconnectLostAccess() {},
} as unknown as Parameters<typeof registerCollab>[0]);

// Assignment and share emails are captured instead of sent.
const sent: { to: string; subject: string; text: string }[] = [];
setAssignmentMailer(async (mail) => void sent.push(mail));
setShareMailer(async (mail) => void sent.push(mail));
// A function, so a passed check on the count doesn't narrow it for the next one.
const sentCount = () => sent.length;

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

async function rejects(write: Promise<unknown>) {
  return write.then(
    () => false,
    (error: unknown) => error instanceof PropertyValueError && error.code === "invalidPerson",
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, former: `${RUN}-former`, bystander: `${RUN}-bystander` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function values(rowId: string) {
  const [row] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId));
  return row.properties;
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
    { id: ids.former, name: "Former Fatma", email: `${ids.former}@example.test` },
    { id: ids.bystander, name: "Bystander Berk", email: `${ids.bystander}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId, userId: ids.former, role: "member" },
    { workspaceId, userId: ids.bystander, role: "member" },
  ]);
  const actor = { userId: ids.owner };
  const tasks = await createPage(actor, { workspaceId, kind: "database", title: "Tasks" });
  const owner = await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });

  // Values resolve from me, ids, emails and names
  const mine = await createPage(actor, { workspaceId, parentId: tasks.id, title: "mine", properties: { Assignee: ["me"] } });
  check(same((await values(mine.id))[owner.id], [ids.owner]), "\"me\" assigns the writer", await values(mine.id));
  const theirs = await createPage(actor, {
    workspaceId,
    parentId: tasks.id,
    title: "theirs",
    properties: { Assignee: [`${ids.member}@EXAMPLE.test`, "former fatma", ids.member] },
  });
  check(
    same((await values(theirs.id))[owner.id], [ids.member, ids.former]),
    "emails and names resolve to user ids, duplicates dropped",
    await values(theirs.id),
  );
  check(await rejects(updateRowProperties(ids.owner, mine.id, { Assignee: ["someone@else.test"] })), "someone outside the workspace is refused");

  // "me" filters show each viewer their own rows
  const meFilter = { filters: [{ propertyId: owner.id, op: "contains" as const, value: "me" }] };
  const titles = async (userId: string) => (await listRows(userId, tasks.id, meFilter)).map((r) => r.title);
  check(same(await titles(ids.owner), ["mine"]), "the owner's \"me\" view lists the owner's rows");
  check(same(await titles(ids.member), ["theirs"]), "the member's \"me\" view lists the member's rows");

  // Owners and members see everyone; guests only who is assigned
  const snapshot = await getDatabaseSnapshot(ids.owner, tasks.id);
  check(
    snapshot.viewerId === ids.owner && same(snapshot.people.map((p) => p.id).sort(), [...userIds].sort()),
    "the owner's snapshot lists everyone in the workspace",
    snapshot.people,
  );
  check(snapshot.people.every((p) => p.email && p.active), "…with emails, all active");

  await setPagePermission(ids.owner, tasks.id, ids.guest, "edit");
  const guestPeople = (await getDatabaseSnapshot(ids.guest, tasks.id)).people;
  check(
    same(guestPeople.map((p) => p.id).sort(), [ids.former, ids.guest, ids.member, ids.owner].sort()),
    "a guest sees themselves and the people assigned in rows they can see, no one else",
    guestPeople,
  );
  check(
    guestPeople.every((p) => (p.id === ids.guest ? p.email !== null : p.email === null)),
    "…and no one's email but their own",
    guestPeople,
  );
  check(await rejects(updateRowProperties(ids.guest, mine.id, { Assignee: [`${ids.owner}@example.test`] })), "a guest can't look people up by email");
  await updateRowProperties(ids.guest, mine.id, { Assignee: [ids.owner, "me"] });
  check(same((await values(mine.id))[owner.id], [ids.owner, ids.guest]), "…but can assign by id and assign themselves");

  // Former members keep showing where assigned
  await db.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.former)));
  const afterLeave = (await getRow(ids.owner, theirs.id)).people;
  const former = afterLeave.find((p) => p.id === ids.former);
  check(former && !former.active && former.name === "Former Fatma", "someone who left shows as inactive where assigned", afterLeave);
  await updateRowProperties(ids.owner, theirs.id, { Assignee: [ids.former, ids.member, "me"] });
  check(
    same((await values(theirs.id))[owner.id], [ids.former, ids.member, ids.owner]),
    "…and keeping them while editing the cell doesn't fail",
  );
  check(
    await rejects(updateRowProperties(ids.owner, mine.id, { Assignee: [ids.former] })),
    "…but they can't be newly assigned",
  );

  // MCP lookups name people for output and filters
  const lookups = await getLookups(ids.member, snapshot.properties);
  check(
    lookups.people.some((p) => p.id === ids.owner && p.name === "Owner Olcay") && same(lookups.relations, {}),
    "MCP lookups carry the people with their names",
    lookups,
  );

  // Assignment emails: one per person assigned by someone else, after the delay
  await flushAssignmentEmails();
  sent.length = 0;
  const job = await createPage(actor, {
    workspaceId,
    parentId: tasks.id,
    title: "Notify me",
    properties: { Assignee: [ids.member, "me"] },
  });
  check(sentCount() === 0, "nothing is emailed before the delay");
  const queued = await db.select().from(pendingAssignmentEmail).where(eq(pendingAssignmentEmail.rowId, job.id));
  check(
    queued.length === 1 && queued[0].userId === ids.member && queued[0].dueAt.getTime() > Date.now(),
    "…it waits in the database, so a restart doesn't lose it",
    queued,
  );
  await flushAssignmentEmails();
  check(
    sentCount() === 1 && sent[0].to === `${ids.member}@example.test` && sent[0].text.includes(job.id),
    "the assignee gets one email with a link to the row; the assigner none",
    sent,
  );
  sent.length = 0;
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.member, ids.owner, ids.bystander] });
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.member, ids.owner] });
  await flushAssignmentEmails();
  check(sentCount() === 0, "someone unassigned again before the delay gets no email", sent);
  await updateRowProperties(ids.member, job.id, { Assignee: [ids.member, ids.owner, ids.bystander] });
  await updateRowProperties(ids.bystander, job.id, { Assignee: [ids.member, ids.owner] });
  await updateRowProperties(ids.bystander, job.id, { Assignee: [ids.member, ids.owner, "me"] });
  await flushAssignmentEmails();
  check(sentCount() === 0, "…even if they re-add themselves before it goes out", sent);

  // Board drags on a person board swap the column's person
  sent.length = 0;
  await moveRow(ids.owner, job.id, { groupBy: owner.id, groupFrom: ids.member, groupValue: ids.guest });
  check(
    same((await values(job.id))[owner.id], [ids.guest, ids.owner, ids.bystander]),
    "dragging a card to another person's column swaps that person in",
    await values(job.id),
  );
  await flushAssignmentEmails();
  check(sentCount() === 1 && sent[0].to === `${ids.guest}@example.test`, "…and emails them", sent);
  check(
    await rejects(moveRow(ids.owner, job.id, { groupBy: owner.id, groupFrom: ids.guest, groupValue: ids.former })),
    "a card can't be dragged to someone who left",
  );
  await moveRow(ids.owner, job.id, { groupBy: owner.id, groupFrom: ids.owner, groupValue: null });
  check(!(owner.id in (await values(job.id))), "dropping it on the no-person column unassigns everyone");

  // No email to someone who can't open the row by the time it goes out
  sent.length = 0;
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.guest] });
  await removePagePermission(ids.owner, tasks.id, ids.guest);
  await flushAssignmentEmails();
  check(sentCount() === 0, "someone who lost access before the delay gets no email", sent);

  // People who turned assignment emails off get none, including ones already queued
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.member] });
  await setNotificationPreference(ids.member, "assignment", "email", false);
  await flushAssignmentEmails();
  check(sentCount() === 0, "turning assignment emails off drops the queued one", sent);
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.bystander] });
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.member, ids.bystander] });
  await flushAssignmentEmails();
  check(
    sentCount() === 1 && sent[0].to === `${ids.bystander}@example.test`,
    "…and no new ones arrive, while others still get theirs",
    sent,
  );
  sent.length = 0;
  await setNotificationPreference(ids.member, "assignment", "email", true);
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.bystander] });
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.bystander, ids.member] });
  await flushAssignmentEmails();
  check(sentCount() === 1 && sent[0].to === `${ids.member}@example.test`, "turning them back on works", sent);
  check(sent.at(0)?.subject === "Owner Olcay assigned you to “Notify me”", "…in the assigner's language while the assignee's isn't known", sent[0].subject);

  // In the assignee's language once it is known, whatever the assigner's (English outside a request)
  sent.length = 0;
  await rememberLocale(ids.member, "tr");
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.bystander] });
  await updateRowProperties(ids.owner, job.id, { Assignee: [ids.bystander, ids.member] });
  const [queuedFor] = await db
    .select({ locale: pendingAssignmentEmail.locale })
    .from(pendingAssignmentEmail)
    .where(and(eq(pendingAssignmentEmail.rowId, job.id), eq(pendingAssignmentEmail.userId, ids.member)));
  check(queuedFor?.locale === "en", "the email is queued in the assigner's language", queuedFor);
  await flushAssignmentEmails();
  check(
    sentCount() === 1 && sent.at(0)?.subject === "Owner Olcay sizi “Notify me” işine atadı",
    "…and goes out in Turkish to an assignee who uses Turkish",
    sent,
  );
  await rememberLocale(ids.member, "en");

  // Sorting by a person property orders rows by the assignees' names
  const byName = await listRows(ids.owner, tasks.id, { sorts: [{ propertyId: owner.id, direction: "asc" }] });
  check(
    same(
      byName.map((r) => r.title),
      ["Notify me", "theirs", "mine"],
    ),
    "rows sort by the first assignee's name (Bystander, Former, Owner)",
    byName.map((r) => [r.title, r.properties[owner.id]]),
  );

  // "Created by" shows who created each row and can't be changed
  const creator = await addProperty(ids.owner, tasks.id, { name: "Created by", type: "created_by" });
  const theirsToo = await createPage({ userId: ids.member }, { workspaceId, parentId: tasks.id, title: "member made" });
  const createdBy = async (userId: string) =>
    (await listRows(userId, tasks.id, { filters: [{ propertyId: creator.id, op: "contains", value: "me" }] })).map((r) => r.title);
  check(same(await createdBy(ids.member), ["member made"]), "\"created by me\" lists the rows the viewer created");
  const snap = await getDatabaseSnapshot(ids.owner, tasks.id);
  check(
    same(snap.rows.find((r) => r.id === theirsToo.id)?.properties[creator.id], [ids.member]) &&
      same(snap.rows.find((r) => r.id === mine.id)?.properties[creator.id], [ids.owner]),
    "rows carry their creator without it being stored",
    snap.rows.map((r) => [r.title, r.properties[creator.id]]),
  );
  check(!(creator.id in (await values(theirsToo.id))), "…nothing is written to the row for it");
  check(
    same((await getRow(ids.owner, theirsToo.id)).row.properties[creator.id], [ids.member]),
    "the row panel shows the creator too",
  );
  const readOnly = (write: Promise<unknown>) =>
    write.then(
      () => false,
      (error: unknown) => error instanceof PropertyValueError && error.code === "readOnlyProperty",
    );
  check(await readOnly(updateRowProperties(ids.owner, theirsToo.id, { "Created by": ["me"] })), "the creator can't be overwritten");
  check(
    await readOnly(moveRow(ids.owner, theirsToo.id, { groupBy: creator.id, groupFrom: ids.member, groupValue: ids.owner })),
    "…not even by dragging the card to someone else's column",
  );
  check(await readOnly(createPage(actor, { workspaceId, parentId: tasks.id, title: "x", properties: { "Created by": [ids.member] } })), "…or when creating a row");

  // Inbox: assignments by someone else show up right away, unread ones go away when undone
  broadcasts.length = 0;
  const inboxJob = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Inbox job", properties: { Assignee: [ids.member, "me"] } });
  check(broadcasts.includes(`ws:${workspaceId} inbox`), "open sidebars in the workspace are told to refetch their inbox", broadcasts);
  const aboutJob = async (userId: string) => (await listInbox(userId, workspaceId)).filter((n) => n.pageId === inboxJob.id);
  const [first] = await aboutJob(ids.member);
  check(
    first && !first.read && first.actorName === "Owner Olcay" && first.propertyName === "Assignee" && first.databaseTitle === "Tasks",
    "the assignee gets an unread inbox notification naming who, where and which property",
    await aboutJob(ids.member),
  );
  check((await aboutJob(ids.owner)).length === 0, "…the assigner gets none for assigning themselves");
  const unreadBefore = await unreadCount(ids.member, workspaceId);
  await updateRowProperties(ids.owner, inboxJob.id, { Assignee: [ids.owner] });
  check(
    (await aboutJob(ids.member)).length === 0 && (await unreadCount(ids.member, workspaceId)) === unreadBefore - 1,
    "unassigning before it was read takes the notification back",
  );
  await updateRowProperties(ids.owner, inboxJob.id, { Assignee: [ids.owner, ids.member] });
  const [again] = await aboutJob(ids.member);
  await markRead(ids.member, workspaceId, [again.id]);
  check((await aboutJob(ids.member))[0]?.read === true, "opening one marks it read");
  await updateRowProperties(ids.owner, inboxJob.id, { Assignee: [ids.owner] });
  check((await aboutJob(ids.member)).length === 1, "…and a read one stays after unassigning");
  await markRead(ids.member, workspaceId);
  check((await unreadCount(ids.member, workspaceId)) === 0, "mark all as read clears the count");
  await updateRowProperties(ids.owner, inboxJob.id, { Assignee: [ids.owner, ids.bystander] });
  check((await aboutJob(ids.bystander)).length === 1, "…before the row goes to the trash");
  // The guest lost access to the database earlier: assigned or not, the row stays out of their inbox.
  await updateRowProperties(ids.owner, inboxJob.id, { Assignee: [ids.owner, ids.bystander, ids.guest] });
  check((await aboutJob(ids.guest)).length === 0, "notifications about rows someone can't open are hidden");
  await archivePage(ids.owner, inboxJob.id);
  check((await aboutJob(ids.bystander)).length === 0, "notifications about trashed rows are hidden");
  check(
    await listInbox(ids.former, workspaceId).then(
      () => false,
      () => true,
    ),
    "someone outside the workspace can't read its inbox",
  );

  // Assignments can be kept out of the inbox
  const quiet = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Quiet job" });
  await setNotificationPreference(ids.member, "assignment", "inbox", false);
  await updateRowProperties(ids.owner, quiet.id, { Assignee: [ids.member] });
  const aboutQuiet = async () => (await listInbox(ids.member, workspaceId)).filter((n) => n.pageId === quiet.id);
  check((await aboutQuiet()).length === 0 && (await unreadCount(ids.member, workspaceId)) === 0, "turning assignments off in the inbox hides them and their count");
  await setNotificationPreference(ids.member, "assignment", "inbox", true);
  check((await aboutQuiet()).length === 1, "…and turning it back on shows the ones made meanwhile");
  await markRead(ids.member, workspaceId);
  await flushAssignmentEmails();
  sent.length = 0;

  // A row shared on its own: the guest, who can't open the database, isn't told its name
  const loose = await createPage(actor, { workspaceId, parentId: tasks.id, title: "Loose job" });
  await setPagePermission(ids.owner, loose.id, ids.guest, "edit");
  await updateRowProperties(ids.owner, loose.id, { Assignee: [ids.guest] });
  const [looseItem] = (await listInbox(ids.guest, workspaceId)).filter((n) => n.pageId === loose.id && n.kind === "assignment");
  check(
    looseItem && looseItem.databaseTitle === null && looseItem.propertyName === "Assignee",
    "an assignee who can open the row but not its database gets the notice without the database's name",
    looseItem,
  );
  await flushAssignmentEmails();
  const looseMail = sent.find((m) => m.to === `${ids.guest}@example.test`);
  check(looseMail && looseMail.subject.includes("Loose job") && !JSON.stringify(looseMail).includes("Tasks"), "…nor in the email", looseMail);
  await markRead(ids.guest, workspaceId);
  await flushShareEmails();
  sent.length = 0;

  // Sharing a page with someone tells them, in the inbox and a little later by email
  const doc = await createPage(actor, { workspaceId, title: "Roadmap" });
  const aboutDoc = async (userId: string) => (await listInbox(userId, workspaceId)).filter((n) => n.pageId === doc.id);
  broadcasts.length = 0;
  await setPagePermission(ids.owner, doc.id, ids.member, "edit");
  const [shared] = await aboutDoc(ids.member);
  check(
    shared?.kind === "page_shared" && !shared.read && shared.actorName === "Owner Olcay" && shared.pageTitle === "Roadmap" && shared.databaseTitle === null,
    "sharing a page with a member puts it in their inbox",
    await aboutDoc(ids.member),
  );
  check(broadcasts.includes(`ws:${workspaceId} inbox`), "…and tells their sidebar", broadcasts);
  check(sentCount() === 0, "…but emails only after the delay", sent);
  await flushShareEmails();
  check(
    sentCount() === 1 &&
      sent[0].to === `${ids.member}@example.test` &&
      sent[0].subject === "Owner Olcay shared “Roadmap” with you" &&
      // What they can actually do: members already had full access through everyone's default.
      sent[0].text.includes("You can now view, edit and share “Roadmap”") &&
      sent[0].text.includes(`/w/${workspaceId}/p/${doc.id}`),
    "the email names who shared which page, what they can do and links to it",
    sent,
  );
  sent.length = 0;
  await flushShareEmails();
  check(sentCount() === 0, "…and goes out once", sent);
  await setPagePermission(ids.owner, doc.id, ids.member, "view");
  check((await aboutDoc(ids.member)).map((n) => n.id).join() === shared.id, "lowering the level adds nothing");
  await setPagePermission(ids.owner, doc.id, ids.member, "full");
  const raised = await aboutDoc(ids.member);
  check(raised.length === 1 && raised[0].id !== shared.id, "raising it again leaves one unread notification", raised);
  await removePagePermission(ids.owner, doc.id, ids.member);
  check((await aboutDoc(ids.member)).length === 0, "removing the share before it was read takes it back");
  await flushShareEmails();
  check(sentCount() === 0, "…with its email", sent);
  await setPagePermission(ids.owner, doc.id, ids.member, "edit");
  await setPagePermission(ids.owner, doc.id, ids.member, "none");
  const left = await db
    .select({ id: notification.id })
    .from(notification)
    .where(and(eq(notification.pageId, doc.id), eq(notification.userId, ids.member)));
  check(left.length === 0, "setting it to no access takes it back too", left);
  await flushShareEmails();
  check(sentCount() === 0, "…with its email", sent);
  await removePagePermission(ids.owner, doc.id, ids.member);

  await setPagePermission(ids.owner, doc.id, ids.owner, "full");
  await setPagePermission(ids.owner, doc.id, null, "view");
  check(
    (await aboutDoc(ids.owner)).length === 0 && (await aboutDoc(ids.bystander)).length === 0,
    "sharing with yourself or with everyone notifies nobody",
  );

  // A guest who read it in the inbox gets no email; a member who turned the inbox off still does
  await setPagePermission(ids.owner, doc.id, ids.guest, "view");
  const [guestShare] = await aboutDoc(ids.guest);
  check(guestShare?.kind === "page_shared", "a guest sees a page shared with them in their inbox");
  await markRead(ids.guest, workspaceId, [guestShare.id]);
  await setNotificationPreference(ids.bystander, "page_shared", "inbox", false);
  await setPagePermission(ids.owner, doc.id, ids.bystander, "edit");
  check((await aboutDoc(ids.bystander)).length === 0, "turning shares off in the inbox hides them");
  await flushShareEmails();
  check(
    sentCount() === 1 && sent[0].to === `${ids.bystander}@example.test`,
    "…the email still comes, but not to someone who already read it",
    sent,
  );
  sent.length = 0;
  await setNotificationPreference(ids.bystander, "page_shared", "inbox", true);
  check((await aboutDoc(ids.bystander)).length === 1, "turning shares back on in the inbox shows it");

  await setNotificationPreference(ids.member, "page_shared", "email", false);
  await setPagePermission(ids.owner, doc.id, ids.member, "edit");
  await flushShareEmails();
  check(sentCount() === 0 && (await aboutDoc(ids.member)).length === 1, "turning share emails off keeps only the inbox notification", sent);
  await setNotificationPreference(ids.member, "page_shared", "email", true);
  await setPagePermission(ids.owner, doc.id, ids.member, "full");
  await setNotificationPreference(ids.member, "page_shared", "email", false);
  const waiting = await db
    .select({ due: notification.emailDueAt })
    .from(notification)
    .where(and(eq(notification.pageId, doc.id), eq(notification.userId, ids.member)));
  check(waiting.length === 1 && waiting[0].due === null, "…and drops share emails already queued", waiting);
  await flushShareEmails();
  check(sentCount() === 0, "…so none goes out", sent);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
