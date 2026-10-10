/**
 * End-to-end check of form views against the database: the questions a new form asks, config
 * validation, answering in the app (required answers, hidden default values, notifications),
 * public links (on and off, anonymous or signed in, the publishing policy, owners revoking them,
 * nothing but the questions leaking), the spam guards (rate limits, honeypot, fill time), copies
 * never keeping a link, links closing when the publisher loses access or the database goes to the
 * trash, and forms over MCP.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/form-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseView, formPublication, notification, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { addProperty, addView, deleteProperty, deleteView, getDatabaseSnapshot, getProperties, updateView } = await import(
  "@/server/databases"
);
const { getPublishedPage, publishPage } = await import("@/server/publication");
const forms = await import("@/server/forms");
const { duplicatePage } = await import("@/server/duplicate");
const { archivePage, createPage, restorePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { removeMember, updateWorkspaceSettings } = await import("@/server/workspaces");
const { AccessError } = await import("@/server/access");
const { PropertyValueError } = await import("@/lib/properties");
const { FORM_TITLE } = await import("@/lib/forms");

const RUN = `form-e2e-${Date.now().toString(36)}`;

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

/** The error `fn` throws, or null when it succeeds. */
async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}
const formCode = (error: unknown) => (error instanceof forms.FormError ? error.code : null);

/** Calls an MCP tool as `userId` with read and write access, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE, WRITE_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "form-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

async function liveRows(databaseId: string) {
  return db
    .select({ id: page.id, title: page.title, properties: page.properties, createdBy: page.createdBy })
    .from(page)
    .where(and(eq(page.parentId, databaseId), isNull(page.archivedAt)));
}
async function rowById(id: string) {
  const [row] = await db
    .select({ id: page.id, title: page.title, properties: page.properties, createdBy: page.createdBy })
    .from(page)
    .where(eq(page.id, id));
  return row;
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const actor = { userId: ids.owner };
  const leads = await createPage(actor, { workspaceId, kind: "database", title: "Leads" });
  const email = await addProperty(ids.owner, leads.id, { name: "Email", type: "email" });
  const priority = await addProperty(ids.owner, leads.id, { name: "Priority", type: "select", options: ["Low", "High"] });
  const notes = await addProperty(ids.owner, leads.id, { name: "Notes", type: "text" });
  const stage = await addProperty(ids.owner, leads.id, { name: "Stage", type: "select", options: ["New", "Won"] });
  const assignee = await addProperty(ids.owner, leads.id, { name: "Assignee", type: "person" });
  const contact = await addProperty(ids.owner, leads.id, { name: "Contact", type: "person" });
  const score = await addProperty(ids.owner, leads.id, { name: "Score", type: "formula", formula: { expression: "1 + 1" } });
  const created = await addProperty(ids.owner, leads.id, { name: "Created", type: "created_time" });
  const optionId = (prop: typeof priority, name: string) => prop.options.options!.find((o) => o.name === name)!.id;

  // A new form asks for the name and every property a form can ask for
  const view = await addView(ids.owner, leads.id, { name: "", type: "form" });
  const asked = view.config.form?.questions?.map((q) => q.propertyId) ?? [];
  check(view.name === "Form" && view.type === "form", "a form without a name is called Form", view);
  check(asked[0] === FORM_TITLE && view.config.form?.questions?.[0].required, "a new form asks for the name first, required", asked);
  check(
    [email.id, priority.id, notes.id, stage.id, assignee.id, contact.id].every((id) => asked.includes(id)),
    "a new form asks for every property a form can ask for",
    asked,
  );
  check(!asked.includes(score.id) && !asked.includes(created.id), "formulas and automatic properties are never asked", asked);

  // Config: questions, texts and hidden defaults
  const invalid = await failure(() =>
    updateView(ids.owner, view.id, { config: { form: { questions: [{ propertyId: email.id, required: "yes" as never }] } } }),
  );
  check(invalid instanceof PropertyValueError, "a malformed question is refused", String(invalid));
  const formulaDefault = await failure(() =>
    updateView(ids.owner, view.id, { config: { form: { questions: [], defaults: { [score.id]: 3 } } } }),
  );
  check(formulaDefault instanceof PropertyValueError, "a formula can't get a default value", String(formulaDefault));
  await updateView(ids.owner, view.id, {
    config: {
      form: {
        title: "Contact us",
        description: "We answer within a day.",
        questions: [
          { propertyId: FORM_TITLE, required: true, label: "Your name" },
          { propertyId: email.id, required: true, label: "Your email", description: "We never share it." },
          { propertyId: priority.id },
          { propertyId: notes.id },
          { propertyId: contact.id },
        ],
        defaults: { Stage: "New", [assignee.id]: [ids.owner], [notes.id]: "" },
        confirmation: "Thanks, we got it.",
        allowAnother: false,
      },
    },
  });
  const [stored] = await db.select().from(databaseView).where(eq(databaseView.id, view.id));
  const defaults = stored.config.form?.defaults ?? {};
  check(
    defaults[stage.id] === optionId(stage, "New") && (defaults[assignee.id] as string[])?.[0] === ids.owner,
    "hidden defaults are stored as ids",
    defaults,
  );
  check(!("Stage" in defaults) && !(notes.id in defaults), "defaults are keyed by property id, empty ones dropped", defaults);

  // Answering in the app
  const before = (await liveRows(leads.id)).length;
  const missing = await failure(() => forms.submitForm(ids.member, view.id, { [email.id]: "  " }));
  check(
    formCode(missing) === "invalidAnswers" &&
      (missing as InstanceType<typeof forms.FormError>).answers.map((e) => `${e.propertyId}:${e.code}`).sort().join() ===
        [`${FORM_TITLE}:required`, `${email.id}:required`].sort().join(),
    "required questions without an answer are refused, each named",
    missing,
  );
  const badEmail = await failure(() => forms.submitForm(ids.member, view.id, { [FORM_TITLE]: "Ada", [email.id]: "nope" }));
  check(formCode(badEmail) === "invalidAnswers", "an invalid email is refused", badEmail);
  const tooLong = await failure(() => forms.submitForm(ids.member, view.id, { [FORM_TITLE]: "x".repeat(501), [email.id]: "a@b.co" }));
  check(formCode(tooLong) === "invalidAnswers", "an overlong name is refused", tooLong);
  const huge = await failure(() => forms.submitForm(ids.member, view.id, { [notes.id]: "x".repeat(70_000) }));
  check(formCode(huge) === "tooLarge", "an oversized submission is refused before anything else", huge);
  check((await liveRows(leads.id)).length === before, "refused answers add no row");

  const { id: rowId } = await forms.submitForm(ids.member, view.id, {
    [FORM_TITLE]: "  Ada Lovelace ",
    [email.id]: " ada@example.test ",
    [priority.id]: "High",
    [contact.id]: [ids.guest],
    [stage.id]: "Won",
  });
  const row = await rowById(rowId);
  check(row.title === "Ada Lovelace" && row.createdBy === ids.member, "an answer adds a row created by the person answering", row);
  check(
    row.properties[email.id] === "ada@example.test" && row.properties[priority.id] === optionId(priority, "High"),
    "answers are trimmed and options stored as ids",
    row.properties,
  );
  check(row.properties[stage.id] === optionId(stage, "New"), "hidden properties get the form's default, not what was sent", row.properties);
  check((row.properties[assignee.id] as string[])?.[0] === ids.owner, "person defaults are set", row.properties);
  check((row.properties[contact.id] as string[])?.[0] === ids.guest, "person questions work in the app", row.properties);
  let assigned = 0;
  for (let i = 0; i < 50 && !assigned; i++) {
    assigned = (
      await db
        .select({ id: notification.id })
        .from(notification)
        .where(and(eq(notification.pageId, rowId), eq(notification.userId, ids.owner), eq(notification.kind, "assignment")))
    ).length;
    if (!assigned) await new Promise((r) => setTimeout(r, 20));
  }
  check(assigned === 1, "a person set by the form's defaults is notified");

  const guestAnswer = await failure(() => forms.submitForm(ids.guest, view.id, { [FORM_TITLE]: "G", [email.id]: "g@example.test" }));
  check(guestAnswer instanceof AccessError, "someone without access to the database can't answer", String(guestAnswer));
  await setPagePermission(ids.owner, leads.id, ids.guest, "view");
  const viewerAnswer = await failure(() => forms.submitForm(ids.guest, view.id, { [FORM_TITLE]: "G", [email.id]: "g@example.test" }));
  check(viewerAnswer instanceof AccessError, "view access isn't enough to answer", String(viewerAnswer));
  const table = await addView(ids.owner, leads.id, { name: "", type: "table" });
  check(formCode(await failure(() => forms.submitForm(ids.owner, table.id, {}))) === "notAForm", "only forms take answers");

  // Public link: off by default, on with an unguessable token
  check((await forms.getFormSharing(ids.member, view.id)).publication === null, "a new form has no public link");
  const guestPublish = await failure(() => forms.publishForm(ids.guest, view.id));
  check(guestPublish instanceof AccessError, "only full access opens a form to the web", String(guestPublish));
  const published = await forms.publishForm(ids.owner, view.id);
  check(published.token.length >= 40 && published.url === `/f/${published.token}` && !published.anonymous, "publishing makes a signed-in link", published);
  const publicForm = await forms.getPublicForm(published.token);
  check(publicForm?.title === "Contact us" && publicForm.description === "We answer within a day.", "the public form shows its texts", publicForm);
  check(
    publicForm?.questions.map((q) => q.propertyId).join() === [FORM_TITLE, email.id, priority.id, notes.id].join(),
    "person questions are left out of the public form",
    publicForm?.questions,
  );
  const leaked = JSON.stringify(publicForm);
  check(
    ![workspaceId, leads.id, view.id, ids.owner, ids.member, stage.id, assignee.id, "ada@example.test"].some((s) => leaked.includes(s)),
    "the public form leaks no ids, people, rows or hidden properties",
    publicForm,
  );
  check(
    Object.keys(publicForm!.questions[2].prop!).sort().join() === "id,name,options,type" &&
      publicForm!.questions[2].prop!.options.options?.length === 2,
    "public questions carry only name, type and options",
    publicForm?.questions[2],
  );
  check((await forms.getPublicForm("x".repeat(43))) === null, "an unknown token opens nothing");

  forms.resetFormRateLimits();
  const now = Date.now();
  const ticket = forms.issueFormTicket(published.token, now - 5_000);
  const answers = { [FORM_TITLE]: "Grace", [email.id]: "grace@example.test", [contact.id]: [ids.owner] };
  const anonymousOnSignedIn = await failure(() =>
    forms.submitPublicForm(published.token, { answers, ticket }, { userId: null, ip: "10.0.0.1", now }),
  );
  check(formCode(anonymousOnSignedIn) === "signInRequired", "a signed-in form refuses anonymous answers", anonymousOnSignedIn);
  const signed = await forms.submitPublicForm(published.token, { answers, ticket }, { userId: ids.outsider, ip: "10.0.0.1", now });
  const signedRow = await rowById(signed.id!);
  check(signedRow.createdBy === ids.outsider && signedRow.title === "Grace", "a signed-in answer is recorded under who sent it", signedRow);
  check(!(contact.id in signedRow.properties), "public answers can't set person properties", signedRow.properties);
  check(signedRow.properties[stage.id] === optionId(stage, "New"), "public answers get the hidden defaults", signedRow.properties);
  const publicMissing = await failure(() =>
    forms.submitPublicForm(published.token, { answers: { [FORM_TITLE]: "No mail" }, ticket }, { userId: ids.outsider, ip: "10.0.0.1", now }),
  );
  check(formCode(publicMissing) === "invalidAnswers", "public answers enforce required questions", publicMissing);

  const again = await forms.publishForm(ids.owner, view.id, { anonymous: true });
  check(again.token === published.token && again.anonymous, "allowing anonymous answers keeps the link", again);
  const anon = await forms.submitPublicForm(published.token, { answers, ticket }, { userId: ids.outsider, ip: "10.0.0.1", now });
  check((await rowById(anon.id!)).createdBy === null, "an anonymous form records nobody, even when signed in");

  // Spam guards
  const fast = await failure(() =>
    forms.submitPublicForm(published.token, { answers, ticket: forms.issueFormTicket(published.token, now - 500) }, { userId: null, ip: "10.0.0.2", now }),
  );
  check(formCode(fast) === "tooFast", "answers sent right after the page loaded are refused", fast);
  const forged = await failure(() =>
    forms.submitPublicForm(published.token, { answers, ticket: `${now - 5_000}.forged` }, { userId: null, ip: "10.0.0.2", now }),
  );
  check(formCode(forged) === "expired", "a forged ticket is refused", forged);
  const foreign = await failure(() =>
    forms.submitPublicForm(published.token, { answers, ticket: forms.issueFormTicket("other", now - 5_000) }, { userId: null, ip: "10.0.0.2", now }),
  );
  check(formCode(foreign) === "expired", "another form's ticket is refused", foreign);
  const stale = await failure(() =>
    forms.submitPublicForm(
      published.token,
      { answers, ticket: forms.issueFormTicket(published.token, now - 2 * 24 * 60 * 60_000) },
      { userId: null, ip: "10.0.0.2", now },
    ),
  );
  check(formCode(stale) === "expired", "a page left open for days has to be reloaded", stale);
  const rowsBeforeSpam = (await liveRows(leads.id)).length;
  const trapped = await forms.submitPublicForm(published.token, { answers, ticket, honeypot: "http://spam" }, { userId: null, ip: "10.0.0.3", now });
  check(trapped.id === null && (await liveRows(leads.id)).length === rowsBeforeSpam, "a filled honeypot looks like success and adds nothing", trapped);

  forms.resetFormRateLimits();
  for (let i = 0; i < forms.FORM_RATE_LIMITS.perIp.limit; i++) {
    await forms.submitPublicForm(published.token, { answers, ticket, honeypot: "x" }, { userId: null, ip: "10.0.0.4", now: now + i });
  }
  const limited = await failure(() =>
    forms.submitPublicForm(published.token, { answers, ticket }, { userId: null, ip: "10.0.0.4", now: now + 100 }),
  );
  check(formCode(limited) === "rateLimited", "one address can't send more than the limit", limited);
  const otherIp = await forms.submitPublicForm(published.token, { answers, ticket }, { userId: null, ip: "10.0.0.5", now: now + 100 });
  check(otherIp.id !== null, "another address still can");
  const later = await forms.submitPublicForm(
    published.token,
    { answers, ticket },
    { userId: null, ip: "10.0.0.4", now: now + forms.FORM_RATE_LIMITS.perIp.windowMs + 1_000 },
  );
  check(later.id !== null, "the address can send again once the window has passed");
  forms.resetFormRateLimits();
  const perForm = forms.FORM_RATE_LIMITS.perForm.limit;
  for (let i = 0; i < perForm; i++) {
    await forms.submitPublicForm(published.token, { answers, ticket, honeypot: "x" }, { userId: null, ip: `10.1.${i >> 8}.${i & 255}`, now });
  }
  const formLimited = await failure(() => forms.submitPublicForm(published.token, { answers, ticket }, { userId: null, ip: "10.2.0.1", now }));
  check(formLimited && formCode(formLimited) === "rateLimited", "a form takes at most its hourly limit from everyone together", formLimited);
  forms.resetFormRateLimits();

  // Turning the link off, and on again with a new token
  await forms.unpublishForm(ids.owner, view.id);
  const closed = await failure(() => forms.submitPublicForm(published.token, { answers, ticket }, { userId: null, ip: "10.0.0.6", now }));
  check(formCode(closed) === "closed" && (await forms.getPublicForm(published.token)) === null, "a link turned off stops working", closed);
  const reopened = await forms.publishForm(ids.owner, view.id);
  check(reopened.token !== published.token, "turning it on again makes a new link");

  // Publishing policy, the owners' list and revoking
  await updateWorkspaceSettings(ids.owner, workspaceId, { publishing: "owners" });
  const memberBlocked = await failure(() => forms.publishForm(ids.member, view.id));
  check(formCode(memberBlocked) === "notAllowed", "when only owners may publish, members can't open a form", memberBlocked);
  check((await forms.getFormSharing(ids.member, view.id)).blocker !== null, "the share panel tells members why");
  check((await failure(() => forms.unpublishForm(ids.guest, view.id))) instanceof AccessError, "guests with view access can't turn a link off");
  const listed = await forms.listWorkspaceFormPublications(ids.owner, workspaceId);
  check(
    listed.length === 1 && listed[0].viewId === view.id && listed[0].url === `/f/${reopened.token}` && !listed[0].inTrash,
    "owners see open forms in Security",
    listed,
  );
  check((await failure(() => forms.listWorkspaceFormPublications(ids.member, workspaceId))) !== null, "members don't see that list");
  check(
    (await failure(() => forms.revokeFormPublication(ids.member, workspaceId, view.id))) !== null,
    "members can't revoke from the list",
  );
  await forms.revokeFormPublication(ids.owner, workspaceId, view.id);
  check((await forms.getPublicForm(reopened.token)) === null, "an owner's revoke closes the link");
  await updateWorkspaceSettings(ids.owner, workspaceId, { publishing: "members" });

  // The publisher losing access closes the link
  const byMember = await forms.publishForm(ids.member, view.id, { anonymous: true });
  check((await forms.getPublicForm(byMember.token)) !== null, "members may open forms when the workspace allows it");
  // Everyone but the owner can only view the database from now on.
  await setPagePermission(ids.owner, leads.id, ids.owner, "full");
  await setPagePermission(ids.owner, leads.id, null, "view");
  const lostAccess = await failure(() => forms.submitPublicForm(byMember.token, { answers, ticket: forms.issueFormTicket(byMember.token, now - 5_000) }, { userId: null, ip: "10.0.0.7", now }));
  check(formCode(lostAccess) === "closed" && (await forms.getPublicForm(byMember.token)) === null, "a publisher who can no longer edit leaves the link closed", lostAccess);
  await setPagePermission(ids.owner, leads.id, ids.member, "full");
  check((await forms.getPublicForm(byMember.token)) !== null, "…and it works again once they can");

  // The database in the trash
  await archivePage(ids.owner, leads.id);
  check((await forms.getPublicForm(byMember.token)) === null, "a database in the trash closes its forms");
  const trashed = await failure(() => forms.submitForm(ids.owner, view.id, { [FORM_TITLE]: "T", [email.id]: "t@example.test" }));
  check(trashed instanceof AccessError, "no answers in the app while the database is in the trash", String(trashed));
  check(formCode(await failure(() => forms.publishForm(ids.owner, view.id))) === "inTrash", "forms in the trash can't be published");
  check((await forms.listWorkspaceFormPublications(ids.owner, workspaceId))[0]?.inTrash === true, "the owners' list marks it in the trash");
  await restorePage(ids.owner, leads.id);
  check((await forms.getPublicForm(byMember.token)) !== null, "restoring the database opens the link again");

  // A copy never keeps the link
  const copy = await duplicatePage(actor, leads.id, " (copy)");
  const copyProps = await getProperties(copy.id);
  const copyViews = await db.select().from(databaseView).where(eq(databaseView.databaseId, copy.id));
  const copyForm = copyViews.find((v) => v.type === "form")!;
  const copyQuestions = copyForm.config.form?.questions?.map((q) => q.propertyId) ?? [];
  check(
    copyQuestions.length === 5 &&
      copyQuestions.every((id) => id === FORM_TITLE || copyProps.some((p) => p.id === id)) &&
      copyForm.config.form?.defaults?.[copyProps.find((p) => p.name === "Stage")!.id] ===
        copyProps.find((p) => p.name === "Stage")!.options.options?.find((o) => o.name === "New")?.id,
    "a copied form asks the copy's properties and keeps its defaults",
    copyForm.config,
  );
  const copyLinks = await db.select().from(formPublication).where(inArray(formPublication.viewId, copyViews.map((v) => v.id)));
  check(copyLinks.length === 0, "a copied form has no public link");

  // Removing the publisher from the workspace closes the link
  await removeMember(ids.owner, workspaceId, ids.member);
  check((await forms.getPublicForm(byMember.token)) === null, "a publisher removed from the workspace leaves the link closed");
  const deadLink = (await forms.getFormSharing(ids.owner, view.id)).publication;
  const listedStale = (await forms.listWorkspaceFormPublications(ids.owner, workspaceId)).find((f) => f.viewId === view.id);
  check(
    deadLink?.live === false && listedStale?.live === false && listedStale.url === null,
    "the share panel and the owners' list say the link takes no answers",
    { deadLink, listedStale },
  );
  const takenOver = await forms.publishForm(ids.owner, view.id, { anonymous: true });
  check(
    takenOver.token === byMember.token &&
      (await forms.getPublicForm(byMember.token)) !== null &&
      (await forms.getFormSharing(ids.owner, view.id)).publication?.live === true,
    "opening it again makes the owner its publisher and the same link takes answers again",
  );

  // A published database never opens on a form: it shows the first view that shows rows
  const survey = await createPage(actor, { workspaceId, kind: "database", title: "Survey" });
  const [surveyTable] = (await getDatabaseSnapshot(ids.owner, survey.id)).views;
  const answer = await addProperty(ids.owner, survey.id, { name: "Answer", type: "text" });
  const when = await addProperty(ids.owner, survey.id, { name: "When", type: "date" });
  await addView(ids.owner, survey.id, { name: "", type: "form" });
  const compact = await addView(ids.owner, survey.id, { name: "", type: "list" });
  await updateView(ids.owner, compact.id, { config: { shown: [when.id] } });
  await deleteView(ids.owner, surveyTable.id);
  const surveyToken = (await publishPage(ids.owner, survey.id)).token;
  const publicColumns = (await getPublishedPage(surveyToken))?.database?.properties.map((p) => p.id);
  check(
    publicColumns?.length === 1 && publicColumns[0] === when.id && !publicColumns.includes(answer.id),
    "a published database skips a form in first place and shows the next view",
    publicColumns,
  );

  // Deleting a property takes it out of questions and defaults (kept stored for a restore)
  await deleteProperty(ids.owner, email.id);
  await deleteProperty(ids.owner, stage.id);
  const pruned = (await getDatabaseSnapshot(ids.owner, leads.id)).views.find((v) => v.id === view.id)!;
  const [kept] = await db.select().from(databaseView).where(eq(databaseView.id, view.id));
  check(kept.config.form?.questions?.some((q) => q.propertyId === email.id), "the form keeps a deleted property's question stored");
  check(
    !pruned.config.form?.questions?.some((q) => q.propertyId === email.id) && !(stage.id in (pruned.config.form?.defaults ?? {})),
    "a deleted property leaves the form's questions and defaults",
    pruned.config.form,
  );

  // MCP
  const made = await callTool(ids.owner, "create_database_view", {
    database_id: leads.id,
    name: "Signup",
    type: "form",
    questions: [{ property: "title", required: true, label: "Name" }, { property: "Priority" }, { property: "Contact" }],
    form_title: "Sign up",
    defaults: { Assignee: ["me"] },
    confirmation_message: "Welcome!",
    public: true,
    anonymous: true,
  });
  check(
    !made.isError &&
      made.data.type === "form" &&
      made.data.form?.questions?.length === 3 &&
      made.data.form.questions[0].required &&
      made.data.form.questions[2].public === false &&
      made.data.form.title === "Sign up" &&
      /\/f\/[\w-]{40,}$/.test(made.data.public_url) &&
      made.data.anonymous === true,
    "MCP creates a public form with its questions and defaults",
    made.text,
  );
  const [signup] = await db.select().from(databaseView).where(eq(databaseView.id, made.data.id));
  check((signup.config.form?.defaults?.[assignee.id] as string[])?.[0] === ids.owner, "MCP defaults resolve names like row values", signup.config);
  const described = await callTool(ids.owner, "get_database", { database_id: leads.id });
  const describedForm = described.data.views.find((v: { id: string }) => v.id === made.data.id);
  check(describedForm?.public_url === made.data.public_url && describedForm.form?.questions?.[0]?.property === "title", "get_database describes forms and their link", describedForm);
  const closedByMcp = await callTool(ids.owner, "update_database_view", { database_id: leads.id, view_id: made.data.id, public: false });
  check(!closedByMcp.isError && closedByMcp.data.public_url === null, "MCP turns a public link off", closedByMcp.text);
  const formulaQuestion = await callTool(ids.owner, "update_database_view", {
    database_id: leads.id,
    view_id: made.data.id,
    questions: [{ property: "Score" }],
  });
  check(formulaQuestion.isError && /can't ask/.test(formulaQuestion.text), "MCP refuses formula questions", formulaQuestion.text);
  const onTable = await callTool(ids.owner, "update_database_view", { database_id: leads.id, view_id: table.id, questions: [] });
  check(onTable.isError && /only apply to form views/.test(onTable.text), "MCP refuses form settings on other views", onTable.text);
  await updateWorkspaceSettings(ids.owner, workspaceId, { publishing: "owners" });
  await db.insert(workspaceMember).values({ workspaceId, userId: ids.member, role: "member" });
  await setPagePermission(ids.owner, leads.id, ids.member, "full");
  const memberMcp = await callTool(ids.member, "update_database_view", { database_id: leads.id, view_id: made.data.id, public: true });
  check(memberMcp.isError && /only owners publish/.test(memberMcp.text), "MCP follows the publishing policy", memberMcp.text);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
