/**
 * End-to-end check of Google Calendar syncs, with a fake Google Calendar MCP server (started here,
 * `list_events` answering page by page as Google's does, `list_calendars`, and `create_event` /
 * `update_event` writing into the fake calendar) behind a real connection row, so the calls go
 * through the connection client: who may sync through a connection (owners; members only once an
 * owner allowed the AI chat the tool; guests never), setting one up (refusals first; events as
 * rows with times, whole days, untitled events, a calendar view), a run writing the calendar's
 * changes over and keeping rows whose events left it, the audit log of each call, a connection
 * signed out. Then writing back: who may turn it on, a change written to its event without
 * emailing guests, a time written in the calendar's zone, a field changed in the calendar too
 * keeping the calendar's value, a title saved in the row, another organizer's event left as the
 * calendar has it, a new row becoming an event once it has a When (and only once), a refused write
 * leaving the change waiting, a calendar the account may only read, and reading only again.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/gcal-sync-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { createServer } = await import("node:http");

// The fake calendar server, on a port of its own.
const FAKE_PORT = 30_000 + Math.floor(Math.random() * 20_000);
process.env.CONNECTOR_ALLOWED_HOSTS = `localhost:${FAKE_PORT}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const z = await import("zod");
const { McpServer, createMcpHandler } = await import("@modelcontextprotocol/server");
const { db } = await import("@/db");
const { auditEvent, connection, databaseSync, databaseView, page, sheetsWrite, user, workspace, workspaceMember } = await import("@/db/schema");
const { dayNumber, zonedInstant } = await import("@/lib/time-zone");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { getProperties, updateRowProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { dropClient } = await import("@/server/connections/client");
const { JiraError } = await import("@/server/jira-sync/client");
const { createGcalSync, gcalCalendars, gcalSources, getGcalSync, stopGcalSync, syncGcalNow, updateGcalSync } = await import("@/server/gcal-sync/manage");
const { syncWriteStatus } = await import("@/server/sync-write-status");

const RUN = `gcal-e2e-${Date.now().toString(36)}`;
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
    if (error instanceof JiraError) return error.code;
    if (error instanceof Error && error.constructor.name === "AccessError") return "access";
    throw error;
  }
}

// The fake calendar, in Istanbul's zone: events around now, so they fall in the sync's window.
const ZONE = "Europe/Istanbul";
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY);
const day = (offset: number) => new Date((today + offset) * DAY).toISOString().slice(0, 10);
const at = (offset: number, hour: number) => new Date((today + offset) * DAY + hour * 3_600_000).toISOString().replace(".000", "");
type FakeEvent = Record<string, unknown> & { id: string; start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string } };
const ME = "owner@example.test";
const calendar: FakeEvent[] = [
  {
    id: "visit",
    summary: "ETS visit",
    location: "Ankara",
    description: "Bring the offer",
    status: "confirmed",
    htmlLink: "https://www.google.com/calendar/event?eid=visit",
    organizer: { email: ME, self: true },
    start: { dateTime: at(2, 8) },
    end: { dateTime: at(2, 9) },
  },
  { id: "fair", summary: "Fair", organizer: { email: ME, self: true }, start: { date: day(5) }, end: { date: day(8) } },
  { id: "blank", organizer: { email: ME, self: true }, start: { date: day(1) }, end: { date: day(2) } },
  {
    id: "theirs",
    summary: "Interview",
    location: "Teams",
    organizer: { email: "hr@example.test", displayName: "Ece" },
    start: { dateTime: at(3, 10) },
    end: { dateTime: at(3, 11) },
  },
  { id: "old", summary: "Long ago", organizer: { email: ME, self: true }, start: { date: day(-200) }, end: { date: day(-199) } },
];
let accessRole = "owner";
let refuseWrites = false;
let nextId = 1;
const listed: Record<string, unknown>[] = [];
const writes: { tool: string; args: Record<string, unknown> }[] = [];
const PAGE = 2;

/** A wall-clock time in a zone (no offset), as the tools take it, as an instant. */
const instantOf = (wall: string, zone: string) => {
  const [date, time = "00:00:00"] = wall.split("T");
  const [h, m] = time.split(":").map(Number);
  return zonedInstant(dayNumber(date), h * 60 + m, zone);
};
const iso = (ms: number) => new Date(ms).toISOString().replace(".000", "");
/** Sets an event's times from the tools' arguments, as Google does (an update with a start only keeps the length). */
function setTimes(event: FakeEvent, args: { allDay?: boolean; startTime?: string; endTime?: string; timeZone?: string }) {
  if (!args.startTime) return;
  const zone = args.timeZone ?? ZONE;
  if (args.allDay) {
    event.start = { date: args.startTime.slice(0, 10) };
    event.end = { date: (args.endTime ?? args.startTime).slice(0, 10) };
    return;
  }
  const start = instantOf(args.startTime, zone);
  const length = event.start.dateTime && event.end.dateTime ? Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime) : 3_600_000;
  event.start = { dateTime: iso(start) };
  event.end = { dateTime: iso(args.endTime ? instantOf(args.endTime, zone) : start + length) };
}

const answer = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const refusal = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
const writeArgs = z.object({
  calendarId: z.string().optional(),
  eventId: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  allDay: z.boolean().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  timeZone: z.string().optional(),
  notificationLevel: z.string().optional(),
});

const fake = createMcpHandler(() => {
  const server = new McpServer({ name: "fake-calendar", version: "1.0.0" });
  server.registerTool(
    "list_events",
    {
      description: "Returns events.",
      inputSchema: z.object({
        calendarId: z.string().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        timeZone: z.string().optional(),
        orderBy: z.string().optional(),
        pageSize: z.number().optional(),
        pageToken: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => {
      listed.push(args);
      if (args.calendarId !== "primary" && args.calendarId !== "team@group.calendar.google.com") return refusal("Not Found");
      // Times without a zone are the request's zone (UTC here); events whose time overlaps the window come.
      const from = Date.parse(`${args.startTime}Z`);
      const to = Date.parse(`${args.endTime}Z`);
      const startOf = (e: FakeEvent) => Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00Z`);
      const inWindow = calendar.filter((e) => startOf(e) < to && startOf(e) >= from - DAY);
      const offset = Number(args.pageToken ?? 0);
      const events = inWindow.slice(offset, offset + PAGE);
      return answer({
        accessRole: args.calendarId === "primary" ? accessRole : "reader",
        summary: args.calendarId === "primary" ? ME : "Team",
        timeZone: ZONE,
        events,
        ...(offset + PAGE < inWindow.length ? { nextPageToken: String(offset + PAGE) } : {}),
      });
    },
  );
  server.registerTool("list_calendars", { description: "Lists calendars.", inputSchema: z.object({ pageSize: z.number().optional() }), annotations: { readOnlyHint: true } }, () =>
    answer({ calendars: [{ id: ME, summary: ME, timeZone: ZONE }, { id: "team@group.calendar.google.com", summary: "Team", timeZone: ZONE }] }),
  );
  server.registerTool("create_event", { description: "Creates an event.", inputSchema: writeArgs }, (args) => {
    writes.push({ tool: "create_event", args });
    if (refuseWrites) return refusal("The caller does not have permission");
    const event: FakeEvent = { id: `new${nextId++}`, summary: args.summary, organizer: { email: ME, self: true }, start: {}, end: {}, status: "confirmed" };
    if (args.location) event.location = args.location;
    if (args.description) event.description = args.description;
    setTimes(event, args);
    calendar.push(event);
    return answer(event);
  });
  server.registerTool("update_event", { description: "Updates an event.", inputSchema: writeArgs }, (args) => {
    writes.push({ tool: "update_event", args });
    if (refuseWrites) return refusal("The caller does not have permission");
    const event = calendar.find((e) => e.id === args.eventId);
    if (!event) return refusal("Not Found");
    for (const key of ["summary", "location", "description"] as const) if (args[key] !== undefined) event[key] = args[key];
    setTimes(event, args);
    return answer(event);
  });
  return server;
});

const http = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(`http://localhost:${FAKE_PORT}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const response = await fake.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) => http.listen(FAKE_PORT, "::", resolve));

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const tool = (name: string, kind: "read" | "write") => ({ name, title: null, description: name, inputSchema: { type: "object" }, hinted: kind, kind });
const TOOLS = [tool("list_events", "read"), tool("list_calendars", "read")];
const WRITE_TOOLS = [tool("create_event", "write"), tool("update_event", "write")];
const connectionRow = (values: { id: string; workspaceId: string }) => ({
  name: `Calendar ${values.id.slice(-6)}`,
  slug: values.id.slice(-20).replace(/[^a-z0-9]/gi, "").toLowerCase(),
  url: `http://localhost:${FAKE_PORT}/mcp`,
  authType: "none" as const,
  status: "ready" as const,
  tools: TOOLS,
  chatTools: [],
  eventSecret: "unused",
  ...values,
});

try {
  await db.insert(user).values(userIds.map((u) => ({ id: u, name: u, email: `${u}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.owner, role: "owner" },
  ]);
  const calendarConn = `${RUN}-cal`;
  const elsewhere = `${RUN}-elsewhere`;
  await db.insert(connection).values([connectionRow({ id: calendarConn, workspaceId }), connectionRow({ id: elsewhere, workspaceId: otherWorkspace })]);
  const owner = { userId: ids.owner };
  const home = await createPage(owner, { workspaceId, title: "Home" });

  // Who may sync through a connection
  check((await gcalSources(ids.owner, workspaceId)).map((s) => s.id).join() === calendarConn, "owners may sync through the workspace's Google Calendar connection");
  check((await gcalSources(ids.member, workspaceId)).length === 0, "members may not while an owner hasn't allowed the chat list_events");
  await db.update(connection).set({ chatTools: ["list_events"] }).where(eq(connection.id, calendarConn));
  check((await gcalSources(ids.member, workspaceId)).map((s) => s.id).join() === calendarConn, "…and may once it has");
  check((await gcalSources(ids.guest, workspaceId)).length === 0, "guests never may");
  const calendars = await gcalCalendars(ids.owner, workspaceId, calendarConn);
  check(calendars.map((c) => c.name).join() === `${ME},Team`, "the dialog lists the account's calendars", calendars);

  // Refusals before anything is made
  const setup = { workspaceId, parentId: home.id, connectionId: calendarConn, calendarId: "primary", intervalMinutes: 0 };
  check((await failure(() => createGcalSync(owner, { ...setup, calendarId: "a/b" }))) === "invalidInput", "a calendar id that isn't one is refused");
  check((await failure(() => createGcalSync(owner, { ...setup, connectionId: elsewhere }))) === "forbidden", "another workspace's connection can't be used");
  check((await failure(() => createGcalSync({ userId: ids.guest }, { ...setup, parentId: null }))) !== null, "a guest can't set one up");
  check((await failure(() => createGcalSync(owner, { ...setup, calendarId: "gone@example.test" }))) === "notFound", "a calendar Google doesn't know is refused");
  check((await failure(() => createGcalSync(owner, { ...setup, direction: "both", intervalMinutes: 15 }))) === "forbidden", "writing back needs the connection's write tools");

  // Setting one up
  const result = await createGcalSync(owner, { ...setup, title: "Calendar" });
  const databaseId = result.pages[0].id;
  const props = await getProperties(databaseId);
  const prop = (name: string) => props.find((p) => p.name === name)!.id;
  check(
    props.map((p) => `${p.name}:${p.type}`).join("|") === "When:date|Event ID:text|Location:text|Description:text|Status:select|Organizer:text|Link:url",
    "a calendar sync's properties are made",
    props.map((p) => `${p.name}:${p.type}`),
  );
  const rows = async () =>
    (await db.select({ id: page.id, title: page.title, properties: page.properties, archivedAt: page.archivedAt }).from(page).where(eq(page.parentId, databaseId))).sort((a, b) =>
      String(a.properties[prop("Event ID")]).localeCompare(String(b.properties[prop("Event ID")])),
    );
  const rowOf = async (key: string) => (await rows()).find((r) => r.properties[prop("Event ID")] === key)!;
  const first = await rows();
  check(result.created.rows === 4 && first.map((r) => r.properties[prop("Event ID")]).join() === "blank,fair,theirs,visit", "each event in the window becomes a row, read page by page", first);
  check(listed.filter((a) => a.timeZone === "UTC" && a.orderBy === "startTime").length >= 2, "the events are asked for page by page, in UTC, each occurrence on its own", listed);
  const visit = await rowOf("visit");
  check(
    visit.title === "ETS visit" &&
      visit.properties[prop("When")] === `${at(2, 8).replace("Z", ".000Z")}/${at(2, 9).replace("Z", ".000Z")}` &&
      visit.properties[prop("Location")] === "Ankara" &&
      visit.properties[prop("Link")] === "https://www.google.com/calendar/event?eid=visit",
    "an event's title, time, place and link come over",
    visit,
  );
  check((await rowOf("fair")).properties[prop("When")] === `${day(5)}/${day(7)}`, "whole days end on the last day, not Google's day after", (await rowOf("fair")).properties);
  check((await rowOf("blank")).title === "Untitled event", "an event without a title is named so");
  const views = await db.select({ type: databaseView.type }).from(databaseView).where(eq(databaseView.databaseId, databaseId));
  check(views.some((v) => v.type === "calendar"), "a calendar view is made");
  const [stored] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  check(
    stored.source === "gcal" && (stored.query as { timeZone: string }).timeZone === ZONE && (stored.query as { calendarName: string }).calendarName === ME,
    "the sync is kept with the calendar's name and zone",
    stored.query,
  );
  const view = await getGcalSync(ids.owner, databaseId);
  check(view?.calendarName === ME && view.canManage && view.direction === "read" && !view.canWrite, "its dialog shows the calendar and that it only reads", view);

  // A run
  calendar.find((e) => e.id === "visit")!.location = "İzmir";
  calendar.push({ id: "call", summary: "Call", organizer: { email: ME, self: true }, start: { dateTime: at(4, 7) }, end: { dateTime: at(4, 8) } });
  calendar.splice(
    calendar.findIndex((e) => e.id === "blank"),
    1,
  );
  const ran = await syncGcalNow(ids.owner, databaseId);
  check(ran.outcome.error === null && ran.outcome.count === 4, "a run reads the calendar again", ran.outcome);
  check(
    (await rowOf("visit")).properties[prop("Location")] === "İzmir" && (await rows()).length === 5 && (await rowOf("blank")) !== undefined,
    "…writes changes over, adds new events and keeps rows whose event left",
  );
  const calls = await db
    .select({ details: auditEvent.details, actorId: auditEvent.actorUserId })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "connection.tool_called")));
  check(
    calls.length >= 4 && calls.every((c) => (c.details as { via?: string }).via === "sync" && c.actorId === ids.owner),
    "each call to the connection is in the audit log, as the person the sync runs as",
    calls.length,
  );
  await db.update(connection).set({ status: "needsAuth" }).where(eq(connection.id, calendarConn));
  const signedOut = await syncGcalNow(ids.owner, databaseId);
  check(signedOut.outcome.error === "unauthorized" && !signedOut.enabled, "a connection signed out pauses the sync", signedOut.outcome);
  await db.update(connection).set({ status: "ready" }).where(eq(connection.id, calendarConn));

  // Writing back
  const outbox = () => db.select().from(sheetsWrite).where(eq(sheetsWrite.syncId, stored.id));
  const event = (id: string) => calendar.find((e) => e.id === id)!;
  const runNow = () => syncGcalNow(ids.owner, databaseId);
  check((await failure(() => updateGcalSync(ids.owner, databaseId, { direction: "both" }))) === "invalidInput", "writing back needs a schedule");
  check((await failure(() => updateGcalSync(ids.owner, databaseId, { direction: "both", intervalMinutes: 15 }))) === "forbidden", "…and a connection with the write tools");
  await db.update(connection).set({ tools: [...TOOLS, ...WRITE_TOOLS] }).where(eq(connection.id, calendarConn));
  const both = await updateGcalSync(ids.owner, databaseId, { direction: "both", intervalMinutes: 15 });
  check(both.direction === "both" && both.canWrite && both.enabled, "an owner turns writing back on", both);
  check((await gcalSources(ids.member, workspaceId))[0]?.canWrite === false, "a member may not write through it while the chat may only read");

  // Stands in for the server's syncs (jira-sync/run startDatabaseSyncs), which the change asks to run soon.
  const soon: number[] = [];
  (globalThis as { __leafdeskSyncsSoon?: (ms: number) => void }).__leafdeskSyncsSoon = (ms) => void soon.push(ms);
  await updateRowProperties(ids.owner, visit.id, { [prop("Location")]: "Bursa" });
  const [queued] = await outbox();
  check(queued?.before[prop("Location")] === "İzmir" && !queued.created && soon.length === 1, "a change waits with the value from before it, and asks for a run within seconds", { queued, soon });
  delete (globalThis as { __leafdeskSyncsSoon?: unknown }).__leafdeskSyncsSoon;
  const status = await syncWriteStatus(ids.owner, databaseId);
  check(status?.source === "gcal" && status.pending === 1 && status.canWriteNow, "the database shows the row waiting, with Write now", status);
  const wrote = await runNow();
  const update = writes.at(-1);
  check(wrote.outcome.error === null && event("visit").location === "Bursa", "a run writes the change to its event", writes.at(-1));
  check(
    update?.tool === "update_event" && update.args.eventId === "visit" && update.args.notificationLevel === "NONE" && Object.keys(update.args).sort().join() === "calendarId,eventId,location,notificationLevel",
    "…only that field, without emailing guests",
    update,
  );
  check((await outbox()).length === 0 && (await rowOf("visit")).properties[prop("Location")] === "Bursa", "…and nothing waits after it");
  const writeCalls = await db
    .select({ details: auditEvent.details })
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "connection.tool_called")));
  check(
    writeCalls.some((c) => (c.details as { tool?: string; kind?: string; editors?: string[] }).tool === "update_event" && (c.details as { kind?: string }).kind === "write" && (c.details as { editors?: string[] }).editors?.[0] === ids.owner),
    "the write is in the audit log, with whose change it was",
  );

  // A time, in the calendar's zone: Istanbul is three hours ahead.
  const moved = `${at(2, 12).replace("Z", ".000Z")}`;
  await updateRowProperties(ids.owner, visit.id, { [prop("When")]: moved });
  await runNow();
  check(writes.at(-1)?.args.startTime === `${day(2)}T15:00:00` && writes.at(-1)?.args.timeZone === ZONE && writes.at(-1)?.args.endTime === undefined, "a time is written as the calendar's wall-clock time", writes.at(-1));
  check(
    event("visit").start.dateTime === at(2, 12) && (await rowOf("visit")).properties[prop("When")] === `${moved}/${at(2, 13).replace("Z", ".000Z")}`,
    "…keeping the event's length, which the row then shows",
    { event: event("visit"), row: (await rowOf("visit")).properties },
  );

  // Both changed: the calendar's value stays.
  await updateRowProperties(ids.owner, visit.id, { [prop("Description")]: "Mine" });
  event("visit").description = "Theirs";
  const count = writes.length;
  await runNow();
  check(writes.length === count && (await rowOf("visit")).properties[prop("Description")] === "Theirs", "a field changed in the calendar too keeps the calendar's value");

  // A title saved in the row.
  await getCollab().setTitle(visit.id, "ETS visit (Ankara)", owner);
  await runNow();
  check(event("visit").summary === "ETS visit (Ankara)" && writes.at(-1)?.args.summary === "ETS visit (Ankara)", "a row's new title is written to its event", writes.at(-1));

  // Another organizer's event is the calendar's.
  const theirs = await rowOf("theirs");
  await updateRowProperties(ids.owner, theirs.id, { [prop("Location")]: "Office" });
  const before = writes.length;
  await runNow();
  check(writes.length === before && (await rowOf("theirs")).properties[prop("Location")] === "Teams" && (await outbox()).length === 0, "another organizer's event isn't written, and the row takes the calendar's value back");

  // A new row becomes an event once it has a When, and only once.
  const draft = await createPage(owner, { workspaceId, parentId: databaseId, title: "Site survey", properties: { [prop("Location")]: "Manisa" } });
  await runNow();
  check(!writes.some((w) => w.tool === "create_event") && (await outbox()).length === 1, "a new row without a When waits");
  await updateRowProperties(ids.owner, draft.id, { [prop("When")]: day(6) });
  const created = await runNow();
  const made = writes.filter((w) => w.tool === "create_event");
  const madeEvent = calendar.find((e) => e.summary === "Site survey");
  check(
    created.outcome.error === null && made.length === 1 && made[0].args.allDay === true && made[0].args.endTime === `${day(7)}T00:00:00` && made[0].args.notificationLevel === "NONE",
    "…and becomes an all-day event once it has a day",
    made,
  );
  const draftRow = (await rows()).find((r) => r.id === draft.id)!;
  check(madeEvent?.location === "Manisa" && draftRow.properties[prop("Event ID")] === madeEvent.id && (await outbox()).length === 0, "the row takes the new event's id", draftRow.properties);
  await runNow();
  check(writes.filter((w) => w.tool === "create_event").length === 1 && (await rows()).filter((r) => r.title === "Site survey").length === 1, "a later run makes no second event, nor a second row");

  // A refused write leaves the change waiting, and reading goes on.
  refuseWrites = true;
  await updateRowProperties(ids.owner, visit.id, { [prop("Location")]: "Eskişehir" });
  const refused = await runNow();
  check(refused.outcome.error === null && refused.writeError === "forbidden" && refused.pendingWrites === 1 && refused.enabled, "a refused write is shown, without pausing the sync", refused);
  check((await rowOf("visit")).properties[prop("Location")] === "Eskişehir" && (await syncWriteStatus(ids.owner, databaseId))?.failed === true, "…the row keeps its change while it waits");
  refuseWrites = false;
  const retried = await runNow();
  check(retried.writeError === null && retried.pendingWrites === 0 && event("visit").location === "Eskişehir", "it is written once the calendar takes it");

  // A calendar the account may only read.
  accessRole = "reader";
  await createPage(owner, { workspaceId, parentId: databaseId, title: "Read only", properties: { [prop("When")]: day(9) } });
  const readOnlyCalendar = await runNow();
  check(readOnlyCalendar.writeError === "forbidden" && readOnlyCalendar.pendingWrites === 1, "a calendar the account may only read refuses new events", readOnlyCalendar);
  accessRole = "owner";
  check((await failure(() => createGcalSync(owner, { ...setup, calendarId: "team@group.calendar.google.com", direction: "both", intervalMinutes: 15 }))) === "forbidden", "…and can't be set up to write back");

  // Back to reading only: what waits is dropped.
  const readOnly = await updateGcalSync(ids.owner, databaseId, { direction: "read" });
  check(readOnly.direction === "read" && readOnly.pendingWrites === 0, "reading only again drops the changes waiting", readOnly);

  // Changing and stopping
  check((await failure(() => updateGcalSync(ids.guest, databaseId, { intervalMinutes: 15 }))) === "access", "only people with full access change a sync");
  const kept = (await rows()).length;
  await stopGcalSync(ids.owner, databaseId);
  check((await getGcalSync(ids.owner, databaseId)) === null && (await rows()).length === kept, "stopping keeps the rows");

  console.log(`\n${passed} checks passed`);
} finally {
  for (const c of await db.select({ id: connection.id }).from(connection).where(inArray(connection.workspaceId, [workspaceId, otherWorkspace]))) dropClient(c.id);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  http.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
