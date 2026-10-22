/**
 * End-to-end check of automation steps and lifecycle against the database: an automation saved
 * before versions still runs; property changes on several properties with before/after in
 * templates; scheduled runs that find rows and change each one; incoming webhooks (their address,
 * refusals, the rate limit, a new address) that add rows and add-or-update them; HTTP requests
 * with retries against a server on this machine, masked credentials and private addresses refused;
 * waiting runs keeping the version they started with while a new one is published; drafts, test
 * runs and the limits. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/automation-steps-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take the queued runs.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

// HTTP requests go to a server on this machine, which only allowed hosts may reach.
const received: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let answers: { status: number; body?: unknown }[] = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const answer = answers.shift() ?? { status: 200, body: { id: "remote-1", echo: body ? JSON.parse(body) : null } };
    res.writeHead(answer.status, { "content-type": "application/json", "x-request-id": "abc" });
    res.end(JSON.stringify(answer.body ?? {}));
  });
});
await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const port = (receiver.address() as AddressInfo).port;
process.env.AUTOMATION_WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${port}`;
const base = `http://127.0.0.1:${port}`;

const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { automationRun, automationVersion, databaseAutomation, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { addProperty, createRows, updateRowProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const manage = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { runScheduledAutomations } = await import("@/server/automations/scheduled");
const { receiveHook } = await import("@/server/automations/incoming");
const { newSecretSalt } = await import("@/server/automations/webhook");
const { PropertyValueError } = await import("@/lib/properties");
const { INCOMING_PER_MINUTE, MAX_AUTOMATION_ACTIONS } = await import("@/lib/automations");

const RUN = `automation-steps-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  // The collab server's store writes a new title; here it's written at once.
  async setTitle(pageId: string, title: string) {
    await db.update(page).set({ title }).where(eq(page.id, pageId));
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

async function refused(promise: Promise<unknown>, code = "invalidAutomation", reason?: RegExp) {
  return promise.then(
    () => false,
    (error: unknown) =>
      error instanceof PropertyValueError && error.code === code && (!reason || reason.test(String(error.params?.reason ?? error.message))),
  );
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member` };
const workspaceId = `${RUN}-ws`;

async function values(rowId: string) {
  const [row] = await db.select({ title: page.title, properties: page.properties }).from(page).where(eq(page.id, rowId));
  return row;
}
const runsOf = (automationId: string) =>
  db.select().from(automationRun).where(eq(automationRun.automationId, automationId)).orderBy(automationRun.createdAt);
const lastRun = async (automationId: string) => (await runsOf(automationId)).at(-1)!;
const rowsOf = (databaseId: string) =>
  db.select({ id: page.id, title: page.title, properties: page.properties }).from(page).where(and(eq(page.parentId, databaseId), sql`${page.archivedAt} is null`));
const hook = (url: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => {
  const [, automationId, token] = new URL(url).pathname.match(/^\/api\/automations\/([^/]+)\/webhook\/([^/]+)$/)!;
  return receiveHook(automationId, token, new Request(url, { method: "POST", body, headers }));
};

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const owner = { userId: ids.owner };
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  const stage = await addProperty(ids.owner, tasks.id, { name: "Stage", type: "select", options: ["Todo", "Doing", "Done"] });
  const priority = await addProperty(ids.owner, tasks.id, { name: "Priority", type: "number" });
  const note = await addProperty(ids.owner, tasks.id, { name: "Note", type: "text" });
  const flag = await addProperty(ids.owner, tasks.id, { name: "Flag", type: "checkbox" });
  const optionId = (name: string) => stage.options.options!.find((o) => o.name === name)!.id;
  const customers = await createPage(owner, { workspaceId, kind: "database", title: "Customers" });
  const email = await addProperty(ids.owner, customers.id, { name: "Email", type: "email" });
  const plan = await addProperty(ids.owner, customers.id, { name: "Plan", type: "text" });

  // ------------------------------------------------------------------ an automation from before versions
  const [legacy] = await db
    .insert(databaseAutomation)
    .values({
      databaseId: tasks.id,
      workspaceId,
      name: "Saved before versions",
      trigger: { type: "row_created" },
      actions: [{ type: "set_properties", values: { [priority.id]: 1 } }],
      secretSalt: newSecretSalt(),
      runAs: ids.owner,
      createdBy: ids.owner,
    })
    .returning();
  check(legacy.version === 1 && legacy.draft === null, "an automation stored the old way counts as published version 1");
  const [old] = await createRows(ids.owner, tasks.id, [{ title: "old style" }]);
  await flushAutomations();
  check((await values(old.id)).properties[priority.id] === 1, "…and still runs, without a version row of its own");
  const [oldRun] = await runsOf(legacy.id);
  check(oldRun.version === 1 && oldRun.steps[0].id === "step1" && oldRun.steps[0].status === "done", "…its steps get ids in the history", oldRun.steps);
  await db.delete(databaseAutomation).where(eq(databaseAutomation.id, legacy.id));

  // ------------------------------------------------------------------ several properties, before and after
  const watcher = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Watch stage and priority",
    trigger: { type: "property_changed", properties: ["Stage", "Priority"] },
    actions: [
      { id: "note", type: "set_properties", values: { Note: "{{trigger.changes.Stage.before}}→{{trigger.changes.Stage.after}} by {{trigger.actor.name}} ({{trigger.Nope}})" } },
      { type: "log", message: "{{trigger.title}} is now {{trigger.Stage}}, priority {{trigger.Priority}}" },
    ],
  });
  check(watcher.version === 1 && watcher.actions[1].id === "log", "a published automation is version 1, steps without ids get one", watcher.actions);
  const [versionRow] = await db.select().from(automationVersion).where(eq(automationVersion.automationId, watcher.id));
  check(versionRow?.version === 1, "…and its version is kept");
  check(
    await refused(manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "property_changed", properties: ["Stage", "Priority"], to: "Done" }, actions: [{ type: "log", message: "x" }] })),
    "a value to change to takes one property only",
  );
  const [watched] = await createRows(ids.owner, tasks.id, [{ title: "Watched", properties: { [stage.id]: optionId("Todo") } }]);
  await flushAutomations();
  await updateRowProperties(ids.member, watched.id, { Note: "just a note" });
  await flushAutomations();
  check((await runsOf(watcher.id)).length === 0, "a change to another property doesn't start it");
  await updateRowProperties(ids.member, watched.id, { Stage: "Doing" });
  await flushAutomations();
  let run = await lastRun(watcher.id);
  check((await values(watched.id)).properties[note.id] === "Todo→Doing by Member Mert ()", "before, after and who made the change; a missing path is empty", await values(watched.id));
  check(run.steps[1].output && (run.steps[1].output as { message: string }).message === "Watched is now Doing, priority ", "a log step writes its message into the run", run.steps[1]);
  check((run.steps[0].input as { missing?: string[] }).missing?.includes("trigger.Nope"), "…and the history says which paths led nowhere", run.steps[0].input);
  await updateRowProperties(ids.member, watched.id, { Priority: 3 });
  await flushAutomations();
  check((await runsOf(watcher.id)).length === 2, "a change to the second watched property starts it too");
  await manage.deleteAutomation(ids.owner, watcher.id);

  // ------------------------------------------------------------------ schedules, find rows, for each
  check(
    await refused(
      manage.createAutomation(ids.owner, tasks.id, {
        name: "x",
        trigger: { type: "schedule", schedule: { frequency: "daily", time: "09:00" } },
        actions: [{ type: "set_properties", values: { Flag: true } }],
      }),
    ),
    "a schedule has no row: a row step needs a for each",
  );
  check(
    await refused(manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "schedule", schedule: { frequency: "cron", cron: "0 9 30 2 *" } }, actions: [{ type: "log", message: "x" }] })),
    "a schedule that never comes is refused",
  );
  check(
    await refused(
      manage.createAutomation(ids.owner, tasks.id, {
        name: "x",
        trigger: { type: "schedule", schedule: { frequency: "daily", time: "09:00" } },
        actions: [{ type: "find_rows", database: "Tasks", limit: 101 }],
      }),
    ),
    "find rows takes at most 100",
  );
  const sweep = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Morning sweep",
    timeZone: "Europe/Istanbul",
    trigger: { type: "schedule", schedule: { frequency: "weekly", time: "09:00", weekdays: [1, 2, 3, 4, 5] } },
    actions: [
      { id: "todo", type: "find_rows", database: "Tasks", filters: [{ propertyId: stage.id, op: "equals", value: optionId("Todo") }], sorts: [{ propertyId: "title", direction: "asc" }], limit: 10 },
      { type: "set_properties", forEach: "todo", values: { Flag: true, Note: "seen at {{trigger.scheduledFor}} ({{item.title}})" } },
      { type: "log", message: "{{todo.count}} to do, first {{todo.first.title}}" },
    ],
  });
  check(sweep.nextRunAt && new Date(sweep.nextRunAt) > new Date(), "a schedule knows its next run", sweep.nextRunAt);
  const [a] = await createRows(ids.owner, tasks.id, [
    { title: "B todo", properties: { [stage.id]: optionId("Todo") } },
    { title: "A todo", properties: { [stage.id]: optionId("Todo") } },
    { title: "C done", properties: { [stage.id]: optionId("Done") } },
  ]);
  await flushAutomations();
  check((await runScheduledAutomations({ automationIds: [sweep.id] })) === 0, "nothing runs before it's due");
  const due = new Date(Date.now() - 60_000);
  await db.update(databaseAutomation).set({ nextRunAt: due }).where(eq(databaseAutomation.id, sweep.id));
  check((await runScheduledAutomations({ automationIds: [sweep.id] })) === 1, "a due schedule queues a run");
  const [after] = await db.select({ nextRunAt: databaseAutomation.nextRunAt }).from(databaseAutomation).where(eq(databaseAutomation.id, sweep.id));
  check(after.nextRunAt! > new Date(), "…and moves on to its next time");
  check((await runScheduledAutomations({ automationIds: [sweep.id] })) === 0, "…once");
  await flushAutomations();
  run = await lastRun(sweep.id);
  check(run.rowId === null && run.origin === "schedule" && run.status === "done", "a scheduled run has no row", run);
  const flagged = (await rowsOf(tasks.id)).filter((r) => r.properties[flag.id] === true).map((r) => r.title).sort();
  check(JSON.stringify(flagged) === JSON.stringify(["A todo", "B todo"]), "for each changes every found row, only those", flagged);
  check(String((await values(a.id)).properties[note.id]).includes(due.toISOString()) && String((await values(a.id)).properties[note.id]).includes("B todo"), "…with the trigger and the item in its templates", await values(a.id));
  check((run.steps[2].output as { message: string }).message === "2 to do, first A todo", "later steps read the found rows, sorted", run.steps[2]);
  check(run.steps[1].items?.length === 2 && run.steps[1].items.every((i) => i.status === "done"), "the history lists each row for each went over", run.steps[1].items);
  await manage.deleteAutomation(ids.owner, sweep.id);

  // A templated filter value names an option as a row shows it.
  const sameStage = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Count the same stage",
    trigger: { type: "property_changed", property: "Stage" },
    actions: [
      { id: "same", type: "find_rows", database: "Tasks", filters: [{ propertyId: stage.id, op: "equals", value: "{{trigger.Stage}}" }], limit: 100 },
      { type: "set_properties", values: { Priority: "{{same.count}}" } },
    ],
  });
  await updateRowProperties(ids.owner, watched.id, { Stage: "Done" });
  await flushAutomations();
  check((await values(watched.id)).properties[priority.id] === 2, "a templated filter value matches the option by its name", await lastRun(sameStage.id));
  await manage.deleteAutomation(ids.owner, sameStage.id);

  // ------------------------------------------------------------------ incoming webhooks, add and add-or-update rows
  check(
    await refused(manage.createAutomation(ids.owner, customers.id, { name: "x", trigger: { type: "incoming_webhook", example: "{not json" }, actions: [{ type: "log", message: "x" }] })),
    "an example payload must be JSON",
  );
  const intake = await manage.createAutomation(ids.owner, customers.id, {
    name: "Sign-ups",
    trigger: { type: "incoming_webhook", example: { name: "Ada", email: "ada@example.test", plan: "pro" } },
    actions: [
      { id: "customer", type: "upsert_row", database: "Customers", match: { property: "Email", value: "{{trigger.email}}" }, title: "{{trigger.name}}", values: { Plan: "{{trigger.plan}}" } },
      { type: "create_row", database: "Tasks", title: "Welcome {{customer.title}}", values: { Note: "{{customer.url}}", Stage: "Todo" } },
    ],
  });
  check(typeof intake.hookUrl === "string" && intake.hookUrl.includes(`/api/automations/${intake.id}/webhook/`), "an incoming webhook has an address", intake.hookUrl);
  const url = intake.hookUrl!;
  const wrong = url.replace(/[^/]+$/, "nope");
  check((await hook(wrong, "{}")).status === 404, "a wrong address is unknown");
  check((await hook(url, "{nope")).status === 400, "a body that isn't JSON is refused");
  check((await hook(url, JSON.stringify({ pad: "x".repeat(70_000) }))).status === 413, "a body over 64 KB is refused");
  const answer = await hook(url, JSON.stringify({ name: "Ada", email: "ADA@example.test", plan: "pro" }));
  check(answer.status === 202 && typeof answer.body.run_id === "string", "a JSON POST queues a run", answer);
  await flushAutomations();
  run = await lastRun(intake.id);
  check(run.status === "done" && run.origin === "incoming_webhook" && run.rowId === null, "…which runs without a row", run.steps);
  let people = await rowsOf(customers.id);
  check(people.length === 1 && people[0].title === "Ada" && people[0].properties[plan.id] === "pro", "add-or-update adds a row when none matches", people);
  check((run.steps[0].output as { created: boolean }).created === true, "…and says it did");
  check(people[0].properties[email.id] === "ADA@example.test", "…with the value it matches on", people[0].properties);
  const welcome = (await rowsOf(tasks.id)).find((r) => r.title === "Welcome Ada");
  check(welcome && String(welcome.properties[note.id]).includes(people[0].id) && welcome.properties[stage.id] === optionId("Todo"), "add a row writes templates and options into another database", welcome);
  await hook(url, JSON.stringify({ name: "Ada L.", email: "ada@example.test", plan: "team" }));
  await flushAutomations();
  run = await lastRun(intake.id);
  people = await rowsOf(customers.id);
  check(people.length === 1 && people[0].title === "Ada L." && people[0].properties[plan.id] === "team", "…and updates the row that matches", { people, steps: run.steps });
  check((run.steps[0].output as { created: boolean }).created === false, "…and says it updated it");
  const rotated = await manage.rotateAutomationHook(ids.owner, intake.id);
  check(rotated.hookUrl !== url && (await hook(url, "{}")).status === 404, "a new address replaces the old one at once");
  const fresh = rotated.hookUrl!;
  let limited = 0;
  for (let i = 0; i < INCOMING_PER_MINUTE + 5; i++) if ((await hook(fresh, JSON.stringify({ name: `n${i}`, email: `n${i}@example.test` }))).status === 429) limited++;
  check(limited >= 5, `at most ${INCOMING_PER_MINUTE} requests a minute are taken`, limited);
  await db.delete(automationRun).where(eq(automationRun.automationId, intake.id));
  await manage.updateAutomation(ids.owner, intake.id, { enabled: false });
  check((await hook(rotated.hookUrl!, "{}")).status === 409, "a disabled automation's address answers that it's off");
  await manage.deleteAutomation(ids.owner, intake.id);

  // ------------------------------------------------------------------ HTTP requests
  check(
    await refused(manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "http_request", url: "https://169.254.169.254/latest/meta-data" }] }), "webhookBlocked"),
    "a request to a private address is refused when saved",
  );
  check(
    await refused(manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "http_request", url: "http://example.com/x" }] }), "invalidAutomation"),
    "…and plain http to a host that isn't allowed",
  );
  const caller = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Tell the service",
    trigger: { type: "row_created" },
    actions: [
      {
        id: "call",
        type: "http_request",
        method: "POST",
        url: `${base}/tasks?token=sk_live_abcdefghijklmnop1234`,
        headers: [
          { name: "Authorization", value: "Bearer very-secret-token" },
          { name: "X-Title", value: "{{trigger.title}}" },
        ],
        body: { title: "{{trigger.title}}", priority: "{{trigger.Priority}}", tags: ["{{trigger.Stage}}"] },
      },
      { type: "set_properties", values: { Note: "remote {{call.body.id}} said {{call.status}} ({{call.headers.x-request-id}})" } },
    ],
  });
  answers = [{ status: 503 }];
  received.length = 0;
  const [called] = await createRows(ids.owner, tasks.id, [{ title: "Call out", properties: { [priority.id]: 5, [stage.id]: optionId("Doing") } }]);
  await flushAutomations();
  run = await lastRun(caller.id);
  check(run.status === "pending" && run.steps[0].httpStatus === 503 && run.steps[1].status === "pending", "a 503 is tried again later, the steps after it wait", run.steps);
  await db.update(automationRun).set({ nextAt: sql`now()` }).where(eq(automationRun.id, run.id));
  await flushAutomations();
  run = await lastRun(caller.id);
  check(run.status === "done" && run.steps[0].attempts === 2, "…and goes through on the retry", run.steps);
  const sentBody = JSON.parse(received.at(-1)!.body);
  check(sentBody.title === "Call out" && sentBody.priority === 5 && sentBody.tags[0] === "Doing", "a JSON body keeps a whole template's type", sentBody);
  check(received.at(-1)!.headers["x-title"] === "Call out" && received.at(-1)!.headers.authorization === "Bearer very-secret-token", "headers are sent as written");
  check((await values(called.id)).properties[note.id] === "remote remote-1 said 200 (abc)", "a later step reads the status, headers and body", await values(called.id));
  const historyText = JSON.stringify(run.steps);
  check(!historyText.includes("very-secret-token") && !historyText.includes("sk_live_abcdefghijklmnop1234"), "credentials are masked in the history", run.steps[0].input);
  check((run.steps[0].output as { status: number }).status === 200 && typeof run.steps[0].durationMs === "number", "the history keeps the answer and how long it took", run.steps[0]);
  answers = [{ status: 400, body: { error: "bad" } }];
  await createRows(ids.owner, tasks.id, [{ title: "Refused" }]);
  await flushAutomations();
  run = await lastRun(caller.id);
  check(run.status === "failed" && run.steps[0].httpStatus === 400 && run.steps[0].attempts === 1, "a 400 fails without a retry", run.steps);
  check(run.steps[1].status === "skipped" && run.steps[1].code === "dependencyFailed", "…and a step that reads its output is skipped", run.steps[1]);
  check((run.steps[0].output as { body: { error: string } }).body.error === "bad", "…with the answer kept in the history");
  await manage.deleteAutomation(ids.owner, caller.id);

  const templated = await manage.createAutomation(ids.owner, customers.id, {
    name: "Call where told",
    trigger: { type: "incoming_webhook" },
    actions: [{ type: "http_request", method: "GET", url: "https://{{trigger.host}}/x" }],
  });
  await hook(templated.hookUrl!, JSON.stringify({ host: "10.0.0.1" }));
  await flushAutomations();
  run = await lastRun(templated.id);
  check(run.status === "failed" && run.steps[0].code === "blocked", "an address that a template points to a private host is refused when sent", run.steps);
  await manage.deleteAutomation(ids.owner, templated.id);

  // ------------------------------------------------------------------ waiting, versions, drafts and test runs
  check(
    await refused(manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "wait", minutes: 7 * 24 * 60 + 1 }] })),
    "a wait is at most 7 days",
  );
  check(
    await refused(
      manage.createAutomation(ids.owner, tasks.id, {
        name: "x",
        trigger: { type: "row_created" },
        actions: Array.from({ length: MAX_AUTOMATION_ACTIONS + 1 }, () => ({ type: "log" as const, message: "x" })),
      }),
    ),
    `an automation has at most ${MAX_AUTOMATION_ACTIONS} steps`,
  );
  check(
    await refused(manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "log", message: "{{later.x}}" }, { id: "later", type: "log", message: "y" }] })),
    "a template can only read earlier steps",
  );
  const slow = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Wait, then note",
    trigger: { type: "row_created" },
    actions: [
      { id: "pause", type: "wait", minutes: 60 },
      { type: "set_properties", values: { Note: "version one after {{pause.until}}" } },
    ],
  });
  const [patient] = await createRows(ids.owner, tasks.id, [{ title: "Patient" }]);
  await flushAutomations();
  run = await lastRun(slow.id);
  check(run.status === "pending" && run.steps[0].waitUntil && run.nextAt > new Date(Date.now() + 50 * 60_000), "a wait holds the run in the queue", run.steps);
  const draft = await manage.updateAutomation(
    ids.owner,
    slow.id,
    { actions: [{ id: "pause", type: "wait", minutes: 60 }, { type: "set_properties", values: { Note: "version two" } }] },
    { publish: false },
  );
  check(draft.version === 1 && draft.draft !== null, "saving as a draft keeps the published version");
  const [testRow] = await createRows(ids.owner, tasks.id, [{ title: "Test me" }]);
  await flushAutomations();
  const { runId } = await manage.testAutomation(ids.owner, slow.id, { rowId: testRow.id });
  await flushAutomations();
  let [testRun] = await db.select().from(automationRun).where(eq(automationRun.id, runId));
  check(testRun.test && testRun.definition !== null && testRun.status === "pending", "a test run runs the draft, marked as a test", testRun);
  await db.update(automationRun).set({ nextAt: sql`now()`, steps: sql`jsonb_set(steps, '{0,waitUntil}', to_jsonb(now()::text))` }).where(eq(automationRun.id, runId));
  await flushAutomations();
  [testRun] = await db.select().from(automationRun).where(eq(automationRun.id, runId));
  check(testRun.status === "done" && (await values(testRow.id)).properties[note.id] === "version two", "…with real effects", testRun.steps);
  const listed = await manage.listAutomationRuns(ids.owner, slow.id);
  check(listed.some((r) => r.id === runId && r.test && r.draft), "the history marks it as a test of the draft");
  const published = await manage.publishAutomation(ids.owner, slow.id);
  check(published.version === 2 && published.draft === null, "publishing makes the draft version 2");
  await db.update(automationRun).set({ nextAt: sql`now()`, steps: sql`jsonb_set(steps, '{0,waitUntil}', to_jsonb(now()::text))` }).where(eq(automationRun.id, run.id));
  await flushAutomations();
  check(String((await values(patient.id)).properties[note.id]).startsWith("version one after "), "a run that waited goes on with the version it started with", await lastRun(slow.id));
  const [later] = await createRows(ids.owner, tasks.id, [{ title: "Later" }]);
  await flushAutomations();
  const laterRun = (await runsOf(slow.id)).find((r) => r.rowId === later.id)!;
  check(laterRun.version === 2, "a new run takes the new version");
  await db.update(automationRun).set({ nextAt: sql`now()`, steps: sql`jsonb_set(steps, '{0,waitUntil}', to_jsonb(now()::text))` }).where(eq(automationRun.id, laterRun.id));
  await flushAutomations();
  check((await values(later.id)).properties[note.id] === "version two", "…and runs it");
  check(await refused(manage.publishAutomation(ids.owner, slow.id)), "with nothing unpublished there's nothing to publish");
  await manage.updateAutomation(ids.owner, slow.id, { actions: [{ type: "log", message: "never" }] }, { publish: false });
  const discarded = await manage.discardAutomationDraft(ids.owner, slow.id);
  check(discarded.draft === null && discarded.actions.length === 2, "discarding a draft goes back to the published steps");
  await manage.deleteAutomation(ids.owner, slow.id);

  const unpublished = await manage.createAutomation(ids.owner, tasks.id, { name: "Not yet", trigger: { type: "row_created" }, actions: [{ type: "log", message: "x" }] }, { publish: false });
  check(unpublished.version === 0 && unpublished.draft !== null, "a new automation can start as a draft");
  await createRows(ids.owner, tasks.id, [{ title: "Ignored" }]);
  await flushAutomations();
  check((await runsOf(unpublished.id)).length === 0, "…which doesn't run");
  check(await refused(manage.discardAutomationDraft(ids.owner, unpublished.id)), "…and has no published steps to go back to");
  const scheduledTest = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Test a schedule",
    trigger: { type: "schedule", schedule: { frequency: "daily", time: "03:00" } },
    actions: [{ id: "all", type: "find_rows", database: "Tasks", limit: 1 }, { type: "log", message: "{{all.count}}" }],
  });
  const t = await manage.testAutomation(ids.owner, scheduledTest.id);
  await flushAutomations();
  const [scheduledRun] = await db.select().from(automationRun).where(eq(automationRun.id, t.runId));
  check(scheduledRun.status === "done" && scheduledRun.test && (scheduledRun.steps[1].output as { message: string }).message === "1", "a schedule's test run runs at once", scheduledRun.steps);
  const [described] = (await manage.listAutomations(ids.owner, tasks.id)).filter((x) => x.id === scheduledTest.id);
  check(described.lastRun === null, "a test run isn't the automation's last run");
  await db.delete(databaseAutomation).where(inArray(databaseAutomation.id, [unpublished.id, scheduledTest.id]));

  console.log(`\n${passed} checks passed`);
} finally {
  receiver.close();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
