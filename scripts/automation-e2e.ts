/**
 * End-to-end check of database automations against the database: who may manage them and what is
 * refused when saving; which writes start them (new rows however they're made, a property
 * changing, a value becoming an option) and which don't (the same value saved again, a disabled
 * automation, an automation's own changes); setting values (including "now" and "who made the
 * change"), notifying people who can open the row, and signed webhooks with retries; runs as the
 * saver, stopping when they lose full access; Send to Slack (addresses checked, sealed, kept on
 * save, the message escaped with the row's link); run history and the audit log; a threshold over
 * a view's rows (once per crossing: down, staying down, back up, down again).
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
const received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let answers: number[] = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url ?? "", headers: req.headers, body });
    res.writeHead(answers.shift() ?? 200);
    res.end();
  });
});
await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const port = (receiver.address() as AddressInfo).port;
process.env.AUTOMATION_WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${port}`;
const hook = `http://127.0.0.1:${port}/hook`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, databaseAutomation: automationTable, automationRun, automationThreshold, notification, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { runEvent } = await import("@/lib/automations");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, addView, createRows, moveRow, updateRowProperties, updateRowsProperties } = await import("@/server/databases");
const { archiveRows, createPage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { setPagePermission } = await import("@/server/permissions");
const manage = await import("@/server/automations/manage");
const quick = await import("@/server/automations/slack-setup");
const { flushAutomations } = await import("@/server/automations/run");
const { MAX_WAITING_RUNS, onThresholdRows } = await import("@/server/automations/queue");
const { runThresholdAutomations } = await import("@/server/automations/threshold");
const { webhookSecret } = await import("@/server/automations/webhook");
const { listInbox } = await import("@/server/notifications");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { PropertyValueError } = await import("@/lib/properties");
const { updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");

const RUN = `automation-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
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
  // A guest with full access names people by id, as in person properties: matching an address or a
  // name would tell them who is in the workspace.
  await setPagePermission(ids.owner, tasks.id, ids.viewer, "full");
  const guestNotify = (person: string) =>
    manage.createAutomation(ids.viewer, tasks.id, { name: "Tell", trigger: { type: "row_created" }, actions: [{ type: "notify", people: [person] }] });
  check(await failsWith(guestNotify(`${ids.member}@example.test`), "invalidAutomation"), "a guest can't name a member by address");
  check(await failsWith(guestNotify("Member Mert"), "invalidAutomation"), "…nor by name");
  const byId = await guestNotify(ids.member);
  check(byId.actions[0].type === "notify" && byId.actions[0].userIds.join() === ids.member, "…but by id", byId.actions);
  await manage.deleteAutomation(ids.viewer, byId.id);
  await setPagePermission(ids.owner, tasks.id, ids.viewer, "edit");
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
  const copy = await duplicatePage(owner, first.id);
  await flushAutomations();
  check(received.length === 1 && JSON.parse(received[0].body).row.id === copy.id, "a duplicated row counts as added");
  received.length = 0;
  // A row is the user's own content: sent as it is, whatever it holds (made-up token, put together
  // here so this file holds nothing a secret scanner flags).
  const keyTitle = `Deploy key ${"gh" + "p_" + "A1b2C3d4".repeat(5)}`;
  await createPage(owner, { workspaceId, parentId: tasks.id, title: keyTitle });
  await flushAutomations();
  check(received.length === 1 && JSON.parse(received[0].body).row.title === keyTitle, "a row is sent as it is, even what looks like a credential", received[0]?.body.slice(0, 300));
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
  // Due by the database's clock, the one the worker compares with: this script's clock runs a
  // little ahead of it under Docker Desktop (about a millisecond), and a time taken here left the
  // run not yet due about one run in three.
  await db.update(automationRun).set({ nextAt: sql`now()` }).where(eq(automationRun.id, retrying.id));
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

  // ------------------------------------------------------------------ Send to Slack
  // Slack's own addresses, or (as here) one on a host the administrator allows.
  const slackPath = "/services/T0001/B0002/sl4ckS3cret";
  const slackHook = `http://127.0.0.1:${port}${slackPath}`;
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "slack", url: "https://example.com/services/T/B/x", message: "hi" }] }),
      "invalidSlackUrl",
    ),
    "Send to Slack refuses an address that isn't a Slack incoming webhook",
  );
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "slack", url: "https://hooks.slack.com/other/x", message: "hi" }] }),
      "invalidSlackUrl",
    ),
    "…and a hooks.slack.com address that isn't a webhook's",
  );
  const slack = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Flagged to Slack",
    trigger: { type: "property_changed", property: "Flag", to: true },
    actions: [{ type: "slack", url: slackHook, message: "*Flagged* by {{trigger.actor.name}}: {{trigger.title}}" }],
  });
  const slackStep = slack.actions[0];
  check(
    slackStep.type === "slack" && !("sealed" in slackStep) && slackStep.hint === `127.0.0.1:${port}/services/…cret` && !JSON.stringify(slack).includes("sl4ckS3cret"),
    "a Slack step is shown by a hint of its address, never the address",
    slack.actions,
  );
  check(!JSON.stringify(await manage.listAutomations(ids.owner, tasks.id)).includes("sl4ckS3cret"), "…in the list too");
  const [storedSlack] = await db.select({ actions: automationTable.actions }).from(automationTable).where(eq(automationTable.id, slack.id));
  const storedStep = storedSlack.actions[0] as { sealed?: string };
  check(!!storedStep.sealed && !storedStep.sealed.includes("sl4ckS3cret"), "…and it is stored sealed", storedSlack.actions);

  received.length = 0;
  const flaggedRow = await createPage(owner, { workspaceId, parentId: tasks.id, title: "<!channel> & co" });
  await flushAutomations();
  received.length = 0;
  await updateRowProperties(ids.member, flaggedRow.id, { Flag: true });
  await flushAutomations();
  const posted = received.filter((r) => r.url === slackPath);
  const slackText = posted.length ? (JSON.parse(posted[0].body) as { text: string }).text : "";
  check(
    posted.length === 1 &&
      slackText.startsWith("*Flagged* by Member Mert: &lt;!channel&gt; &amp; co\n<") &&
      slackText.endsWith(`/p/${flaggedRow.id}|&lt;!channel&gt; &amp; co>`),
    "the message goes to Slack with its markup, the row's values escaped and the row's link last",
    { posted, slackText },
  );
  const [slackRun] = await runsOf(slack.id);
  check(slackRun.status === "done" && !JSON.stringify(slackRun.steps).includes("sl4ckS3cret"), "the run history names the address by its hint only", slackRun.steps);

  const kept = await manage.updateAutomation(ids.owner, slack.id, {
    name: "Flagged to Slack",
    actions: [{ type: "slack", id: slackStep.id, urlFrom: slackStep.id, message: "Flagged: {{trigger.title}}" }],
  });
  check(kept.actions[0].type === "slack" && kept.actions[0].hint === slackStep.hint, "saving without the address keeps the saved one", kept.actions);
  check(
    await failsWith(
      manage.updateAutomation(ids.owner, slack.id, { name: "Flagged to Slack", actions: [{ type: "slack", id: "other", message: "x" }] }),
      "invalidAutomation",
    ),
    "…but a new step without an address is refused",
  );
  received.length = 0;
  await updateRowProperties(ids.member, flaggedRow.id, { Flag: false });
  await updateRowProperties(ids.member, flaggedRow.id, { Flag: true });
  await flushAutomations();
  const again = received.filter((r) => r.url === slackPath);
  check(again.length === 1 && JSON.parse(again[0].body).text.startsWith("Flagged: &lt;!channel&gt;"), "…and posts there with the new message", again);
  answers = [404];
  await updateRowProperties(ids.member, flaggedRow.id, { Flag: false });
  await updateRowProperties(ids.member, flaggedRow.id, { Flag: true });
  await flushAutomations();
  const [, gone] = (await runsOf(slack.id)).slice(-2);
  check(gone.status === "failed" && /^Slack answered 404/.test(gone.steps[0].error ?? "") && !JSON.stringify(gone).includes("sl4ckS3cret"), "a 404 from Slack fails the run without showing the address", gone);
  answers = [];
  await manage.deleteAutomation(ids.owner, slack.id);

  // The menu's quick setup makes the same kind of automation, from ids as its form sends them.
  const quickDone = await quick.createSlackAutomation(ids.owner, tasks.id, { name: "Slack: Stage is Done", url: slackHook, message: "Done: {{trigger.title}}", when: stage.id, to: DONE });
  const quickFlag = await quick.createSlackAutomation(ids.owner, tasks.id, { name: "Slack: Flag", url: slackHook, message: "Flagged", when: flag.id, to: true });
  const quickAdded = await quick.createSlackAutomation(ids.owner, tasks.id, { name: "Slack: new rows", url: slackHook, message: "New", when: "row_created" });
  check(
    quickDone.trigger.type === "property_changed" &&
      quickDone.trigger.propertyId === stage.id &&
      quickDone.trigger.to === DONE &&
      quickFlag.trigger.type === "property_changed" &&
      quickFlag.trigger.to === true &&
      quickAdded.trigger.type === "row_created" &&
      quickDone.enabled,
    "the Slack quick setup makes published automations for a value, a checkbox and new rows",
    [quickDone.trigger, quickFlag.trigger, quickAdded.trigger],
  );
  const setup = await quick.slackSetup(ids.owner, tasks.id);
  check(
    setup.automations.map((a) => a.name).sort().join() === "Slack: Flag,Slack: Stage is Done,Slack: new rows" &&
      setup.automations.every((a) => a.hints[0] === slackStep.hint) &&
      !JSON.stringify(setup).includes("sl4ckS3cret") &&
      setup.properties.some((p) => p.id === stage.id && p.options.length === 2),
    "…and lists them by the hint of their address, with the properties it can watch",
    setup,
  );
  check(await failsWith(quick.slackSetup(ids.viewer, tasks.id), "access"), "…only for people with full access");
  received.length = 0;
  const quickRow = await createPage(owner, { workspaceId, parentId: tasks.id, title: "quick" });
  await updateRowProperties(ids.owner, quickRow.id, { Stage: "Done" });
  await flushAutomations();
  const quickTexts = received.filter((r) => r.url === slackPath).map((r) => (JSON.parse(r.body) as { text: string }).text.split("\n")[0]).sort();
  check(quickTexts.join() === "Done: quick,New", "…which post when a row is added and when it becomes Done", quickTexts);
  for (const a of [quickDone, quickFlag, quickAdded]) await manage.deleteAutomation(ids.owner, a.id);

  // Export off: webhooks send rows out of the workspace, so none is added or sent.
  await updateWorkspaceSettings(ids.owner, workspaceId, { export: false });
  check(
    await failsWith(
      manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "webhook", url: `${hook}?other` }] }),
      "webhookExportOff",
    ),
    "with export off, an automation can't get a webhook",
  );
  const keptHook = await manage.updateAutomation(ids.owner, added.id, { name: "New task hook", actions: [{ type: "webhook", url: hook }] });
  check(keptHook.actions.length === 1, "…though one already saved can stay as it is", keptHook.actions);
  received.length = 0;
  await createPage(owner, { workspaceId, parentId: tasks.id, title: "while export is off" });
  await flushAutomations();
  const [offRun] = (await runsOf(added.id)).slice(-1);
  check(received.length === 0 && offRun.status === "failed" && offRun.steps[0].code === "webhookExportOff", "…and it sends nothing, failing the run", offRun);
  const offPings = await manage.testAutomationWebhooks(ids.owner, added.id);
  check(received.length === 0 && offPings.length === 1 && !offPings[0].ok && offPings[0].code === "webhookExportOff", "…not even a test ping", offPings);
  await updateWorkspaceSettings(ids.owner, workspaceId, { export: true });

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
    // Three here, the four Slack ones and the guest's one above.
    actions.filter((a) => a === "automation.created").length === 8 && actions.includes("automation.updated"),
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

  // ------------------------------------------------------------------ taking turns, at most so many waiting
  const flagged = async (title: string) => {
    const database = await createPage(owner, { workspaceId, kind: "database", title });
    await addProperty(ids.owner, database.id, { name: "Flag", type: "checkbox" });
    const automation = await manage.createAutomation(ids.owner, database.id, {
      name: `${title} flag`,
      trigger: { type: "row_created" },
      actions: [{ type: "set_properties", values: { Flag: true } }],
    });
    return { database, automation };
  };
  const busy = await flagged("Busy");
  const quiet = await flagged("Quiet");
  await createRows(ids.owner, busy.database.id, Array.from({ length: 45 }, (_, i) => ({ title: `busy ${i}` })));
  await createRows(ids.owner, quiet.database.id, [{ title: "quiet" }]);
  await flushAutomations();
  const busyRuns = await runsOf(busy.automation.id);
  const [quietRun] = await runsOf(quiet.automation.id);
  check(busyRuns.length === 45 && busyRuns.every((r) => r.status === "done") && quietRun?.status === "done", "piled-up runs and a lone one all run");
  const before = busyRuns.filter((r) => r.finishedAt! < quietRun.finishedAt!).length;
  check(before < 20, "a database with runs piled up doesn't keep another one waiting behind them", { before });

  const [someRow] = busyRuns;
  const filler = Array.from({ length: MAX_WAITING_RUNS - 2 }, () => ({
    automationId: busy.automation.id,
    rowId: someRow.rowId,
    created: true,
    nextAt: new Date(Date.now() + 24 * 60 * 60_000),
  }));
  for (let i = 0; i < filler.length; i += 1000) await db.insert(automationRun).values(filler.slice(i, i + 1000));
  const logged: unknown[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    await createRows(ids.owner, busy.database.id, Array.from({ length: 5 }, (_, i) => ({ title: `over ${i}` })));
  } finally {
    console.error = consoleError;
  }
  const waiting = await db
    .select({ id: automationRun.id })
    .from(automationRun)
    .where(and(eq(automationRun.automationId, busy.automation.id), eq(automationRun.status, "pending")));
  check(waiting.length === MAX_WAITING_RUNS, `a write queues no more than ${MAX_WAITING_RUNS} waiting runs per database`, waiting.length);
  check(logged.some((l) => String(l).includes("3 runs not queued")), "…and the server log says how many it left out", logged);
  const [overRow] = await db.select({ id: page.id }).from(page).where(and(eq(page.parentId, busy.database.id), eq(page.title, "over 4")));
  check(!!overRow, "the write itself goes through");
  await db.delete(automationRun).where(and(eq(automationRun.automationId, busy.automation.id), eq(automationRun.status, "pending")));

  // ------------------------------------------------------------------ threshold
  const ledger = await createPage(owner, { workspaceId, kind: "database", title: "Ledger" });
  const amount = await addProperty(ids.owner, ledger.id, { name: "Amount", type: "number" });
  const category = await addProperty(ids.owner, ledger.id, { name: "Category", type: "select", options: ["Cash", "Stock"] });
  const cashOption = category.options.options!.find((o) => o.name === "Cash")!.id;
  const stockOption = category.options.options!.find((o) => o.name === "Stock")!.id;
  const cashView = await addView(ids.owner, ledger.id, {
    name: "Cash and bank",
    type: "table",
    config: { filters: [{ propertyId: category.id, op: "equals", value: cashOption }] },
  });
  await addView(ids.owner, ledger.id, { name: "Mine", type: "table", personal: true });
  const [till, bank, stock] = await createRows(ids.owner, ledger.id, [
    { title: "Till", properties: { [amount.id]: 30_000, [category.id]: cashOption } },
    { title: "Bank", properties: { [amount.id]: 30_000, [category.id]: cashOption } },
    { title: "Stock", properties: { [amount.id]: 100_000, [category.id]: stockOption } },
  ]);
  const lowCash = (input: Partial<{ view: string; calculation: string; property: string | null }> = {}) =>
    manage.createAutomation(ids.owner, ledger.id, {
      name: "Low cash",
      trigger: { type: "view_threshold", view: "Cash and bank", calculation: "sum", property: "Amount", comparison: "below", value: 50_000, ...input },
      actions: [{ type: "notify", people: [ids.owner], message: "Cash is {{trigger.value}}, under {{trigger.threshold}} in {{trigger.view.name}}" }],
    });
  check(await failsWith(lowCash({ view: "Mine" }), "invalidAutomation"), "a threshold can't watch a personal view");
  check(await failsWith(lowCash({ property: null }), "invalidAutomation"), "…and a sum needs a number property");
  check(await failsWith(lowCash({ property: "Category" }), "invalidAutomation"), "…that holds numbers");
  const asked: string[] = [];
  onThresholdRows((databaseId) => asked.push(databaseId));
  const threshold = await lowCash();
  check(threshold.trigger.type === "view_threshold" && threshold.trigger.viewId === cashView.id, "a threshold names its view by id", threshold.trigger);
  const crossings = async () => {
    await runThresholdAutomations({ automationIds: [threshold.id] });
    await flushAutomations();
    return db
      .select({ message: notification.message })
      .from(notification)
      .where(and(eq(notification.automationId, threshold.id), eq(notification.userId, ids.owner)));
  };
  check((await crossings()).length === 0, "a value above the line runs nothing");
  await updateRowProperties(ids.owner, till.id, { [amount.id]: 15_000 });
  check(asked.includes(ledger.id), "a write asks for a check of its database's thresholds", asked);
  let alerts = await crossings();
  check(alerts.length === 1 && alerts[0].message === "Cash is 45000, under 50000 in Cash and bank", "going below the line notifies once, with the value", alerts);
  await updateRowProperties(ids.owner, bank.id, { [amount.id]: 10_000 });
  check((await crossings()).length === 1, "staying below runs nothing more");
  await updateRowProperties(ids.owner, stock.id, { [amount.id]: 1 });
  check((await crossings()).length === 1, "rows outside the view don't count");
  await updateRowProperties(ids.owner, till.id, { [amount.id]: 60_000 });
  check((await crossings()).length === 1, "coming back above the line runs nothing");
  await archiveRows(ids.owner, ledger.id, [till.id]);
  alerts = await crossings();
  check(alerts.length === 2 && alerts.some((n) => n.message === "Cash is 10000, under 50000 in Cash and bank"), "…and going below again (a row trashed) notifies again", alerts);
  const [state] = await db.select().from(automationThreshold).where(eq(automationThreshold.automationId, threshold.id));
  check(state?.met === true && state.value === 10_000, "the last check's value is kept", state);
  const thresholdRuns = await runsOf(threshold.id);
  check(
    thresholdRuns.length === 2 && thresholdRuns.every((r) => r.rowId === null && r.status === "done" && runEvent(r) === "threshold.crossed"),
    "each crossing is one run without a row",
    thresholdRuns,
  );
  // Published (or turned on) while past the line: that is where it starts, not a crossing.
  await manage.updateAutomation(ids.owner, threshold.id, { enabled: false });
  await updateRowProperties(ids.owner, bank.id, { [amount.id]: 90_000 });
  await updateRowProperties(ids.owner, bank.id, { [amount.id]: 5_000 });
  await manage.updateAutomation(ids.owner, threshold.id, { enabled: true });
  check((await crossings()).length === 2, "a crossing while it was off doesn't run when it is turned on again");
  const stateOf = async () => (await db.select().from(automationThreshold).where(eq(automationThreshold.automationId, threshold.id)))[0];
  const armed = await stateOf();
  await manage.updateAutomation(ids.owner, threshold.id, { name: "Low cash", actions: [{ type: "log", message: "{{trigger.value}}" }] });
  const afterSteps = await stateOf();
  check(!!armed && afterSteps?.checkedAt.getTime() === armed.checkedAt.getTime(), "publishing other steps keeps where the value stood", { armed, afterSteps });
  await manage.updateAutomation(ids.owner, threshold.id, {
    name: "Low cash",
    trigger: { type: "view_threshold", view: cashView.id, calculation: "sum", property: amount.id, comparison: "below", value: 4_000 },
  });
  const afterLine = await stateOf();
  check(afterLine?.met === false && afterLine.checkedAt > armed!.checkedAt, "another line notes the value afresh", afterLine);
  const counting = await manage.createAutomation(ids.owner, ledger.id, {
    name: "Any cash",
    trigger: { type: "view_threshold", view: cashView.id, comparison: "above", value: 1 },
    actions: [{ type: "log", message: "{{trigger.value}}" }],
  });
  check(counting.trigger.type === "view_threshold" && counting.trigger.fn === "count_all", "counting rows is the default calculation");
  const preview = await manage.previewThreshold(ids.owner, ledger.id, { type: "view_threshold", view: "Cash and bank", comparison: "below", value: 2 });
  check(preview?.value === 1 && preview.met, "the editor's preview counts the view's rows now", preview);

  console.log(`\n${passed} checks passed`);
} finally {
  receiver.close();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
