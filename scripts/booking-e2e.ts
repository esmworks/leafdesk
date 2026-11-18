/**
 * End-to-end check of booking links and the calendar tools: a link on a Google Calendar synced both
 * ways (seeded without Google), the free time the page offers, a booking becoming a row of the
 * calendar with a write waiting for its event, the owner's notification, the slot gone afterwards,
 * two bookings of one slot at once making one row, a busy hour taken out of the offer, the spam
 * guards (missing, forged and too fresh tickets, the hidden field, the rate limit), links that are
 * closed, and who may make links. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/booking-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { bookingLink, databaseSync, notification, page, sheetsWrite, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage } = await import("@/server/pages");
const { addProperty, createRows, getProperties } = await import("@/server/databases");
const { BookingError, bookSlot, createBookingLink, deleteBookingLink, findFreeTime, getPublicBooking, issueBookingTicket, listBookingLinks, resetBookingRateLimits, updateBookingLink } = await import("@/server/booking");
const { createCalendarEvent, CalendarEventError } = await import("@/server/calendar-events");

const RUN = `booking-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace() {},
  async disconnectLostAccess() {},
  async readPage() {
    return { title: "", markdown: "", text: "" };
  },
} as unknown as Parameters<typeof registerCollab>[0]);

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

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof BookingError || error instanceof CalendarEventError) return error.code;
    if (error instanceof Error && error.constructor.name === "AccessError") return "access";
    throw error;
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const workspaceId = `${RUN}-ws`;
const MINUTE = 60_000;

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id === ids.owner ? "Ada Owner" : id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);

  // A calendar database that looks like a Google Calendar synced both ways.
  const calendar = await createPage({ userId: ids.owner }, { workspaceId, kind: "database", title: `${RUN} Calendar` });
  await addProperty(ids.owner, calendar.id, { name: "When", type: "date" });
  await addProperty(ids.owner, calendar.id, { name: "Event ID", type: "text" });
  await addProperty(ids.owner, calendar.id, { name: "Description", type: "text" });
  const props = await getProperties(calendar.id);
  const prop = (name: string) => props.find((p) => p.name === name)!.id;
  const [sync] = await db
    .insert(databaseSync)
    .values({
      workspaceId,
      databaseId: calendar.id,
      source: "gcal",
      siteUrl: "https://calendar.example.test",
      query: { connectionId: `${RUN}-none`, calendarId: "primary", calendarName: "Ada's calendar", timeZone: "UTC", direction: "both" },
      mapping: { key: prop("Event ID"), when: prop("When"), description: prop("Description") },
      secrets: "{}",
      intervalMinutes: 0,
    })
    .returning({ id: databaseSync.id });
  const rowsOf = () => db.select({ id: page.id, title: page.title, properties: page.properties }).from(page).where(eq(page.parentId, calendar.id));

  const input = {
    title: "Intro call",
    description: "Thirty minutes",
    databaseId: calendar.id,
    timeZone: "UTC",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startMinute: 0,
    endMinute: 24 * 60,
    durationMinutes: 30,
    bufferMinutes: 0,
    daysAhead: 7,
    minNoticeMinutes: 0,
  };

  // Who may make links, and what is refused
  check((await codeOf(() => createBookingLink(ids.outsider, workspaceId, input))) === "access", "a person outside the workspace can't make a link");
  check((await codeOf(() => createBookingLink(ids.owner, workspaceId, { ...input, title: "  " }))) === "invalid", "a link needs a title");
  check((await codeOf(() => createBookingLink(ids.owner, workspaceId, { ...input, weekdays: [] }))) === "invalid", "a link needs working days");
  check((await codeOf(() => createBookingLink(ids.owner, workspaceId, { ...input, endMinute: 10 }))) === "invalid", "hours shorter than a slot are refused");
  const plain = await createPage({ userId: ids.owner }, { workspaceId, kind: "database", title: `${RUN} Plain` });
  check((await codeOf(() => createBookingLink(ids.owner, workspaceId, { ...input, databaseId: plain.id }))) !== null, "a database that isn't a two-way Google Calendar can't receive bookings");
  const made = await createBookingLink(ids.owner, workspaceId, input);
  const link = { id: made.id, token: made.url.split("/b/")[1] };
  check(link.token.length >= 30 && (await listBookingLinks(ids.owner, workspaceId)).length === 1, "a link is made and listed");
  check((await listBookingLinks(ids.member, workspaceId)).length === 0, "another member doesn't see it");

  // What the page offers
  resetBookingRateLimits();
  const now = Date.now();
  const view = await getPublicBooking(link.token, { ip: "203.0.113.1", now });
  check(view && view.slots.length > 100 && view.title === "Intro call" && view.ownerName === "Ada Owner", "the page offers slots of the link", view?.slots.length);
  check(!JSON.stringify(view).includes(RUN) && !("busy" in (view ?? {})), "the page names no calendar entries");
  check((await getPublicBooking("nope", { ip: "203.0.113.1", now })) === null, "an unknown link has no page");
  const slot = view!.slots[10];

  // Spam guards
  const answers = { name: "Grace Hopper", email: "grace@example.test", note: "Hello" };
  const request = (start: number, issuedAt = now - 10_000, extra: object = {}) => ({ start, ...answers, ticket: issueBookingTicket(link.token, issuedAt), ...extra });
  const options = { ip: "203.0.113.2", locale: "en" as const, now };
  check((await codeOf(() => bookSlot(link.token, { ...request(slot), ticket: "forged.ticket" }, options))) === "expired", "a forged ticket is refused");
  check((await codeOf(() => bookSlot(link.token, { ...request(slot), ticket: issueBookingTicket("other-token", now - 10_000) }, options))) === "expired", "a ticket of another link is refused");
  check((await codeOf(() => bookSlot(link.token, request(slot, now - 500), options))) === "tooFast", "a booking sent right after the page loaded is refused");
  check((await codeOf(() => bookSlot(link.token, { ...request(slot), email: "not-an-address" }, options))) === "invalidAnswers", "an email address that isn't one is refused");
  check((await codeOf(() => bookSlot(link.token, request(slot + MINUTE), options))) === "slotTaken", "a time the page doesn't offer is refused");
  check((await rowsOf()).length === 0, "none of those wrote anything");
  check((await bookSlot(link.token, request(slot, now - 10_000, { honeypot: "http://spam" }), options)) === null && (await rowsOf()).length === 0, "the hidden field drops the booking quietly");

  // A booking
  const booked = await bookSlot(link.token, request(slot), options);
  check(booked && booked.start === slot && booked.end === slot + 30 * MINUTE, "a slot is booked", booked);
  const rows = await rowsOf();
  check(rows.length === 1 && rows[0].title === "Intro call: Grace Hopper", "the booking is a row of the calendar", rows);
  check(String(rows[0].properties[prop("When")]) === `${new Date(slot).toISOString()}/${new Date(slot + 30 * MINUTE).toISOString()}`, "…with its time", rows[0].properties);
  check(String(rows[0].properties[prop("Description")]).includes("grace@example.test") && String(rows[0].properties[prop("Description")]).includes("Hello"), "…and the visitor's address and note");
  const writes = await db.select().from(sheetsWrite).where(eq(sheetsWrite.syncId, sync.id));
  check(writes.length === 1 && writes[0].rowId === rows[0].id && writes[0].created, "the row waits to be written to Google as a new event", writes);
  const told = await db.select().from(notification).where(eq(notification.userId, ids.owner));
  check(told.length === 1 && told[0].kind === "booking_made" && told[0].pageId === rows[0].id && told[0].message === "Grace Hopper", "the owner is told", told);
  resetBookingRateLimits();
  const after = await getPublicBooking(link.token, { ip: "203.0.113.1", now });
  check(!after!.slots.includes(slot) && after!.slots.length < view!.slots.length, "the booked time is no longer offered");
  check(!after!.slots.includes(slot - 15 * MINUTE) || slot - 15 * MINUTE < slot - 30 * MINUTE, "…nor times overlapping it");
  check((await codeOf(() => bookSlot(link.token, request(slot), options))) === "slotTaken", "booking it again is refused");

  // Two at once
  const target = after!.slots[20];
  const results = await Promise.all(
    [0, 1, 2].map((i) => codeOf(() => bookSlot(link.token, { ...request(target), name: `Visitor ${i}`, email: `v${i}@example.test` }, { ...options, ip: `203.0.113.${10 + i}` }))),
  );
  check(results.filter((r) => r === null).length === 1 && results.filter((r) => r === "slotTaken").length === 2, "three bookings of one time at once make one", results);
  check((await rowsOf()).length === 2, "…and one row");

  // Calendar entries take their time out; all-day ones don't
  const busyStart = after!.slots[40];
  await createRows(ids.owner, calendar.id, [
    { title: "Busy", properties: { [prop("When")]: `${new Date(busyStart).toISOString()}/${new Date(busyStart + 2 * 60 * MINUTE).toISOString()}` } },
    { title: "All day", properties: { [prop("When")]: new Date(busyStart).toISOString().slice(0, 10) } },
  ]);
  resetBookingRateLimits();
  const withBusy = await getPublicBooking(link.token, { ip: "203.0.113.1", now });
  const inBusy = withBusy!.slots.filter((s) => s + 30 * MINUTE > busyStart && s < busyStart + 120 * MINUTE);
  check(inBusy.length === 0, "an entry with times takes its hours out of the offer", inBusy);
  check(withBusy!.slots.some((s) => s < busyStart && s + 30 * MINUTE <= busyStart) && withBusy!.slots.some((s) => s >= busyStart + 120 * MINUTE), "…and an all-day entry takes none");

  // Buffer
  await updateBookingLink(ids.owner, link.id, { ...input, bufferMinutes: 30, enabled: true });
  resetBookingRateLimits();
  const buffered = await getPublicBooking(link.token, { ip: "203.0.113.1", now });
  check(!buffered!.slots.some((s) => s + 30 * MINUTE > busyStart - 30 * MINUTE && s < busyStart + 150 * MINUTE), "a buffer keeps the time around entries free");

  // Rate limit
  resetBookingRateLimits();
  const limited: (string | null)[] = [];
  for (let i = 0; i < 8; i++) limited.push(await codeOf(() => bookSlot(link.token, request(slot + MINUTE), { ...options, ip: "203.0.113.50" })));
  check(limited.includes("rateLimited"), "one address can't try again and again", limited);

  // Free time for the AI
  const free = await findFreeTime(ids.owner, workspaceId, {
    from: new Date(now).toISOString().slice(0, 10),
    to: new Date(now + 2 * 86_400_000).toISOString().slice(0, 10),
    timeZone: "UTC",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startMinute: 0,
    endMinute: 24 * 60,
    durationMinutes: 60,
    bufferMinutes: 0,
    now,
  });
  check(free.stretches.length > 0 && free.stretches.every((s) => Date.parse(s.end) - Date.parse(s.start) >= 60 * MINUTE), "free time is found for the person", free);
  check(!JSON.stringify(free).includes("Grace") && !JSON.stringify(free).includes("Busy"), "…without the titles of what is on the calendar");

  // The AI's event writing
  const start = new Date(now + 3 * 86_400_000 + 3 * 3_600_000).toISOString();
  const end = new Date(now + 3 * 86_400_000 + 4 * 3_600_000).toISOString();
  const event = await createCalendarEvent(ids.owner, workspaceId, { title: "Lunch", start, end });
  check(event.databaseId === calendar.id && (await rowsOf()).some((r) => r.id === event.rowId), "an event is written to the calendar");
  check((await codeOf(() => createCalendarEvent(ids.owner, workspaceId, { title: "Backwards", start: end, end: start }))) === "invalidTime", "an event ending before it starts is refused");
  check((await codeOf(() => createCalendarEvent(ids.owner, workspaceId, { title: "No zone", start: "2026-12-01T10:00:00", end: "2026-12-01T11:00:00" }))) === "invalidTime", "a time without a zone is refused");
  check((await codeOf(() => createCalendarEvent(ids.outsider, workspaceId, { title: "x", start, end }))) === "access", "a person outside the workspace can't write events");

  // Closing a link
  await updateBookingLink(ids.owner, link.id, { ...input, enabled: false });
  resetBookingRateLimits();
  check((await getPublicBooking(link.token, { ip: "203.0.113.1", now })) === null, "a switched-off link has no page");
  check((await codeOf(() => bookSlot(link.token, request(target + 3_600_000), options))) === "closed", "…and takes no bookings");
  await updateBookingLink(ids.owner, link.id, { ...input, enabled: true });
  check((await getPublicBooking(link.token, { ip: "203.0.113.1", now })) !== null, "switching it on opens it again");
  check((await codeOf(() => deleteBookingLink(ids.member, link.id))) !== null, "another member can't delete it");
  await deleteBookingLink(ids.owner, link.id);
  check((await getPublicBooking(link.token, { ip: "203.0.113.1", now })) === null && (await db.select().from(bookingLink).where(eq(bookingLink.id, link.id))).length === 0, "a deleted link is gone");

  console.log(`\n${passed} checks passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  process.exit(process.exitCode ?? 0);
}
