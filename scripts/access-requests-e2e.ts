/**
 * End-to-end check of requests for access against the database: the "You don't have access" screen
 * gives away nothing about the page and looks the same for a page that doesn't exist; a request
 * reaches only the people with full access (inbox and email) and is stored once; people are rate
 * limited, whatever they ask for; approving shares the page with a member, or brings someone from
 * outside in as a guest when the guest invite policy lets the approver; declining drops the request
 * and tells the requester without naming the page; emails go out in the recipient's stored
 * language rather than the actor's; someone who can view a page asks for comment or edit access from
 * its Share menu, keeps one request per page, and is answered at a level above what they have
 * (a request answered some other way leaves every list); the workspace setting turns requests off.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/access-requests-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const { db } = await import("@/db");
const { accessRequest, auditEvent, notification, page, user, userPreference, workspace, workspaceMember } = await import("@/db/schema");
const { default: pageMessages } = await import("@/i18n/messages/en/page.json");
const { default: commonMessages } = await import("@/i18n/messages/en/common.json");
const { ACCESS_REQUEST_LIMIT } = await import("@/lib/access-requests");
const { NoAccess } = await import("@/components/page/no-access");
const { registerCollab } = await import("@/server/collab/bridge");
const { AccessError, findMembership, resolvePageAccess } = await import("@/server/access");
const {
  AccessRequestError,
  accessRequestsOffered,
  approveAccessRequest,
  countAccessRequests,
  declineAccessRequest,
  listAccessRequests,
  pendingRequestOf,
  requestMoreAccess,
  requestPageAccess,
  resetAccessRequestLimits,
} = await import("@/server/access-requests");
const { accessDeclinedEmail, accessRequestEmail } = await import("@/server/mail");
const { rememberLocale } = await import("@/server/mail/locale");
const { listInbox, unreadCount } = await import("@/server/notifications");
const { setNotificationPreference } = await import("@/server/notification-preferences");
const { getPageHeaderInfo } = await import("@/server/page-meta");
const { getPage } = await import("@/server/pages");
const { PermissionError, setPagePermission } = await import("@/server/permissions");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { updateWorkspaceSettings } = await import("@/server/workspaces");

const RUN = `access-requests-e2e-${Date.now().toString(36)}`;

// Writes notify open editors and sidebars through the collab service, which only runs inside the
// app server. Broadcasts are recorded so the inbox signal can be checked.
const broadcasts: string[] = [];
registerCollab({
  async pagesTrashed() {},
  broadcast: (channel: string, event: string) => void broadcasts.push(`${channel} ${event}`),
  async disconnectUser() {},
  async disconnectLostAccess() {},
} as unknown as Parameters<typeof registerCollab>[0]);

// Emails are captured instead of sent.
const sent: { to: string; subject: string; text: string; html: string }[] = [];
setShareMailer(async (mail) => void sent.push(mail));
const mailTo = (email: string) => sent.filter((m) => m.to === email);

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

async function rejects(fn: () => Promise<unknown>, test: (error: unknown) => boolean, label: string) {
  try {
    await fn();
  } catch (error) {
    check(test(error), label, String(error));
    return;
  }
  check(false, label, "did not throw");
}

const isAccessError = (error: unknown) => error instanceof AccessError;
const isCode = (code: string) => (error: unknown) => error instanceof PermissionError && error.code === code;

const ids = {
  owner: `${RUN}-owner`,
  alice: `${RUN}-alice`,
  bob: `${RUN}-bob`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
  stranger: `${RUN}-stranger`,
  spammer: `${RUN}-spammer`,
};
const emailOf = (id: string) => `${id}@example.test`;
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const workspaceName = `Workspace ${RUN}`;
const missing = `${RUN}-no-such-page`;

/**
 * What the page route shows `userId` for /w/<workspaceId>/p/<pageId>: null when they can open the
 * page, else the "You don't have access" screen as HTML, decided the way the route decides it.
 */
async function screen(userId: string, urlWorkspaceId: string, pageId: string) {
  const found = await getPage(userId, pageId).catch((error: unknown) => {
    if (error instanceof AccessError) return null;
    throw error;
  });
  if (found) return null;
  const canRequest = await accessRequestsOffered(urlWorkspaceId);
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      timeZone: "UTC",
      messages: { page: pageMessages, common: commonMessages },
      children: createElement(NoAccess, { pageId, email: emailOf(userId), canRequest }),
    }),
  );
}

const requestsFor = (pageId: string) => db.select().from(accessRequest).where(eq(accessRequest.pageId, pageId));
const requestNotifications = (pageId: string) =>
  db
    .select({ userId: notification.userId, accessRequestId: notification.accessRequestId })
    .from(notification)
    .where(and(eq(notification.kind, "access_request"), eq(notification.pageId, pageId)));

let failed = false;
try {
  // Verified addresses: approving someone outside the workspace adds only such an account (see sharePageByEmail).
  await db
    .insert(user)
    .values(userIds.map((id) => ({ id, name: `Name ${id.slice(RUN.length + 1)}`, email: emailOf(id), emailVerified: true })));
  await db.insert(workspace).values({ id: workspaceId, name: workspaceName });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.alice, role: "member" },
    { workspaceId, userId: ids.bob, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const P = (name: string, extra: Partial<typeof page.$inferInsert> = {}) => ({
    id: `${RUN}-${name}`,
    workspaceId,
    title: `${name} title ${RUN}`,
    icon: "🦉",
    position: 1,
    ...extra,
  });
  await db.insert(page).values([P("secret"), P("plan"), P("trashed", { archivedAt: new Date() }), P("open")]);
  const [secret, plan, trashed, open] = ["secret", "plan", "trashed", "open"].map((name) => `${RUN}-${name}`);
  const { owner, alice, bob, guest, outsider, stranger, spammer } = ids;

  // The secret page is the owner's alone; the plan is managed by the owner and alice, viewed by members.
  await setPagePermission(owner, secret, owner, "full");
  await setPagePermission(owner, secret, null, "none");
  await setPagePermission(owner, plan, owner, "full");
  await setPagePermission(owner, plan, alice, "full");
  await setPagePermission(owner, plan, null, "view");
  sent.length = 0;

  // The screen gives nothing away
  const forSecret = await screen(bob, workspaceId, secret);
  check(forSecret !== null, "a member who can't see a page gets the no-access screen instead of the page");
  for (const leak of ["secret title", "🦉", workspaceName]) {
    check(!forSecret.includes(leak), `the screen doesn't show the page's title, icon or workspace (${leak.slice(0, 12)})`, forSecret);
  }
  check(forSecret.includes("Request access"), "the screen offers to ask for access");
  check((await screen(outsider, workspaceId, secret)) === forSecret.replace(emailOf(bob), emailOf(outsider)), "someone outside the workspace gets the same screen");

  // A page that doesn't exist looks the same
  check((await screen(bob, workspaceId, missing)) === forSecret, "a page that doesn't exist gets exactly the same screen");
  check(
    (await screen(bob, `${RUN}-no-such-workspace`, missing)) === forSecret,
    "…in a workspace that doesn't exist too",
  );
  const errors = await Promise.all(
    [secret, missing].map((id) => getPage(bob, id).then(() => null, (error: unknown) => error)),
  );
  check(
    errors.every((e) => e instanceof AccessError) && (errors[0] as Error).message === (errors[1] as Error).message,
    "loading either page fails the same way",
  );
  check((await requestPageAccess(bob, missing, "please")) === "sent", "asking for a page that doesn't exist answers \"sent\"");
  check((await db.select().from(accessRequest).where(eq(accessRequest.requesterId, bob))).length === 0, "…and stores nothing");
  check((await requestPageAccess(stranger, trashed)) === "sent", "asking for a page in the trash answers \"sent\"");
  check((await requestsFor(trashed)).length === 0, "…and stores nothing");
  check((await requestPageAccess(bob, plan)) === "sent", "asking for a page you can already open answers \"sent\"");
  check((await requestsFor(plan)).length === 0, "…and stores nothing");

  // Only the people with full access hear about it
  broadcasts.length = 0;
  check((await requestPageAccess(outsider, plan, "  Need the Q3 numbers  ")) === "sent", "someone outside the workspace can ask");
  const [planRequest] = await requestsFor(plan);
  check(planRequest?.requesterId === outsider && planRequest.message === "Need the Q3 numbers", "the request is stored with its message", planRequest);
  const notified = (await requestNotifications(plan)).map((n) => n.userId).sort();
  check(JSON.stringify(notified) === JSON.stringify([alice, owner].sort()), "only the people with full access are notified", notified);
  check(broadcasts.includes(`ws:${workspaceId} inbox`), "the workspace's sidebars refetch their inbox");
  const [ownerItem] = (await listInbox(owner, workspaceId)).filter((i) => i.kind === "access_request");
  check(
    ownerItem?.pageId === plan &&
      ownerItem.actorName === "Name outsider" &&
      ownerItem.accessRequest?.id === planRequest.id &&
      ownerItem.accessRequest.requesterEmail === emailOf(outsider) &&
      ownerItem.accessRequest.message === "Need the Q3 numbers" &&
      !ownerItem.accessRequest.inWorkspace &&
      ownerItem.accessRequest.approvable,
    "the owner's inbox shows who asked, their message, and that approving brings them in",
    ownerItem,
  );
  const [aliceItem] = (await listInbox(alice, workspaceId)).filter((i) => i.kind === "access_request");
  check(aliceItem?.accessRequest?.approvable === false, "a member who may not invite guests sees they can't approve someone from outside");
  check((await listInbox(bob, workspaceId)).every((i) => i.kind !== "access_request"), "a member who can only view the page isn't told");
  check((await unreadCount(owner, workspaceId)) === 1, "the request counts as unread");
  check((await getPageHeaderInfo(owner, plan)).accessRequests === 1, "the page header counts the request for those who can answer it");
  check((await getPageHeaderInfo(bob, plan)).accessRequests === 0, "…and not for anyone else");
  const listed = await listAccessRequests(alice, plan);
  check(listed.length === 1 && listed[0].email === emailOf(outsider) && !listed[0].approvable, "the share panel lists the request", listed);
  await rejects(() => listAccessRequests(bob, plan), isAccessError, "people without full access can't list requests");
  await rejects(() => listAccessRequests(outsider, plan), isAccessError, "the requester can't list them either");
  await flushShareEmails();
  const requestMails = sent.filter((m) => m.subject.includes("asked for access"));
  check(
    JSON.stringify(requestMails.map((m) => m.to).sort()) === JSON.stringify([emailOf(alice), emailOf(owner)].sort()),
    "the people with full access get an email",
    requestMails.map((m) => m.to),
  );
  check(requestMails.every((m) => m.text.includes("Need the Q3 numbers") && m.text.includes(emailOf(outsider))), "…with the requester and their message");
  check(mailTo(emailOf(outsider)).length === 0, "the requester gets nothing yet");

  // Asking again changes nothing
  sent.length = 0;
  check((await requestPageAccess(outsider, plan, "again?")) === "sent", "asking again answers \"sent\"");
  const again = await requestsFor(plan);
  check(again.length === 1 && again[0].id === planRequest.id && again[0].message === "Need the Q3 numbers", "…keeps the one pending request", again);
  check((await requestNotifications(plan)).length === 2, "…and notifies nobody again");
  await flushShareEmails();
  check(sent.length === 0, "…nor emails anyone");

  // Emails follow the preference
  await setNotificationPreference(owner, "access_request", "email", false);
  await requestPageAccess(stranger, plan);
  await flushShareEmails();
  check(mailTo(emailOf(owner)).length === 0 && mailTo(emailOf(alice)).length === 1, "someone who turned these emails off gets none");
  await setNotificationPreference(owner, "access_request", "inbox", false);
  check((await listInbox(owner, workspaceId)).every((i) => i.kind !== "access_request"), "…and with the inbox off, they leave the inbox");
  await setNotificationPreference(owner, "access_request", "inbox", true);
  await setNotificationPreference(owner, "access_request", "email", true);

  // The rate limit counts every ask, whatever the page
  resetAccessRequestLimits();
  const answers: string[] = [];
  for (let i = 0; i < ACCESS_REQUEST_LIMIT.count; i++) answers.push(await requestPageAccess(spammer, i % 2 ? missing : open));
  check(answers.every((a) => a === "sent"), `${ACCESS_REQUEST_LIMIT.count} asks within the hour go through`, answers);
  check((await requestPageAccess(spammer, missing)) === "rateLimited", "the next one is refused for a page that doesn't exist…");
  check((await requestPageAccess(spammer, secret)) === "rateLimited", "…and for one that does, the same way");
  check((await requestsFor(secret)).every((r) => r.requesterId !== spammer), "a refused ask stores nothing");
  check((await requestsFor(open)).length === 1, "the asks that went through stored one request");
  check((await requestPageAccess(outsider, secret)) === "sent", "the limit is per person");
  resetAccessRequestLimits();

  // Approving for a member
  await flushShareEmails();
  sent.length = 0;
  check((await requestPageAccess(bob, secret, "for the review")) === "sent", "a member asks for the owner's page");
  const [bobRequest] = (await requestsFor(secret)).filter((r) => r.requesterId === bob);
  check((await requestNotifications(secret)).filter((n) => n.accessRequestId === bobRequest.id).map((n) => n.userId).join() === owner, "only the owner is told");
  const bobListed = (await listAccessRequests(owner, secret)).find((r) => r.requesterId === bob);
  check(bobListed?.inWorkspace === true && bobListed.approvable, "a member's request shows they are in the workspace", bobListed);
  await rejects(() => approveAccessRequest(bob, bobRequest.id, "full"), isAccessError, "the requester can't approve their own request");
  await rejects(() => approveAccessRequest(alice, bobRequest.id, "view"), isAccessError, "someone without full access can't approve it");
  await rejects(() => declineAccessRequest(alice, bobRequest.id), isAccessError, "…or decline it");
  await rejects(() => approveAccessRequest(owner, `${RUN}-no-such-request`, "view"), isAccessError, "an unknown request is refused");
  await approveAccessRequest(owner, bobRequest.id, "comment");
  check((await resolvePageAccess(bob, secret)).level === "comment", "approving gives the member the level picked");
  check((await requestsFor(secret)).every((r) => r.id !== bobRequest.id), "the request is gone");
  check((await requestNotifications(secret)).every((n) => n.accessRequestId !== bobRequest.id), "…and so are its notifications");
  check((await listInbox(bob, workspaceId)).some((i) => i.kind === "page_shared" && i.pageId === secret), "the member finds the page in their inbox");
  await flushShareEmails();
  const bobMail = mailTo(emailOf(bob));
  check(bobMail.length === 1 && bobMail[0].subject.includes("secret title") && bobMail[0].text.includes("view and comment on"), "they get one email, saying what they can do now", bobMail);
  check((await screen(bob, workspaceId, secret)) === null, "the page opens for them now");

  // Approving for someone outside the workspace
  sent.length = 0;
  await rejects(
    () => approveAccessRequest(alice, planRequest.id, "view"),
    isCode("invitesRestricted"),
    "a member can't bring someone in while only owners may invite guests",
  );
  check((await findMembership(outsider, workspaceId)) === null, "…the outsider stays outside");
  check((await requestsFor(plan)).some((r) => r.id === planRequest.id), "…and the request stays pending");
  await approveAccessRequest(owner, planRequest.id, "view");
  check((await findMembership(outsider, workspaceId))?.role === "guest", "an owner's approval brings them in as a guest");
  check((await resolvePageAccess(outsider, plan)).level === "view", "…with the level picked");
  check((await resolvePageAccess(outsider, secret)).level === "none", "…and nothing else");
  check((await requestNotifications(plan)).every((n) => n.accessRequestId !== planRequest.id), "everyone's notification about it is gone");
  await flushShareEmails();
  check(mailTo(emailOf(outsider)).length === 1 && mailTo(emailOf(outsider))[0].text.includes("You can now view"), "the new guest gets one email");

  // Declining
  sent.length = 0;
  check((await requestPageAccess(guest, secret, "hi")) === "sent", "a guest can ask too");
  const [guestRequest] = (await requestsFor(secret)).filter((r) => r.requesterId === guest);
  check(Boolean(guestRequest), "…and the request is stored");
  await declineAccessRequest(owner, guestRequest.id);
  check((await requestsFor(secret)).every((r) => r.id !== guestRequest.id), "declining drops the request");
  check((await resolvePageAccess(guest, secret)).level === "none", "…gives no access");
  check((await requestNotifications(secret)).every((n) => n.accessRequestId !== guestRequest.id), "…and takes the notifications away");
  await flushShareEmails();
  const declined = mailTo(emailOf(guest));
  check(declined.length === 1 && declined[0].subject === "Your request for access was declined", "the requester is told", declined);
  for (const leak of ["secret title", workspaceName, "Name owner"]) {
    check(!declined[0].text.includes(leak) && !declined[0].html.includes(leak), `…without naming the page, workspace or who declined (${leak.slice(0, 12)})`);
  }
  await rejects(() => declineAccessRequest(owner, guestRequest.id), isAccessError, "a request can be answered once");

  // Emails in the recipient's language. Outside a request the actor's language is English, so the
  // request and its notifications are queued in English; the owner and the guest use Turkish.
  sent.length = 0;
  await rememberLocale(owner, "tr");
  await rememberLocale(guest, "tr");
  const storedOf = async (id: string) =>
    (await db.select({ locale: userPreference.locale, at: userPreference.updatedAt }).from(userPreference).where(eq(userPreference.userId, id)))[0];
  const ownerStored = await storedOf(owner);
  check(ownerStored?.locale === "tr" && (await storedOf(guest))?.locale === "tr", "the language someone uses is stored with their account");
  await rememberLocale(owner, "tr");
  check((await storedOf(owner))?.at.getTime() === ownerStored.at.getTime(), "…and storing the same one again writes nothing");
  check((await requestPageAccess(guest, secret, "tekrar bakar mısın?")) === "sent", "the guest asks again");
  const [trRequest] = (await requestsFor(secret)).filter((r) => r.requesterId === guest);
  const [queued] = await db
    .select({ emailLocale: notification.emailLocale })
    .from(notification)
    .where(and(eq(notification.accessRequestId, trRequest.id), eq(notification.userId, owner)));
  check(trRequest.locale === "en" && queued?.emailLocale === "en", "…queued in the actor's language, English", { trRequest, queued });
  await flushShareEmails();
  const askedInTurkish = mailTo(emailOf(owner));
  const asked = {
    requesterName: "Name guest",
    requesterEmail: emailOf(guest),
    pageTitle: `secret title ${RUN}`,
    workspaceName,
    message: "tekrar bakar mısın?",
    link: "https://example.test/",
  };
  const turkishAsk = accessRequestEmail("tr", asked).subject;
  check(turkishAsk !== accessRequestEmail("en", asked).subject, "setup: the Turkish subject differs from the English one");
  check(askedInTurkish.length === 1 && askedInTurkish[0].subject === turkishAsk, "the owner, who uses Turkish, gets the request in Turkish", askedInTurkish);
  await declineAccessRequest(owner, trRequest.id);
  await flushShareEmails();
  const declinedInTurkish = mailTo(emailOf(guest));
  const turkishDecline = accessDeclinedEmail("tr", { link: "https://example.test/" }).subject;
  check(turkishDecline !== "Your request for access was declined", "setup: the Turkish decline subject differs from the English one");
  check(
    declinedInTurkish.length === 1 && declinedInTurkish[0].subject === turkishDecline,
    "the guest, who uses Turkish, hears the answer in Turkish though they asked in English",
    declinedInTurkish,
  );
  await rememberLocale(owner, "en");
  await rememberLocale(guest, "en");

  // Sharing the page some other way answers the request too
  await requestPageAccess(alice, secret);
  check((await requestsFor(secret)).some((r) => r.requesterId === alice), "a member asks");
  await setPagePermission(owner, secret, alice, "edit");
  check((await requestsFor(secret)).every((r) => r.requesterId !== alice), "sharing the page with them from the panel answers it");

  // A guest with full access learns who asked, but not the address of anyone in the workspace
  await db.insert(page).values([P("guestroom")]);
  const guestRoom = `${RUN}-guestroom`;
  await setPagePermission(owner, guestRoom, owner, "full");
  await setPagePermission(owner, guestRoom, null, "none");
  await setPagePermission(owner, guestRoom, guest, "full");
  sent.length = 0;
  await requestPageAccess(bob, guestRoom, "me too");
  await requestPageAccess(stranger, guestRoom);
  const asGuest = await listAccessRequests(guest, guestRoom);
  const bobAsked = asGuest.find((r) => r.requesterId === bob);
  check(bobAsked?.name === "Name bob" && bobAsked.email === null, "a guest's share panel names a member who asked, without their address", asGuest);
  check(asGuest.find((r) => r.requesterId === stranger)?.email === emailOf(stranger), "…and shows the address of someone outside, who gave it by asking", asGuest);
  check((await listAccessRequests(owner, guestRoom)).find((r) => r.requesterId === bob)?.email === emailOf(bob), "…while members still see it");
  const guestInbox = (await listInbox(guest, workspaceId)).filter((i) => i.kind === "access_request" && i.pageId === guestRoom);
  const bobInInbox = guestInbox.find((i) => i.actorName === "Name bob");
  check(bobInInbox?.accessRequest?.requesterEmail === "", "…nor does the guest's inbox", guestInbox);
  await flushShareEmails();
  const guestMails = mailTo(emailOf(guest)).filter((m) => m.subject.includes("asked for access"));
  check(
    guestMails.length === 2 && guestMails.every((m) => !m.text.includes(emailOf(bob)) && !m.subject.includes(emailOf(bob))),
    "…nor the email about it",
    guestMails.map((m) => m.text),
  );
  check(guestMails.some((m) => m.text.includes(emailOf(stranger))), "…which does show the outsider's address");

  // Asking for more access, from the Share menu of a page one can open
  await db.insert(page).values([P("more")]);
  const more = `${RUN}-more`;
  // In a second workspace too: the email reads their role in this one only.
  await db.insert(workspace).values({ id: `${workspaceId}-2`, name: `${workspaceName} 2` });
  await db.insert(workspaceMember).values({ workspaceId: `${workspaceId}-2`, userId: bob, role: "owner" });
  await setPagePermission(owner, more, owner, "full");
  await setPagePermission(owner, more, alice, "full");
  await setPagePermission(owner, more, null, "view");
  resetAccessRequestLimits();
  await flushShareEmails();
  sent.length = 0;
  check((await requestPageAccess(bob, more)) === "sent" && (await requestsFor(more)).length === 0, "the no-access screen's ask still stores nothing for someone who can open the page");
  await rejects(() => requestMoreAccess(stranger, more, "edit"), isAccessError, "someone who can't open the page can't ask for more");
  check((await requestMoreAccess(alice, more, "edit")) === "unavailable", "someone who already has that much is told so");
  check((await requestsFor(more)).length === 0, "…and nothing is stored");
  check((await requestMoreAccess(bob, more, "comment", "to leave notes")) === "sent", "a member who can view asks to comment");
  const [commentAsk] = await requestsFor(more);
  check(commentAsk?.level === "comment" && commentAsk.message === "to leave notes", "the request keeps the level asked for and the message", commentAsk);
  check((await pendingRequestOf(bob, more)) === "comment", "their Share menu shows what they asked for");
  check((await requestMoreAccess(bob, more, "comment", "again")) === "sent", "asking for the same again answers \"sent\"");
  check((await requestsFor(more))[0]?.id === commentAsk.id && (await requestsFor(more))[0]?.message === "to leave notes", "…and keeps the pending request");
  check((await requestMoreAccess(bob, more, "edit", "and to edit")) === "sent", "asking for more than the pending one goes through");
  const moreRequests = await requestsFor(more);
  const editAsk = moreRequests[0];
  check(moreRequests.length === 1 && editAsk.level === "edit" && editAsk.message === "and to edit", "…one request per person and page, now for edit", moreRequests);
  const moreNotes = await requestNotifications(more);
  check(moreNotes.every((n) => n.accessRequestId === editAsk.id), "the replaced request's notifications went with it", moreNotes);
  check(JSON.stringify(moreNotes.map((n) => n.userId).sort()) === JSON.stringify([alice, owner].sort()), "only the people with full access are told", moreNotes);
  const moreItem = (await listInbox(owner, workspaceId)).find((i) => i.kind === "access_request" && i.pageId === more);
  check(moreItem?.accessRequest?.level === "edit" && moreItem.accessRequest.current === "view", "the inbox says what they asked for and what they have", moreItem?.accessRequest);
  check((await listInbox(bob, workspaceId)).every((i) => i.kind !== "access_request" || i.pageId !== more), "the requester isn't told about their own request");
  check((await getPageHeaderInfo(owner, more)).accessRequests === 1, "the page header counts it for those who can answer");
  const moreListed = await listAccessRequests(owner, more);
  check(moreListed.length === 1 && moreListed[0].level === "edit" && moreListed[0].current === "view", "the share panel lists it with both levels", moreListed);
  await flushShareEmails();
  const moreMails = mailTo(emailOf(alice)).filter((m) => m.subject.includes("more title"));
  check(
    moreMails.length === 1 && moreMails[0].subject.startsWith("Name bob asked to edit") && moreMails[0].text.includes("would like to edit it"),
    "the email says which access they ask for",
    moreMails.map((m) => m.subject),
  );
  await rejects(() => approveAccessRequest(owner, editAsk.id, "view"), (e) => e instanceof AccessRequestError, "approving at a level they already have is refused");
  check((await requestsFor(more)).length === 1, "…and leaves the request");
  sent.length = 0;
  await approveAccessRequest(owner, editAsk.id, "comment");
  check((await resolvePageAccess(bob, more)).level === "comment", "the approver may give another level than asked, above what they had");
  check((await requestsFor(more)).length === 0 && (await requestNotifications(more)).length === 0, "the request and its notifications are gone");
  const [approvedAudit] = await db
    .select({ details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "access_request.approved"), eq(auditEvent.targetId, more)));
  check(approvedAudit?.details.level === "comment" && approvedAudit.details.requested === "edit", "the audit log records what was given and what was asked", approvedAudit);
  await flushShareEmails();
  check(mailTo(emailOf(bob)).some((m) => m.text.includes("You can now view and comment on")), "the requester hears what they can do now");

  // Answered some other way: it leaves every list and its email isn't sent
  sent.length = 0;
  check((await requestMoreAccess(bob, more, "edit")) === "sent", "a commenter asks to edit");
  const [staleAsk] = await requestsFor(more);
  await setPagePermission(owner, more, null, "edit");
  check((await resolvePageAccess(bob, more)).level === "edit", "setup: everyone can edit now");
  check((await listAccessRequests(owner, more)).length === 0 && (await countAccessRequests(more)) === 0, "the request leaves the share panel and the header count");
  check((await listInbox(owner, workspaceId)).every((i) => i.kind !== "access_request" || i.pageId !== more), "…and the inbox");
  check((await pendingRequestOf(bob, more)) === null, "…and the requester's Share menu");
  await flushShareEmails();
  check(sent.every((m) => !m.subject.includes("more title")), "…and its email doesn't go out", sent.map((m) => m.subject));
  await setPagePermission(owner, more, null, "view");

  // Declining more access
  sent.length = 0;
  await declineAccessRequest(owner, staleAsk.id);
  check((await resolvePageAccess(bob, more)).level === "comment", "declining keeps the access they had");
  await flushShareEmails();
  const declinedMore = mailTo(emailOf(bob));
  check(
    declinedMore.length === 1 && declinedMore[0].text.includes(`Your request to edit “more title ${RUN}” was declined`),
    "the requester, who can open the page, hears its title",
    declinedMore.map((m) => m.text),
  );
  const [declinedAudit] = await db
    .select({ details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "access_request.declined"), eq(auditEvent.targetId, more)));
  check(declinedAudit?.details.requested === "edit", "the audit log records what was declined", declinedAudit);

  // The workspace setting
  await rejects(() => updateWorkspaceSettings(alice, workspaceId, { accessRequests: false }), isAccessError, "only owners turn requests off");
  await updateWorkspaceSettings(owner, workspaceId, { accessRequests: false });
  const off = await screen(stranger, workspaceId, secret);
  check(off !== null && !off.includes("Request access") && !off.includes("<form"), "with requests off, the screen has no request button");
  check((await screen(stranger, workspaceId, missing)) === off, "…for a page that doesn't exist too");
  check((await screen(stranger, `${RUN}-no-such-workspace`, secret))?.includes("Request access"), "the button depends on the workspace in the address, not the page");
  const before = await requestNotifications(secret);
  check((await requestPageAccess(stranger, secret)) === "sent", "asking anyway answers \"sent\"");
  check((await requestsFor(secret)).every((r) => r.requesterId !== stranger), "…and stores nothing");
  check((await requestNotifications(secret)).length === before.length, "…and notifies nobody");
  check((await requestMoreAccess(bob, more, "edit")) === "unavailable", "asking for more is unavailable too");
  check((await requestsFor(more)).length === 0, "…and stores nothing");
  await updateWorkspaceSettings(owner, workspaceId, { accessRequests: true });
  check((await accessRequestsOffered(workspaceId)) === true, "turned back on, the button is back");

  console.log(`\n${passed} checks passed`);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, `${workspaceId}-2`]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
  // The database client is kept on globalThis under the app's name; exiting also closes it here.
  process.exit(failed ? 1 : 0);
}
