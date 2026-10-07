/**
 * End-to-end check of repeating row templates (server/schedules) against the database: who may set
 * a repeat and what is refused; a due schedule adding one row from its template (with the day in
 * its title, its values, and starting the database's automations); a server that was down catching
 * up with one row, not one per missed run; two workers never adding the same run twice; pausing
 * when whoever set it loses access or their account, and carrying on when set again; nothing added
 * while the database is in the trash; stopping, and going with the template.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/schedule-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own workers would take the schedules and runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}
process.env.AUTOMATION_WEBHOOK_ALLOWED_HOSTS = "127.0.0.1:9";

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { automationRun, page, schedule, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, listRowTemplateSummaries } = await import("@/server/databases");
const { archivePage, createPage, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { createRowTemplate, deleteTemplate } = await import("@/server/templates");
const manage = await import("@/server/automations/manage");
const schedules = await import("@/server/schedules");
const { AccessError } = await import("@/server/access");
const { dayString, localDay } = await import("@/lib/time-zone");

const RUN = `schedule-e2e-${Date.now().toString(36)}`;

registerCollab({
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle() {},
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

async function failsWith(promise: Promise<unknown>, code: string) {
  return promise.then(
    () => false,
    (error: unknown) => (code === "access" ? error instanceof AccessError : (error as { code?: unknown }).code === code),
  );
}

const ids = { owner: `${RUN}-owner`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const ZONE = "Europe/Istanbul";
const DAY_MS = 86_400_000;

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const owner = { userId: ids.owner };
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Meetings" });
  const stage = await addProperty(ids.owner, tasks.id, { name: "Stage", type: "select", options: ["Todo", "Done"] });
  const TODO = stage.options.options!.find((o) => o.name === "Todo")!.id;
  const template = await createRowTemplate(owner, tasks.id, { title: "Weekly sync", properties: { Stage: "Todo" } });
  const automation = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Ping",
    trigger: { type: "row_created" },
    actions: [{ type: "webhook", url: "http://127.0.0.1:9/hook" }],
  });

  const rows = () =>
    db
      .select({ id: page.id, title: page.title, properties: page.properties, createdBy: page.createdBy })
      .from(page)
      .where(and(eq(page.parentId, tasks.id), eq(page.isTemplate, false)));
  const stored = async () => (await db.select().from(schedule).where(eq(schedule.templateId, template.id)))[0];
  const makeDue = (at: Date) => db.update(schedule).set({ nextRunAt: at }).where(eq(schedule.templateId, template.id));
  const today = dayString(localDay(Date.now(), ZONE));
  const daily = { frequency: "daily", interval: 1, weekdays: [], time: "09:00", start: today };

  // ------------------------------------------------------------------ setting
  await setPagePermission(ids.owner, tasks.id, ids.guest, "view");
  check(await failsWith(schedules.setTemplateRepeat(ids.guest, template.id, { rule: daily, timeZone: ZONE }), "access"), "someone who can't add rows can't make a template repeat");
  check(await failsWith(schedules.setTemplateRepeat(ids.owner, template.id, { rule: { ...daily, time: "25:00" }, timeZone: ZONE }), "invalidRepeat"), "an invalid rule is refused");
  check(await failsWith(schedules.setTemplateRepeat(ids.owner, template.id, { rule: daily, timeZone: "Mars/Base" }), "invalidRepeat"), "…and an unknown time zone");
  check(await failsWith(schedules.setTemplateRepeat(ids.owner, tasks.id, { rule: daily, timeZone: ZONE }), "notATemplate"), "…and something that isn't a row template");

  const before = Date.now();
  const set = await schedules.setTemplateRepeat(ids.owner, template.id, { rule: daily, timeZone: ZONE, dateInTitle: true });
  check(set.enabled && set.nextRunAt && Date.parse(set.nextRunAt) > before && Date.parse(set.nextRunAt) <= before + DAY_MS, "the next run is within a day", set);
  check(set.rule.frequency === "daily" && set.timeZone === ZONE && set.dateInTitle, "the rule reads back");
  const summary = (await listRowTemplateSummaries(ids.owner, tasks.id)).find((t) => t.id === template.id);
  check(summary?.repeat?.enabled && summary.repeat.nextRunAt === set.nextRunAt, "the template menu shows it repeating", summary);
  check((await stored()).runAs === ids.owner, "it runs as whoever set it");

  // ------------------------------------------------------------------ running
  const now = new Date();
  const missed = new Date(now.getTime() - 3 * DAY_MS);
  await makeDue(missed);
  check((await schedules.runDueSchedules(now)) === 1, "a due schedule runs");
  let list = await rows();
  check(list.length === 1, "it adds one row, not one per missed day", list);
  const row = list[0];
  check(row.title === `Weekly sync ${dayString(localDay(missed.getTime(), ZONE))}`, "the row has the template's title and the day it was due", row.title);
  check(row.properties[stage.id] === TODO, "…and the template's values", row.properties);
  check(row.createdBy === ids.owner, "…added by whoever set the repeat");
  const afterRun = await stored();
  check(afterRun.nextRunAt! > now && afterRun.nextRunAt!.getTime() <= now.getTime() + DAY_MS, "the next run moves past now");
  check(afterRun.lastRunAt?.getTime() === now.getTime() && afterRun.lastError === null, "the run is recorded");
  const queued = await db.select().from(automationRun).where(and(eq(automationRun.automationId, automation.id), eq(automationRun.rowId, row.id)));
  check(queued.length === 1 && queued[0].created, "the new row starts the database's row-created automations");

  check((await schedules.runDueSchedules(now)) === 0 && (await rows()).length === 1, "running again adds nothing");

  await makeDue(new Date(now.getTime() - 1000));
  const [a, b] = await Promise.all([schedules.runDueSchedules(now), schedules.runDueSchedules(now)]);
  check(a + b === 1 && (await rows()).length === 2, "two workers at once add the run once", { a, b });

  await schedules.setTemplateRepeat(ids.owner, template.id, { rule: daily, timeZone: ZONE, dateInTitle: false });
  await makeDue(new Date(now.getTime() - 1000));
  await schedules.runDueSchedules(now);
  list = await rows();
  check(list.length === 3 && list.filter((r) => r.title === "Weekly sync").length === 1, "without the day, the row keeps the template's title");

  // ------------------------------------------------------------------ pausing
  await setPagePermission(ids.owner, tasks.id, ids.guest, "edit");
  await schedules.setTemplateRepeat(ids.guest, template.id, { rule: daily, timeZone: ZONE });
  check((await stored()).runAs === ids.guest, "setting it again makes it run as the new person");
  await setPagePermission(ids.owner, tasks.id, ids.guest, "view");
  await makeDue(new Date(now.getTime() - 1000));
  await schedules.runDueSchedules(now);
  let paused = await stored();
  check(!paused.enabled && paused.lastError === "accessLost" && paused.nextRunAt === null, "it pauses when they can no longer add rows", paused);
  check((await rows()).length === 3, "…and adds nothing");
  check((await schedules.runDueSchedules(new Date(now.getTime() + 2 * DAY_MS))) === 0, "a paused schedule doesn't run");
  const pausedSummary = (await listRowTemplateSummaries(ids.owner, tasks.id)).find((t) => t.id === template.id);
  check(pausedSummary?.repeat && !pausedSummary.repeat.enabled && pausedSummary.repeat.lastError === "accessLost", "the menu shows why it's paused");

  const resumed = await schedules.setTemplateRepeat(ids.owner, template.id, { rule: daily, timeZone: ZONE });
  check(resumed.enabled && resumed.lastError === null && resumed.nextRunAt, "saving it again turns it back on");

  await db.update(schedule).set({ runAs: null }).where(eq(schedule.templateId, template.id));
  await makeDue(new Date(now.getTime() - 1000));
  await schedules.runDueSchedules(now);
  paused = await stored();
  check(!paused.enabled && paused.lastError === "runAsGone", "it pauses when their account is gone");

  // ------------------------------------------------------------------ the trash
  await schedules.setTemplateRepeat(ids.owner, template.id, { rule: daily, timeZone: ZONE });
  const lastRowAt = (await stored()).lastRunAt;
  await archivePage(ids.owner, tasks.id);
  await makeDue(new Date(now.getTime() - 1000));
  await schedules.runDueSchedules(now);
  const inTrash = await stored();
  check(inTrash.enabled && inTrash.lastError === null && (await rows()).length === 3, "a database in the trash gets no rows and the repeat carries on");
  check(inTrash.lastRunAt?.getTime() === lastRowAt?.getTime(), "…and its last row stays the one actually added");
  await restorePage(ids.owner, tasks.id);

  // ------------------------------------------------------------------ stopping
  await schedules.removeTemplateRepeat(ids.owner, template.id);
  check((await stored()) === undefined && (await schedules.getTemplateRepeat(ids.owner, template.id)) === null, "it can stop repeating");
  await schedules.setTemplateRepeat(ids.owner, template.id, { rule: daily, timeZone: ZONE });
  await deleteTemplate(ids.owner, template.id);
  check((await db.select().from(schedule).where(eq(schedule.workspaceId, workspaceId))).length === 0, "deleting the template deletes its repeat");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  process.exit(process.exitCode ?? 0);
}
