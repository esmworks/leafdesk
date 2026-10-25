/**
 * End-to-end check of the home page's "Assigned to you" list against the database: rows a person
 * property assigns to the viewer, grouped by date, without done rows, the trash, templates, rows
 * they can't open or values hidden from them (a hidden person property doesn't count, a hidden
 * status or date neither shows nor decides), the name of a database they can't open, and the cap.
 * Then the calendar feed of those rows: the dated ones as events, gone with export or connected
 * apps turned off or membership lost, replaced or turned off. Then to-dos in pages that mention
 * someone (server/page-tasks.ts): indexed on save, listed by date with their page, ticked and
 * unticked from the list (edit access only), hidden on pages the viewer can't open or in the
 * trash, in the feed when dated, and indexed by the backfill. Creates its own users and workspaces
 * and deletes them afterwards.
 *
 *   pnpm tsx scripts/assigned-e2e.ts
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
const { calendarFeed, pageTask, pageTaskBackfill, user, workspace, workspaceMember } = await import("@/db/schema");
const { dayString, localDay } = await import("@/lib/time-zone");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { backfillPageTasks, setPageTaskChecked } = await import("@/server/page-tasks");
const { createCollab } = await import("@/server/collab/service");
const { addProperty } = await import("@/server/databases");
const { loadProperties } = await import("@/server/derived");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setPropertyAccess } = await import("@/server/property-access");
const { createRowTemplate, saveAsTemplate } = await import("@/server/templates");
const { ASSIGNED_LIMIT, assignedRows } = await import("@/server/assigned");
const { AccessError } = await import("@/server/access");
const { createAssignedCalendarFeed, deleteAssignedCalendarFeed, getAssignedCalendarFeed, readCalendarFeed } = await import(
  "@/server/calendar-feeds"
);
const { rememberLocale } = await import("@/server/mail/locale");
const { updateWorkspaceSettings } = await import("@/server/workspaces");

const RUN = `assigned-e2e-${Date.now().toString(36)}`;

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

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-other`;
const owner = { userId: ids.owner };
// One instant for every date, so a run across midnight still agrees with itself.
const todayNumber = localDay(Date.now(), "UTC");
const today = dayString(todayNumber);
const day = (offset: number) => dayString(todayNumber + offset);

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  const empty = await assignedRows(ids.member, workspaceId, today);
  check(empty.groups.length === 0 && empty.total === 0, "a workspace without person properties lists nothing", empty);

  // Tasks: Assignee and Reviewer (people), Due (date) and the default Status.
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  await addProperty(ids.owner, tasks.id, { name: "Reviewer", type: "person" });
  await addProperty(ids.owner, tasks.id, { name: "Due", type: "date" });
  const row = (title: string, properties: Record<string, unknown>) =>
    createPage(owner, { workspaceId, parentId: tasks.id, title, properties });
  const mine = { Assignee: [ids.member] };

  const overdue = await row("Overdue", { ...mine, Due: day(-1), Status: "Not started" });
  const dueToday = await row("Today", { ...mine, Due: today, Status: "In progress" });
  const soon = await row("Soon", { ...mine, Due: day(3) });
  const later = await row("Later", { ...mine, Due: day(30) });
  const undated = await row("Undated", mine);
  const reviewing = await row("Reviewing", { Reviewer: [ids.member], Assignee: [ids.owner] });
  await row("Done", { ...mine, Status: "Done", Due: day(-2) });
  await row("Someone else's", { Assignee: [ids.owner], Due: today });
  const trashed = await row("Trashed", { ...mine, Due: today });
  await archivePage(ids.owner, trashed.id);
  const closed = await row("Closed to the member", { ...mine, Due: today });
  await setPagePermission(ids.owner, closed.id, ids.owner, "full");
  await setPagePermission(ids.owner, closed.id, null, "none");
  await createRowTemplate(owner, tasks.id, { title: "Row template", properties: mine });

  const asMember = await assignedRows(ids.member, workspaceId, today);
  const titles = (r: typeof asMember) => r.groups.map((g) => [g.key, g.rows.map((x) => (x.type === "row" ? x.title : x.text))]);
  check(
    JSON.stringify(titles(asMember)) ===
      JSON.stringify([
        ["overdue", ["Overdue"]],
        ["today", ["Today"]],
        ["next7", ["Soon"]],
        ["later", ["Later"]],
        // Undated rows: the one edited last first.
        ["none", ["Reviewing", "Undated"]],
      ]),
    "rows assigned through any person property, grouped by date; done, trashed, closed and template rows left out",
    titles(asMember),
  );
  check(asMember.total === 6, "the total counts the open rows", asMember.total);
  const first = asMember.groups[0].rows[0];
  check(
    first.type === "row" && first.id === overdue.id && first.date === day(-1) && first.status?.name === "Not started" && first.databaseTitle === "Tasks",
    "a row carries its date, status and database",
    first,
  );
  check(
    asMember.groups.flatMap((g) => g.rows).every((r) => [overdue, dueToday, soon, later, undated, reviewing].some((p) => p.id === r.id)),
    "nothing else is listed",
  );

  const asOwner = await assignedRows(ids.owner, workspaceId, today);
  check(
    JSON.stringify(titles(asOwner)) === JSON.stringify([["today", ["Someone else's"]], ["none", ["Reviewing"]]]),
    "the owner gets the rows assigned to them, not the member's",
    titles(asOwner),
  );

  // A template copy of the database keeps its rows (and their people) out of the list.
  await saveAsTemplate(owner, tasks.id);
  check((await assignedRows(ids.member, workspaceId, today)).total === 6, "a database saved as a template adds nothing");

  // Hidden values: a person property the member may not see doesn't assign them; a status or date
  // hidden from them neither leaves a done row out nor shows.
  const hidden = await createPage(owner, { workspaceId, kind: "database", title: "Hidden values" });
  const hiddenPerson = await addProperty(ids.owner, hidden.id, { name: "Owner", type: "person" });
  await addProperty(ids.owner, hidden.id, { name: "Assignee", type: "person" });
  const hiddenDate = await addProperty(ids.owner, hidden.id, { name: "Due", type: "date" });
  await createPage(owner, { workspaceId, parentId: hidden.id, title: "Named in a hidden property", properties: { Owner: [ids.member] } });
  const doneHidden = await createPage(owner, {
    workspaceId,
    parentId: hidden.id,
    title: "Done, status hidden",
    properties: { Assignee: [ids.member], Status: "Done", Due: today },
  });
  // Full access is never restricted: the member may only edit this database.
  await setPagePermission(ids.owner, hidden.id, ids.owner, "full");
  await setPagePermission(ids.owner, hidden.id, ids.member, "edit");
  await setPagePermission(ids.owner, hidden.id, null, "none");
  await setPropertyAccess(ids.owner, hiddenPerson.id, { everyone: "none", exceptions: [] });
  const statusProp = ((await loadProperties([hidden.id])).get(hidden.id) ?? []).find((p) => p.type === "status")!;
  await setPropertyAccess(ids.owner, statusProp.id, { everyone: "none", exceptions: [] });
  await setPropertyAccess(ids.owner, hiddenDate.id, { everyone: "none", exceptions: [] });

  const withHidden = await assignedRows(ids.member, workspaceId, today);
  const all = withHidden.groups.flatMap((g) => g.rows).filter((r) => r.type === "row");
  check(!all.some((r) => r.title === "Named in a hidden property"), "a hidden person property assigns nobody", titles(withHidden));
  const shownDone = all.find((r) => r.id === doneHidden.id);
  check(
    shownDone && shownDone.status === null && shownDone.date === null && withHidden.groups.find((g) => g.key === "none")?.rows.includes(shownDone),
    "a hidden status doesn't leave the row out, and a hidden status and date don't show",
    shownDone,
  );
  const ownerSees = (await assignedRows(ids.owner, workspaceId, today)).groups.flatMap((g) => g.rows);
  check(!ownerSees.some((r) => r.id === doneHidden.id), "…while for full access the row is done");

  // A row shared on its own: listed, without the name of the database the member can't open.
  const secret = await createPage(owner, { workspaceId, kind: "database", title: "Secret database" });
  await addProperty(ids.owner, secret.id, { name: "Assignee", type: "person" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  const sharedRow = await createPage(owner, { workspaceId, parentId: secret.id, title: "Shared row", properties: { Assignee: [ids.member] } });
  await setPagePermission(ids.owner, sharedRow.id, ids.member, "view");
  const shared = (await assignedRows(ids.member, workspaceId, today)).groups.flatMap((g) => g.rows).filter((r) => r.type === "row").find((r) => r.id === sharedRow.id);
  check(shared && shared.databaseTitle === null, "a row shared on its own shows without its database's name", shared);

  // The cap: the first rows in group order, with the total of all.
  const many = await createPage(owner, { workspaceId, kind: "database", title: "Many" });
  await addProperty(ids.owner, many.id, { name: "Assignee", type: "person" });
  for (let i = 0; i < ASSIGNED_LIMIT; i++) {
    await createPage(owner, { workspaceId, parentId: many.id, title: `Many ${i}`, properties: { Assignee: [ids.member] } });
  }
  const capped = await assignedRows(ids.member, workspaceId, today);
  const cappedRows = capped.groups.flatMap((g) => g.rows);
  check(cappedRows.length === ASSIGNED_LIMIT && capped.total === ASSIGNED_LIMIT + 8, "past the cap the list is cut and the total kept", {
    shown: cappedRows.length,
    total: capped.total,
  });
  check(cappedRows[0].id === overdue.id && cappedRows.some((r) => r.id === later.id), "…keeping the dated rows first");

  // The calendar feed of assigned rows: the open rows with a date the member may see, as events.
  const codeOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? "thrown";
    }
  };
  check((await getAssignedCalendarFeed(ids.member, workspaceId)).feed === null, "nobody has a feed of assigned rows until they make one");
  check((await codeOf(() => createAssignedCalendarFeed(ids.outsider, workspaceId))) !== null, "someone outside the workspace gets none");
  const meeting = await row("Meeting", { ...mine, Due: `${today}T11:30:00.000Z/${today}T13:00:00.000Z` });
  const trip = await row("Trip", { ...mine, Due: `${day(5)}/${day(7)}` });
  const lost = await createPage(owner, { workspaceId, kind: "database", title: "Lost" });
  await addProperty(ids.owner, lost.id, { name: "Assignee", type: "person" });
  await addProperty(ids.owner, lost.id, { name: "Due", type: "date" });
  const lostRow = await createPage(owner, { workspaceId, parentId: lost.id, title: "In a database taken away", properties: { Assignee: [ids.member], Due: today } });

  const address = await createAssignedCalendarFeed(ids.member, workspaceId);
  const secretOf = (url: string) => url.split("/api/calendar/")[1]?.replace(/\.ics$/, "") ?? "";
  const feedSecret = secretOf(address);
  check(/^ldcal_[A-Za-z0-9]{36}$/.test(feedSecret), "the address holds a secret", address);
  const read = await readCalendarFeed(feedSecret);
  check(read.status === 200, "the feed of assigned rows reads", read);
  // Unfolded, so long lines can be matched whole.
  const body = read.body.replace(/\r\n /g, "");
  const has = (id: string) => body.includes(`UID:${id}@`);
  const compact = (d: string) => d.replaceAll("-", "");
  check(read.name === `${RUN} · Assigned to you`, "…named after the workspace", read.name);
  check(
    [overdue, dueToday, soon, later, meeting, trip, lostRow].every((r) => has(r.id)),
    "…with every open dated row assigned to the member, across databases",
    body,
  );
  check(body.match(/BEGIN:VEVENT/g)?.length === 7, "…and nothing else: no undated, done, closed, trashed or template rows", body);
  check(!has(doneHidden.id), "a row whose date is hidden from the member isn't an event");
  check(body.includes(`DTSTART;VALUE=DATE:${compact(day(-1))}\r\nDTEND;VALUE=DATE:${compact(today)}\r\n`), "a day is an all-day event");
  check(body.includes(`DTSTART:${compact(today)}T113000Z\r\nDTEND:${compact(today)}T130000Z\r\n`), "a time range keeps its times");
  check(body.includes(`DTSTART;VALUE=DATE:${compact(day(5))}\r\nDTEND;VALUE=DATE:${compact(day(8))}\r\n`), "a range of days is one all-day event");
  check(body.includes("SUMMARY:Meeting\r\nDESCRIPTION:Tasks\r\n"), "an event names its database");
  check(body.includes(`URL:${process.env.APP_URL ?? ""}`) && body.includes(`/w/${workspaceId}/p/${meeting.id}`), "…and links to the row");
  check((await getAssignedCalendarFeed(ids.member, workspaceId)).feed?.lastUsedAt, "reading it is recorded");

  await setPagePermission(ids.owner, lost.id, ids.owner, "full");
  await setPagePermission(ids.owner, lost.id, null, "none");
  const afterLoss = await readCalendarFeed(feedSecret);
  check(afterLoss.status === 200 && !afterLoss.body.includes(lostRow.id), "rows of a database the member lost access to leave the feed");

  await rememberLocale(ids.member, "tr");
  const turkish = await readCalendarFeed(feedSecret);
  check(turkish.status === 200 && turkish.name === `${RUN} · Size atananlar`, "the name is in the member's language", turkish);

  await updateWorkspaceSettings(ids.owner, workspaceId, { export: false });
  check((await readCalendarFeed(feedSecret)).status === 404, "with export off the feed stops");
  check((await codeOf(() => createAssignedCalendarFeed(ids.member, workspaceId))) === "calendarFeedExportOff", "…and none can be made");
  check((await getAssignedCalendarFeed(ids.member, workspaceId)).allowed === false, "…which the dialog is told");
  await updateWorkspaceSettings(ids.owner, workspaceId, { export: true });
  await updateWorkspaceSettings(ids.owner, workspaceId, { connectedApps: "off" });
  check((await readCalendarFeed(feedSecret)).status === 404, "with connected apps off the feed stops too");
  await updateWorkspaceSettings(ids.owner, workspaceId, { connectedApps: "full" });
  check((await readCalendarFeed(feedSecret)).status === 200, "turned back on, it reads again");

  const replaced = await createAssignedCalendarFeed(ids.member, workspaceId);
  check(replaced !== address && (await readCalendarFeed(feedSecret)).status === 404, "a new address replaces the old one");
  const kept = await db
    .select()
    .from(calendarFeed)
    .where(and(eq(calendarFeed.userId, ids.member), eq(calendarFeed.workspaceId, workspaceId)));
  check(kept.length === 1, "one feed of assigned rows per person and workspace", kept.length);
  const newSecret = secretOf(replaced);
  const ownerFeed = secretOf(await createAssignedCalendarFeed(ids.owner, workspaceId));
  const ownerRead = await readCalendarFeed(ownerFeed);
  check(ownerRead.status === 200 && ownerRead.body.match(/BEGIN:VEVENT/g)?.length === 1 && ownerRead.body.includes("SUMMARY:Someone else's"), "each person's feed holds their own rows", ownerRead);

  await db.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.member)));
  check((await readCalendarFeed(newSecret)).status === 404, "someone who left the workspace reads nothing");
  await db.insert(workspaceMember).values({ workspaceId, userId: ids.member, role: "member" });
  check((await readCalendarFeed(newSecret)).status === 200, "…until they are back");
  await deleteAssignedCalendarFeed(ids.member, workspaceId);
  check((await readCalendarFeed(newSecret)).status === 404, "turned off, it reads nothing");
  check((await readCalendarFeed(ownerFeed)).status === 200, "…and the other person's still reads");

  // ── To-dos in pages that mention someone (server/page-tasks.ts) ──────────────────────────────
  const tasksOf = async (userId: string) =>
    (await assignedRows(userId, workspaceId, today)).groups.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.key }))).filter((r) => r.type === "pageTask");
  const indexed = async (pageId: string) =>
    (await db.select().from(pageTask).where(eq(pageTask.pageId, pageId))).sort((a, b) => a.text.localeCompare(b.text) || a.userId.localeCompare(b.userId));
  const before = await assignedRows(ids.member, workspaceId, today);
  const notes = await createPage(owner, { workspaceId, title: "Launch notes", icon: "🚀" });
  await getCollab().replaceContent(
    notes.id,
    [
      `- [ ] @${ids.member}: write the post by @${day(-3)}`,
      `- [ ] Review the launch @${ids.member} @${ids.owner} @${day(2)}`,
      `- [x] @${ids.member} already done`,
      "- [ ] Nobody named",
      `Plain text naming @${ids.member}`,
    ].join("\n"),
    owner,
  );
  const rowsAfterWrite = await indexed(notes.id);
  check(
    JSON.stringify(rowsAfterWrite.map((r) => [r.text, r.userId, r.date])) ===
      JSON.stringify([
        ["Review the launch", ids.member, day(2)],
        ["Review the launch", ids.owner, day(2)],
        ["write the post by", ids.member, day(-3)],
      ]),
    "a save indexes each unticked to-do once per person it mentions, with its text and first date",
    rowsAfterWrite,
  );
  const writePost = rowsAfterWrite.find((r) => r.text === "write the post by")!;
  const memberTasks = await tasksOf(ids.member);
  const overdueTask = memberTasks.find((t) => t.blockId === writePost.blockId);
  check(
    memberTasks.length === 2 &&
      overdueTask?.group === "overdue" &&
      overdueTask.pageTitle === "Launch notes" &&
      overdueTask.pageIcon === "🚀" &&
      overdueTask.path === `/w/${workspaceId}/p/${notes.id}#block-${writePost.blockId}` &&
      overdueTask.markable,
    "the list holds the member's to-dos by date, each with its page and a link to the block",
    memberTasks,
  );
  check(memberTasks.find((t) => t.blockId !== writePost.blockId)?.group === "next7", "…a to-do due in two days among the next 7 days");
  check((await assignedRows(ids.member, workspaceId, today)).total === before.total + 2, "…counted in the total");
  check((await tasksOf(ids.owner)).length === 1, "the owner gets the to-do that mentions them too");

  // Ticking from the list writes the block; the save takes it out of the index.
  await setPageTaskChecked(ids.member, notes.id, writePost.blockId, true);
  const ticked = (await getCollab().readBlocks(notes.id)).blocks as { id: string; props: { checked?: unknown } }[];
  check(ticked.find((b) => b.id === writePost.blockId)?.props.checked === true, "ticking from the list ticks the to-do in the page");
  check(!(await tasksOf(ids.member)).some((t) => t.blockId === writePost.blockId), "…and it leaves the list");
  await setPageTaskChecked(ids.member, notes.id, writePost.blockId, false);
  check((await tasksOf(ids.member)).some((t) => t.blockId === writePost.blockId), "unticking brings it back");

  // Who may tick: edit access to the page's content.
  await setPagePermission(ids.owner, notes.id, ids.owner, "full");
  await setPagePermission(ids.owner, notes.id, ids.member, "view");
  await setPagePermission(ids.owner, notes.id, null, "none");
  check((await tasksOf(ids.member)).every((t) => !t.markable), "a to-do on a page the member may only view can't be ticked from the list");
  let viewerRefused = false;
  try {
    await setPageTaskChecked(ids.member, notes.id, writePost.blockId, true);
  } catch (error) {
    viewerRefused = error instanceof AccessError;
  }
  check(viewerRefused, "…nor ticked through the action");
  await setPagePermission(ids.owner, notes.id, ids.member, "none");
  check((await tasksOf(ids.member)).length === 0, "a page the member can't open lists none of its to-dos");
  await setPagePermission(ids.owner, notes.id, ids.member, "edit");

  // Edits follow; the trash hides them.
  await getCollab().replaceContent(notes.id, `- [ ] @${ids.member} write the launch post`, owner);
  const rewritten = await indexed(notes.id);
  check(
    rewritten.length === 1 && rewritten[0].text === "write the launch post" && rewritten[0].date === null,
    "rewriting the page brings the index in line",
    rewritten,
  );
  const afterRewrite = await readCalendarFeed(ownerFeed);
  check(afterRewrite.status === 200 && !afterRewrite.body.includes(notes.id), "a to-do the owner is no longer named in leaves their feed");
  await getCollab().replaceContent(notes.id, `- [ ] @${ids.owner} call the printer @${day(1)}`, owner);
  const featured = await readCalendarFeed(ownerFeed);
  const withTask = featured.status === 200 ? featured.body.replace(/\r\n /g, "") : "";
  check(
    withTask.includes("SUMMARY:call the printer\r\nDESCRIPTION:Launch notes\r\n") && withTask.includes(`/w/${workspaceId}/p/${notes.id}#block-`),
    "the feed of assigned rows holds a dated to-do, named after its page and linking to it",
    withTask,
  );

  // The backfill indexes pages written before the index.
  await db.delete(pageTask).where(eq(pageTask.pageId, notes.id));
  await db.insert(pageTaskBackfill).values({ pageId: notes.id }).onConflictDoNothing();
  let queued = 1;
  while (queued > 0) queued = await backfillPageTasks();
  check((await indexed(notes.id)).length === 1, "the backfill indexes a queued page", await indexed(notes.id));
  check((await db.select().from(pageTaskBackfill).where(eq(pageTaskBackfill.pageId, notes.id))).length === 0, "…and takes it off the queue");

  await archivePage(ids.owner, notes.id);
  check((await tasksOf(ids.owner)).length === 0, "a page in the trash lists none of its to-dos");

  let refused = false;
  try {
    await assignedRows(ids.outsider, workspaceId, today);
  } catch (error) {
    refused = error instanceof AccessError;
  }
  check(refused, "someone outside the workspace gets nothing");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
