/**
 * End-to-end check of calendar syncs against the database and a calendar served here (an HTTP
 * server on 127.0.0.1): a private address and what isn't a calendar are refused; setting one up
 * makes a database of the calendar's events (title, When, place, notes, status, organizer, link,
 * each occurrence of a repeating event a row of its own) with a calendar view, and keeps the
 * address sealed; a due run writes the calendar's changes over, adds new events and keeps rows of
 * events that left it; a calendar that asks for a sign-in pauses the sync, a new address starts it
 * again; stopping keeps the rows. Creates its own user and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/ical-sync-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's sweep would run the syncs it makes due.
 */
export {};

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

const RUN = `ical-${Date.now()}`;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");

let events = [
  ["UID:launch@test", "SUMMARY:Launch review", `DTSTART:${day(3)}T090000Z`, `DTEND:${day(3)}T100000Z`, "LOCATION:Room 2", "STATUS:CONFIRMED", "ORGANIZER;CN=Ada:mailto:ada@example.test", "URL:https://meet.example.test/launch"],
  ["UID:offsite@test", "SUMMARY:Offsite", `DTSTART;VALUE=DATE:${day(10)}`, `DTEND;VALUE=DATE:${day(12)}`, "DESCRIPTION:Bring a laptop"],
  ["UID:weekly@test", "SUMMARY:Weekly sync", `DTSTART:${day(1)}T080000Z`, "DURATION:PT30M", "RRULE:FREQ=WEEKLY;COUNT=3"],
];
let status = 200;
const ics = () =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Team calendar", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const server = createServer((req, res) => {
  if (req.url?.startsWith("/not-a-calendar")) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<html></html>");
  }
  res.writeHead(status, { "content-type": "text/calendar" });
  res.end(status === 200 ? ics() : "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// The calendar is on this machine: let the connections' fetch reach its port (read on each fetch).
process.env.CONNECTOR_ALLOWED_HOSTS = `127.0.0.1:${(server.address() as AddressInfo).port}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseSync, databaseView, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { getProperties } = await import("@/server/databases");
const { createIcalSync, getIcalSync, stopIcalSync, updateIcalSync } = await import("@/server/ical-sync/manage");
const { runDueSyncs } = await import("@/server/jira-sync/run");

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

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const owner = `${RUN}-owner`;
const workspaceId = `${RUN}-ws`;
const actor = { userId: owner };
const rowsOf = async (databaseId: string) =>
  (await db.select({ title: page.title, properties: page.properties, archivedAt: page.archivedAt }).from(page).where(eq(page.parentId, databaseId))).filter(
    (r) => !r.archivedAt,
  );

try {
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: owner, role: "owner" });

  // Refused before anything is made.
  check((await outcome(() => createIcalSync(actor, { workspaceId, parentId: null, url: "https://10.0.0.1/cal.ics" }))) === "invalidSite", "a private address is refused");
  check((await outcome(() => createIcalSync(actor, { workspaceId, parentId: null, url: "ftp://cal.example.test/a.ics" }))) === "invalidInput", "what isn't an address is refused");
  check((await outcome(() => createIcalSync(actor, { workspaceId, parentId: null, url: `${base}/not-a-calendar` }))) === "notFound", "a page that isn't a calendar is refused");

  // Set up: a database of the events, with a calendar view.
  const result = await createIcalSync(actor, { workspaceId, parentId: null, url: `${base}/team.ics?key=secret` });
  const databaseId = result.pages[0].id;
  check(result.pages[0].title === "Team calendar" && result.created.rows === 5, "the calendar's events become rows, each occurrence its own", result);
  const props = await getProperties(databaseId);
  const prop = (name: string) => props.find((p) => p.name === name)!;
  const rows = await rowsOf(databaseId);
  const launch = rows.find((r) => r.title === "Launch review")!;
  check(
    launch.properties[prop("Location").id] === "Room 2" &&
      launch.properties[prop("Organizer").id] === "Ada <ada@example.test>" &&
      launch.properties[prop("Link").id] === "https://meet.example.test/launch" &&
      String(launch.properties[prop("When").id]).includes("T09:00:00.000Z/"),
    "an event's fields go to their properties",
    launch.properties,
  );
  const statusProp = prop("Status");
  check(launch.properties[statusProp.id] === statusProp.options.options?.find((o) => o.name === "Confirmed")?.id, "the status is an option");
  const offsite = rows.find((r) => r.title === "Offsite")!;
  check(/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/.test(String(offsite.properties[prop("When").id])), "a whole-day event spans its days", offsite.properties);
  check(rows.filter((r) => r.title === "Weekly sync").length === 3, "a repeating event has a row per occurrence");
  const views = await db.select().from(databaseView).where(eq(databaseView.databaseId, databaseId));
  check(views.some((v) => v.type === "calendar" && v.config.dateBy === prop("When").id), "a calendar view goes by When");
  const [stored] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  check(stored.source === "ical" && stored.siteUrl === base && !stored.secrets.includes("secret") && !JSON.stringify(stored.query).includes("secret"), "the address is kept sealed", stored);
  const shown = await getIcalSync(owner, databaseId);
  check(shown?.host === new URL(base).host && !JSON.stringify(shown).includes("secret"), "the sync's dialog shows the host only", shown);

  // A due run writes changes over, adds new events and keeps rows of events that left.
  events = [
    events[0].map((l) => (l.startsWith("SUMMARY") ? "SUMMARY:Launch review (moved)" : l.startsWith("STATUS") ? "STATUS:CANCELLED" : l)),
    events[2],
    ["UID:new@test", "SUMMARY:New event", `DTSTART:${day(5)}T130000Z`],
  ];
  await db.update(databaseSync).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(databaseSync.databaseId, databaseId));
  await runDueSyncs();
  const after = await rowsOf(databaseId);
  const moved = after.find((r) => r.title === "Launch review (moved)");
  check(Boolean(moved) && moved!.properties[statusProp.id] === statusProp.options.options?.find((o) => o.name === "Cancelled")?.id, "a run writes the calendar's changes over", moved);
  check(after.some((r) => r.title === "New event") && after.some((r) => r.title === "Offsite"), "new events come in, events that left keep their rows");

  // A calendar that asks for a sign-in pauses the sync; a new address starts it again.
  status = 401;
  await db.update(databaseSync).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(databaseSync.databaseId, databaseId));
  await runDueSyncs();
  const paused = await getIcalSync(owner, databaseId);
  check(paused?.lastError === "unauthorized" && !paused.enabled, "a calendar asking for a sign-in pauses the sync", paused);
  status = 200;
  const resumed = await updateIcalSync(owner, databaseId, { url: `${base}/team.ics?key=new` });
  check(resumed.enabled && resumed.lastError === null, "a new address starts it again", resumed);

  // Stopping keeps the rows.
  const count = (await rowsOf(databaseId)).length;
  await stopIcalSync(owner, databaseId);
  check((await getIcalSync(owner, databaseId)) === null && (await rowsOf(databaseId)).length === count, "stopping keeps the rows");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(eq(user.id, owner));
  hocuspocus.closeConnections();
  server.close();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
