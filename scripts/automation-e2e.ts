/**
 * End-to-end check of database automations against the database: who may manage them and what is
 * refused when saving; which writes start them (new rows however they're made, a property
 * changing, a value becoming an option) and which don't (the same value saved again, a disabled
 * automation, an automation's own changes); setting values (including "now" and "who made the
 * change"), notifying people who can open the row, and signed webhooks with retries; runs as the
 * saver, stopping when they lose full access; run history and the audit log.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/automation-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take the queued runs.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

// Webhooks go to a server on this machine, which only allowed hosts may reach.
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let answers: number[] = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.writeHead(answers.shift() ?? 200);
    res.end();
  });
});
await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const port = (receiver.address() as AddressInfo).port;
process.env.AUTOMATION_WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${port}`;
const hook = `http://127.0.0.1:${port}/hook`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, automationRun, notification, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, createRows, moveRow, updateRowProperties, updateRowsProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { setPagePermission } = await import("@/server/permissions");
const manage = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { webhookSecret } = await import("@/server/automations/webhook");
const { listInbox } = await import("@/server/notifications");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { PropertyValueError } = await import("@/lib/properties");
const { AccessError } = await import("@/server/access");

const RUN = `automation-e2e-${Date.now().toString(36)}`;

registerCollab({
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle() {},
} as unknown as Parameters<typeof registerCollab>[0]);

// Emails are captured instead of sent.
const sent: { to: string; subject: string; text: string }[] = [];
setShareMailer(async (mail) => void sent.push(mail));

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
    (error: unknown) => (error instanceof PropertyValueError && error.code === code) || (code === "access" && error instanceof AccessError),
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, viewer: `${RUN}-viewer`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function values(rowId: string) {
  const [row] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId));
  return row.properties;
}
const runsOf = (automationId: string) =>
  db.select().from(automationRun).where(eq(automationRun.automationId, automationId)).orderBy(automationRun.createdAt);

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
    { id: ids.viewer, name: "Viewer Vera", email: `${ids.viewer}@example.test` },
    { id: ids.outsider, name: "Outsider Oya", email: `${ids.outsider}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.viewer, role: "guest" },
  ]);
  const owner = { userId: ids.owner };
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  const stage = await addProperty(ids.owner, tasks.id, { name: "Stage", type: "select", options: ["Todo", "Done"] });
  const doneAt = await addProperty(ids.owner, tasks.id, { name: "Done at", type: "date" });
  const closer = await addProperty(ids.owner, tasks.id, { name: "Closed by", type: "person" });
  await addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  const flag = await addProperty(ids.owner, tasks.id, { name: "Flag", type: "checkbox" });
  await addProperty(ids.owner, tasks.id, { name: "Total", type: "formula", formula: { expression: "1 + 1" } });
  const optionId = (name: string) => stage.options.options!.find((o) => o.name === name)!.id;
  const DONE = optionId("Done");

  // ------------------------------------------------------------------ managing
  await setPagePermission(ids.owner, tasks.id, ids.viewer, "edit");
  check(await failsWith(manage.listAutomations(ids.viewer, tasks.id), "access"), "someone without full access can't list automations");
  check(
    await failsWith(manage.createAutomation(ids.viewer, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "webhook", url: hook }] }), "access"),
    "…or create one",
  );
  check(
    await failsWith(manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [] }), "invalidAutomation"),
    "an automation needs an action",
  );
  check(
    await failsWith(manage.createAutomation(ids.owner, tasks.id, { name: " ", trigger: { type: "row_created" }, actions: [{ type: "webhook", url: hook }] }), "invalidAutomation"),
    "…and a name",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "property_changed", property: "Nope" }, actions: [{ type: "webhook", url: hook }] }),
      "unknownProperty",
    ),
    "an unknown trigger property is refused",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "property_changed", property: "Stage", to: "Archived" } , actions: [{ type: "webhook", url: hook }] }),
      "unknownOption",
    ),
    "…and a value it doesn't have",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "property_changed", property: "Done at", to: "2026-01-01" }, actions: [{ type: "webhook", url: hook }] }),
      "invalidAutomation",
    ),
    "\"becomes\" only works for select, status, checkbox, person and multi-select",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "set_properties", values: { Total: 3 } }] }),
      "readOnlyProperty",
    ),
    "computed properties can't be set",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "set_properties", values: { Stage: { $: "now" } } }] }),
      "invalidAutomation",
    ),
    "\"now\" only sets dates",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "notify", people: [`${ids.outsider}@example.test`] }] }),
      "invalidAutomation",
    ),
    "people outside the workspace can't be notified",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "webhook", url: "http://10.0.0.5/hook" }] }),
      "webhookBlocked",
    ),
    "webhooks to private addresses are refused",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "webhook", url: "ftp://example.com/x" }] }),
      "invalidWebhookUrl",
    ),
    "…and addresses that aren't http(s)",
  );

  // ------------------------------------------------------------------ "row added" + webhook
  const added = await manage.createAutomation(ids.owner, tasks.id, {
    name: "New task hook",
    trigger: { type: "row_created" },
    actions: [{ type: "webhook", url: hook }],
  });
  check(added.enabled && added.runAs?.id === ids.owner && added.secret?.startsWith("whsec_"), "the owner creates an automation that runs as them, with a secret", added);
  check((await manage.listAutomations(ids.owner, tasks.id)).length === 1, "it is listed");

  const first = await createPage({ userId: ids.member }, { workspaceId, parentId: tasks.id, title: "Write docs", properties: { Stage: "Todo" } });
  await flushAutomations();
  check(received.length === 1, "a row added in the app sends the webhook", await runsOf(added.id));
  const body = JSON.parse(received[0].body);
  check(
    body.event === "row.created" &&
      body.automation.name === "New task hook" &&
      body.row.id === first.id &&
      body.row.title === "Write docs" &&
      body.row.properties.Stage === "Todo" &&
      body.database.title === "Tasks" &&
      body.actor?.id === ids.member &&
      body.changed.includes("Stage"),
    "…with the row by property name, the database and who added it",
    body,
  );
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(received[0].headers["x-leafdesk-signature"])) ?? [];
  check(
    v1 === createHmac("sha256", added.secret!).update(`${t}.${received[0].body}`).digest("hex") &&
      received[0].headers["x-leafdesk-event"] === "row.created" &&
      received[0].headers["x-leafdesk-delivery"] === body.id,
    "…signed with the automation's secret",
    received[0].headers,
  );
  check(webhookSecret("x") !== added.secret, "secrets differ per automation");

  received.length = 0;
  const bulk = await createRows(ids.owner, tasks.id, [{ title: "a" }, { title: "b" }]);
  await flushAutomations();
  check(received.length === 2, "rows added at once (MCP, API, imports, forms) send one webhook each", received.length);
  received.length = 0;
  const copy = await duplicatePage(owner, first.id, " (copy)");
  await flushAutomations();
  check(received.length === 1 && JSON.parse(received[0].body).row.id === copy.id, "a duplicated row counts as added");
  received.length = 0;
  await updateRowProperties(ids.owner, first.id, { Stage: "Done" });
  await flushAutomations();
  check(received.length === 0, "changing a row doesn't start a \"row added\" automation");

  // Retries
  answers = [503];
  await createPage(owner, { workspaceId, parentId: tasks.id, title: "retry me" });
  await flushAutomations();
  let [retrying] = (await runsOf(added.id)).slice(-1);
  check(retrying.status === "pending" && retrying.steps[0].httpStatus === 503 && retrying.nextAt > new Date(), "a 503 is tried again later", retrying);
  await db.update(automationRun).set({ nextAt: new Date() }).where(eq(automationRun.id, retrying.id));
  await flushAutomations();
  [retrying] = (await runsOf(added.id)).slice(-1);
  check(
    retrying.status === "done" && retrying.steps[0].attempts === 2 && received.at(-1)!.body === received.at(-2)!.body,
    "…and the retry sends the same body",
    retrying,
  );
  answers = [400];
  await createPage(owner, { workspaceId, parentId: tasks.id, title: "bad request" });
  await flushAutomations();
  const [refused] = (await runsOf(added.id)).slice(-1);
  check(refused.status === "failed" && refused.steps[0].httpStatus === 400, "a 400 fails without a retry", refused);

  await manage.updateAutomation(ids.owner, added.id, { enabled: false });
  received.length = 0;
  await createPage(owner, { workspaceId, parentId: tasks.id, title: "quiet" });
  await flushAutomations();
  check(received.length === 0, "a disabled automation doesn't run");

  const rotated = await manage.rotateAutomationSecret(ids.owner, added.id);
  check(rotated.secret && rotated.secret !== added.secret, "replacing the secret gives a new one");
  const pings = await manage.testAutomationWebhooks(ids.owner, added.id);
  check(pings.length === 1 && pings[0].ok && JSON.parse(received.at(-1)!.body).event === "ping", "a test sends a ping", pings);

  // ------------------------------------------------------------------ "becomes Done" sets values and notifies
  const closing = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Close",
    trigger: { type: "property_changed", property: "Stage", to: "Done" },
    actions: [
      { type: "set_properties", values: { "Done at": { $: "now" }, "Closed by": { $: "actor" }, Flag: true } },
      { type: "notify", people: ["me"], properties: ["Assignee"] },
    ],
  });
  const stored = closing.trigger as { type: string; propertyId?: string; to?: unknown };
  check(stored.type === "property_changed" && stored.propertyId === stage.id && stored.to === DONE, "the trigger is stored by ids", stored);
  // Changes made by the closing automation must not start this one.
  const chained = await manage.createAutomation(ids.owner, tasks.id, {
    name: "On flag",
    trigger: { type: "property_changed", property: "Flag", to: true },
    actions: [{ type: "set_properties", values: { Stage: "Todo" } }],
  });

  const second = await createPage(owner, {
    workspaceId,
    parentId: tasks.id,
    title: "Ship it",
    properties: { Stage: "Todo", Assignee: [ids.member, ids.viewer] },
  });
  await setPagePermission(ids.owner, second.id, ids.viewer, "none");
  await updateRowProperties(ids.member, second.id, { Stage: "Done" });
  await flushAutomations();
  const after = await values(second.id);
  check(
    after[doneAt.id] === new Date().toISOString().slice(0, 10) && same(after[closer.id], [ids.member]) && after[flag.id] === true,
    "becoming Done sets the day, who did it and the checkbox",
    after,
  );
  check(after[stage.id] === DONE, "the automation's own change (Flag) starts no other automation", after);
  check((await runsOf(chained.id)).length === 0, "…so nothing ran for it");
  const told = await db
    .select({ userId: notification.userId, actorId: notification.actorId })
    .from(notification)
    .where(and(eq(notification.pageId, second.id), eq(notification.kind, "automation")));
  check(
    same(told.map((n) => n.userId).sort(), [ids.member, ids.owner].sort()) && told.every((n) => n.actorId === ids.member),
    "the owner and the assignee are notified; an assignee who can't open the row isn't",
    told,
  );
  const inbox = await listInbox(ids.owner, workspaceId);
  const item = inbox.find((n) => n.kind === "automation" && n.pageId === second.id);
  check(item?.automationName === "Close" && item.databaseTitle === "Tasks", "it shows in the inbox with the automation's name", item);
  sent.length = 0;
  await flushShareEmails();
  const automationMails = sent.filter((m) => m.subject.includes("Close"));
  check(
    same(automationMails.map((m) => m.to).sort(), [`${ids.member}@example.test`, `${ids.owner}@example.test`].sort()) &&
      automationMails.every((m) => m.text.includes("Ship it") && m.text.includes("Member Mert")),
    "…and comes by email to the same people, naming the automation, the row and who changed it",
    automationMails.map((m) => ({ to: m.to, subject: m.subject })),
  );
  const [closeRun] = await runsOf(closing.id);
  check(closeRun.status === "done" && closeRun.steps[1].notified === 2, "the run is done and says how many were told", closeRun);

  await updateRowProperties(ids.member, second.id, { Stage: "Done" });
  await flushAutomations();
  check((await runsOf(closing.id)).length === 1, "saving Done again doesn't run it again");

  // Bulk edits and board drags start it too
  await updateRowsProperties(ids.owner, tasks.id, bulk.map((r) => r.id), { Stage: "Done" });
  await flushAutomations();
  check((await runsOf(closing.id)).length === 3, "a bulk edit runs it for each row");
  const dragged = await createPage(owner, { workspaceId, parentId: tasks.id, title: "drag", properties: { Stage: "Todo" } });
  await moveRow(ids.owner, dragged.id, { groupBy: stage.id, groupValue: DONE });
  await flushAutomations();
  check((await runsOf(closing.id)).length === 4 && (await values(dragged.id))[flag.id] === true, "so does dragging a card to Done");

  // ------------------------------------------------------------------ runs as the saver
  await setPagePermission(ids.owner, tasks.id, ids.viewer, "full");
  await manage.updateAutomation(ids.viewer, closing.id, {});
  check((await manage.listAutomations(ids.owner, tasks.id)).find((a) => a.id === closing.id)?.runAs?.id === ids.viewer, "saving makes the saver the one it runs as");
  await setPagePermission(ids.owner, tasks.id, ids.viewer, "edit");
  const third = await createPage(owner, { workspaceId, parentId: tasks.id, title: "no access", properties: { Stage: "Todo" } });
  await updateRowProperties(ids.owner, third.id, { Stage: "Done" });
  await flushAutomations();
  const [lost] = (await runsOf(closing.id)).slice(-1);
  check(
    lost.status === "failed" && lost.steps.every((s) => s.code === "noAccess") && !(await values(third.id))[flag.id],
    "once they lose full access, it fails without doing anything",
    lost,
  );

  // ------------------------------------------------------------------ history, audit, delete
  const history = await manage.listAutomationRuns(ids.owner, closing.id);
  check(history.length === 5 && history[0].rowTitle === "no access" && history[0].status === "failed", "the history lists runs newest first", history.map((h) => h.rowTitle));
  const audit = await db
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(eq(auditEvent.workspaceId, workspaceId));
  const actions = audit.map((a) => a.action);
  check(
    actions.filter((a) => a === "automation.created").length === 3 && actions.includes("automation.updated"),
    "creating and changing automations is in the audit log",
    actions,
  );
  await manage.deleteAutomation(ids.owner, closing.id);
  check((await runsOf(closing.id)).length === 0 && actions.length > 0, "deleting an automation takes its runs");
  check(
    (await db.select({ action: auditEvent.action }).from(auditEvent).where(eq(auditEvent.workspaceId, workspaceId))).some(
      (a) => a.action === "automation.deleted",
    ),
    "…and is in the audit log",
  );

  console.log(`\n${passed} checks passed`);
} finally {
  receiver.close();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
