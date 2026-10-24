/**
 * End-to-end check of buttons on pages: a click runs the button's steps in order as whoever
 * clicked, each with their access (inserting blocks needs edit access to the page, adding and
 * changing rows edit access to the database), stops at the first step they can't do and says which
 * and why; row changes are theirs (row activity marks them as made through a button) and start the
 * database's automations; notices go to people who can open the page; webhooks go out signed; a
 * page in the trash, a button without steps and too many clicks do nothing; the Markdown of the
 * page names the button without what it does; a published page shows it in its color.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/button-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. No server may use
 * the same database: its automation worker would take the runs this script checks.
 */
export {};

import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

// Webhooks go to a server on this machine, which only allowed hosts may reach.
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.writeHead(200);
    res.end();
  });
});
await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const port = (receiver.address() as AddressInfo).port;
process.env.AUTOMATION_WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${port}`;
const hook = `http://127.0.0.1:${port}/hook`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { notification, page, rowActivity, user, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { buttonLine, buttonScope, serializeButtonConfig } = await import("@/lib/buttons");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { blocksToMarkdown, serverEditor } = await import("@/server/blocknote");
const { bodyHtmlFromYdoc } = await import("@/server/published-body");
const { addProperty } = await import("@/server/databases");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const manage = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");
const { AccessError } = await import("@/server/access");
const { listInbox } = await import("@/server/notifications");
const { ButtonError, buttonSettings, pressButton } = await import("@/server/buttons");
const { createRowTemplate, setDefaultRowTemplate } = await import("@/server/templates");
const { today: dayIn } = await import("@/lib/journal");

const RUN = `button-e2e-${Date.now().toString(36)}`;

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
    if (error instanceof AccessError) return "access";
    if (error instanceof ButtonError) return error.code;
    throw error;
  }
}

const ids = {
  owner: `${RUN}-owner`,
  editor: `${RUN}-editor`,
  viewer: `${RUN}-viewer`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const zone = "UTC";
const today = buttonScope(new Date(), zone, { id: "", name: "", email: "" }).today;

const getRowProperties = async (rowId: string) =>
  ((await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0]?.properties ?? {}) as Record<string, unknown>;

/** Stores a page body made of these blocks (and its Markdown), before anything opened the page's document. */
async function storeBody(pageId: string, blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as never, doc.getXmlFragment(COLLAB_FRAGMENT)));
  const contentMarkdown = await blocksToMarkdown(serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT)));
  await db.update(page).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), contentMarkdown }).where(eq(page.id, pageId));
  doc.destroy();
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  // A database members may only view, which the editor may change.
  const tasks = (await createPage({ userId: ids.owner }, { workspaceId, kind: "database", title: "Tasks" })).id;
  const assignee = await addProperty(ids.owner, tasks, { name: "Assignee", type: "person" });
  const day = await addProperty(ids.owner, tasks, { name: "Day", type: "date" });
  const done = await addProperty(ids.owner, tasks, { name: "Done", type: "checkbox" });
  await setPagePermission(ids.owner, tasks, ids.owner, "full");
  await setPagePermission(ids.owner, tasks, null, "view");
  await setPagePermission(ids.owner, tasks, ids.editor, "edit");
  const hookOnNewRows = await manage.createAutomation(ids.owner, tasks, {
    name: "New task hook",
    trigger: { type: "row_created" },
    actions: [{ type: "webhook", url: hook }],
  });

  // A page members may only view, which the editor may change.
  const weekly = (await createPage({ userId: ids.owner }, { workspaceId, title: "Weekly" })).id;
  await setPagePermission(ids.owner, weekly, ids.owner, "full");
  await setPagePermission(ids.owner, weekly, null, "view");
  await setPagePermission(ids.owner, weekly, ids.editor, "edit");

  const openTasks = `/w/${workspaceId}/p/${tasks}`;
  const start = serializeButtonConfig({
    confirm: true,
    steps: [
      { type: "insert", at: "below", markdown: "## Week of {{today}}" },
      { type: "add_row", databaseId: tasks, title: "Review {{today}}", values: { [assignee.id]: { $: "actor" }, [day.id]: { $: "now" } } },
      { type: "notify", userIds: [ids.owner, ids.outsider, ids.editor], message: "Started by {{me.name}}" },
      { type: "webhook", url: hook },
      { type: "open", target: openTasks },
    ],
  });
  const addOnly = serializeButtonConfig({ confirm: false, steps: [{ type: "add_row", databaseId: tasks, title: "From a viewer", values: {} }] });
  const finish = serializeButtonConfig({
    confirm: false,
    steps: [
      { type: "update_rows", databaseId: tasks, filters: [{ propertyId: "title", op: "contains", value: "Review" }], filterCombinator: "and", values: { [done.id]: true } },
      { type: "insert", at: "top", markdown: "Finished on {{today}}" },
      { type: "insert", at: "bottom", markdown: "The end." },
    ],
  });
  const goOnly = serializeButtonConfig({ confirm: false, steps: [{ type: "open", target: "https://example.com/docs" }] });

  // Adding rows from a row template of another database.
  const requests = (await createPage({ userId: ids.owner }, { workspaceId, kind: "database", title: "Requests" })).id;
  const owner = await addProperty(ids.owner, requests, { name: "Owner", type: "person" });
  const opened = await addProperty(ids.owner, requests, { name: "Opened", type: "date" });
  const urgent = await addProperty(ids.owner, requests, { name: "Urgent", type: "checkbox" });
  await setPagePermission(ids.owner, requests, ids.editor, "edit");
  const intake = await createRowTemplate({ userId: ids.owner }, requests, { title: "Intake", properties: { Owner: ["me"], Opened: "today", Urgent: true } });
  const quick = await createRowTemplate({ userId: ids.owner }, requests, { title: "Quick", properties: { Urgent: true } });
  await setDefaultRowTemplate(ids.owner, requests, quick.id);
  const fromTemplate = serializeButtonConfig({
    confirm: false,
    steps: [
      { type: "add_row", databaseId: requests, title: "", values: { [urgent.id]: false }, template: intake.id },
      { type: "add_row", databaseId: requests, title: "Default {{today}}", values: {}, template: "default" },
    ],
  });
  const fromGone = serializeButtonConfig({ confirm: false, steps: [{ type: "add_row", databaseId: requests, title: "", values: {}, template: "no-such-template" }] });
  await storeBody(weekly, [
    { type: "paragraph", content: "Intro" },
    { id: "start", type: "button", props: { label: "Start the week", icon: "🚀", config: start, color: "green" } },
    { id: "add", type: "button", props: { label: "Add a task", icon: "", config: addOnly, color: "url(evil)" } },
    { id: "finish", type: "button", props: { label: "Finish", icon: "", config: finish } },
    { id: "go", type: "button", props: { label: "Docs", icon: "", config: goOnly } },
    { id: "templated", type: "button", props: { label: "New request", icon: "", config: fromTemplate } },
    { id: "gone", type: "button", props: { label: "Old request", icon: "", config: fromGone } },
    { id: "empty", type: "button", props: { label: "Nothing yet", icon: "", config: "" } },
    { type: "paragraph", content: "Outro" },
  ]);

  // Markdown names the buttons, not what they do.
  const before = await getCollab().readPage(weekly);
  check(before.markdown.includes(buttonLine("start", "Start the week")), "the page's Markdown names its buttons", before.markdown);
  check(!before.markdown.includes(hook) && !before.markdown.includes(tasks), "…without what they do");

  // Published, a button is its label in its color; a color outside the palette is the plain button.
  const [stored] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, weekly));
  const html = await bodyHtmlFromYdoc(stored.ydoc ? new Uint8Array(stored.ydoc) : null);
  check(/data-button-color="green"[^>]*><button[^>]*class="opt-green"/.test(html), "a published button keeps its color", html);
  // (BlockNote writes every prop as an escaped data attribute; the color itself only ever becomes a palette class.)
  check(!/(class|style)="[^"]*evil/.test(html) && !html.includes('data-button-color="url') && (html.match(/class="opt-/g) ?? []).length === 1, "…and a color outside the palette is dropped", html);

  // Who may click
  check((await failure(() => pressButton(ids.outsider, weekly, "start", { timeZone: zone }))) === "access", "people who can't open the page can't click its buttons");
  check((await failure(() => pressButton(ids.editor, weekly, "missing", { timeZone: zone }))) === "notFound", "a button the page doesn't have does nothing");
  check((await failure(() => pressButton(ids.editor, weekly, "empty", { timeZone: zone }))) === "noSteps", "…and so does a button without steps");

  // A viewer's click stops at the first step they can't do: inserting into a page they only view.
  const viewerPress = await pressButton(ids.viewer, weekly, "start", { timeZone: zone });
  check(!viewerPress.ok && viewerPress.step === 0 && viewerPress.type === "insert" && viewerPress.code === "noAccess", "a viewer's click stops at inserting blocks", viewerPress);
  const rowsAfterViewer = await db.select({ id: page.id }).from(page).where(and(eq(page.parentId, tasks), isNull(page.archivedAt)));
  check(rowsAfterViewer.length === 0, "…and nothing after it runs");
  const viewerAdd = await pressButton(ids.viewer, weekly, "add", { timeZone: zone });
  check(!viewerAdd.ok && viewerAdd.type === "add_row" && viewerAdd.code === "noAccess", "a viewer of the database can't add rows to it through a button", viewerAdd);

  // The editor's click runs everything, as them.
  const press = await pressButton(ids.editor, weekly, "start", { timeZone: zone });
  check(press.ok && press.done === 5 && press.open?.page === true && press.open.href.endsWith(openTasks), "the editor's click runs every step and says what to open", press);
  const after = await getCollab().readPage(weekly);
  const buttonAt = after.markdown.indexOf(buttonLine("start", "Start the week"));
  const headingAt = after.markdown.indexOf(`## Week of ${today}`);
  check(buttonAt >= 0 && headingAt > buttonAt && headingAt < after.markdown.indexOf(buttonLine("add", "Add a task")), "blocks go right below the button, with today's date", after.markdown);

  const [row] = await db.select({ id: page.id, title: page.title }).from(page).where(and(eq(page.parentId, tasks), isNull(page.archivedAt)));
  check(row?.title === `Review ${today}`, "a row is added with its title's variables written in", row);
  const values = await getRowProperties(row.id);
  check(
    JSON.stringify(values[assignee.id]) === JSON.stringify([ids.editor]) && String(values[day.id]).startsWith(today),
    "…its person set to whoever clicked and its date to today",
    values,
  );
  const [created] = await db.select().from(rowActivity).where(eq(rowActivity.rowId, row.id));
  check(created?.actorUserId === ids.editor && created.actorKind === "button", "the row's activity says the clicker made it through a button", created);

  const notices = await db.select().from(notification).where(and(eq(notification.pageId, weekly), eq(notification.kind, "automation")));
  check(
    notices.map((n) => n.userId).sort().join() === [ids.owner, ids.editor].sort().join() &&
      notices.every((n) => n.actorId === ids.editor && n.automationId === null && n.message === `Started by ${ids.editor}`),
    "the people it names who can open the page are notified, from the clicker, with the message",
    notices,
  );
  const inbox = await listInbox(ids.owner, workspaceId);
  const shown = inbox.find((n) => n.kind === "automation" && n.pageId === weekly);
  check(shown && shown.automationName === null && shown.automationMessage === `Started by ${ids.editor}`, "…and the notice shows in their inbox, from no automation", inbox);

  const sent = received.find((r) => r.headers["x-leafdesk-event"] === "button.clicked");
  check(sent, "the webhook goes out", received.map((r) => r.headers));
  const body = JSON.parse(sent.body);
  check(
    body.button.id === "start" && body.button.label === "Start the week" && body.page.id === weekly && body.actor?.id === ids.editor && body.page.markdown.includes("Week of"),
    "…with the button, the page as it is now and who clicked",
    body,
  );
  const { secret } = await buttonSettings(ids.editor, weekly, "start");
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(sent.headers["x-leafdesk-signature"])) ?? [];
  check(v1 === createHmac("sha256", secret).update(`${t}.${sent.body}`).digest("hex"), "…signed with the button's secret", sent.headers);
  check((await failure(() => buttonSettings(ids.viewer, weekly, "start"))) === "access", "only people who may edit the page read the secret");

  // The row the button added starts the database's automations as the clicker's would.
  await flushAutomations();
  check(received.some((r) => r.headers["x-leafdesk-event"] === "row.created"), "rows a button adds start the database's automations", hookOnNewRows.id);

  // Changing rows, and inserting at the top and the end.
  const finished = await pressButton(ids.editor, weekly, "finish", { timeZone: zone });
  check(finished.ok && finished.open === null, "a button changes the rows its filters match", finished);
  check((await getRowProperties(row.id))[done.id] === true, "…to the values it sets");
  const changed = await db.select().from(rowActivity).where(and(eq(rowActivity.rowId, row.id), eq(rowActivity.propertyId, done.id)));
  check(changed.length === 1 && changed[0].actorKind === "button", "…and the change reads as made through a button", changed);
  const ends = (await getCollab().readPage(weekly)).markdown.trim();
  check(ends.startsWith(`Finished on ${today}`) && ends.endsWith("The end."), "blocks go at the top and at the end of the page", ends);

  // Rows from a row template: its values, with the step's over them, "me" the clicker and "today" theirs.
  const templated = await pressButton(ids.editor, weekly, "templated", { timeZone: "Pacific/Auckland" });
  check(templated.ok && templated.done === 2, "a button adds rows from row templates", templated);
  const made = await db
    .select({ title: page.title, properties: page.properties })
    .from(page)
    .where(and(eq(page.parentId, requests), eq(page.isTemplate, false)));
  const fromIntake = made.find((r) => r.title === "Intake");
  check(
    fromIntake &&
      JSON.stringify(fromIntake.properties[owner.id]) === JSON.stringify([ids.editor]) &&
      fromIntake.properties[opened.id] === dayIn("Pacific/Auckland") &&
      fromIntake.properties[urgent.id] === false,
    "…with the template's title and values, its \"me\" and \"today\" the clicker's and the step's values over its own",
    made,
  );
  const fromDefault = made.find((r) => r.title.startsWith("Default "));
  check(fromDefault && fromDefault.properties[urgent.id] === true, "…or from the database's default template, with the step's title", made);
  const gone = await pressButton(ids.editor, weekly, "gone", { timeZone: zone });
  check(!gone.ok && gone.type === "add_row" && gone.code === "templateGone", "a template that is gone stops the button", gone);

  // Too many clicks
  const outcomes: (string | null)[] = [];
  for (let i = 0; i < 11; i++) outcomes.push(await failure(() => pressButton(ids.viewer, weekly, "go", { timeZone: zone })));
  check(outcomes.slice(0, 10).every((o) => o === null) && outcomes[10] === "rateLimited", "a button clicked too often by one person waits", outcomes);
  const other = await pressButton(ids.editor, weekly, "go", { timeZone: zone });
  check(other.ok && other.open?.page === false && other.open.href === "https://example.com/docs", "…while others still click it, and web addresses open as they are", other);

  // The trash
  await archivePage(ids.owner, weekly);
  check((await failure(() => pressButton(ids.editor, weekly, "go", { timeZone: zone }))) === "inTrash", "buttons on pages in the trash do nothing");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  receiver.close();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
