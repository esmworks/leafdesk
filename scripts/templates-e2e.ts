/**
 * End-to-end check of page and database templates: saving a page (with subpages) as a template and
 * making pages from it, row templates with default values and a default template, the built-in
 * gallery, who may do what, templates staying out of the sidebar, search, trash, favorites, views,
 * relations and published sites, and the MCP tools.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/templates-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { notification, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { THREADS_MAP } = await import("@/lib/comments");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { threadQuotes } = await import("@/server/collab/comment-marks");
const { changeComments } = await import("@/server/comments");
const pages = await import("@/server/pages");
const databases = await import("@/server/databases");
const templates = await import("@/server/templates");
const { duplicatePage } = await import("@/server/duplicate");
const { setPagePermission } = await import("@/server/permissions");
const { listFavorites, setFavorite } = await import("@/server/page-meta");
const { getPublishedPage, publishPage } = await import("@/server/publication");
const { AccessError } = await import("@/server/access");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");

const RUN = `templates-e2e-${Date.now().toString(36)}`;

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

/** "access", the error's code, or null when `fn` succeeds. */
async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AccessError && !(error as { code?: string }).code) return "access";
    const code = (error as { code?: string }).code;
    if (code) return code;
    if (error instanceof Error) return error.message;
    throw error;
  }
}

/** The page's document as stored or, while open, live. */
async function withDoc<T>(pageId: string, fn: (doc: InstanceType<typeof Y.Doc>) => T): Promise<T> {
  const live = hocuspocus.documents.get(`page:${pageId}`);
  if (live) return fn(live);
  const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId));
  const doc = new Y.Doc();
  if (row?.ydoc) Y.applyUpdate(doc, row.ydoc);
  try {
    return fn(doc);
  } finally {
    doc.destroy();
  }
}
const threadCount = (pageId: string) => withDoc(pageId, (doc) => doc.getMap(THREADS_MAP).size);
const markCount = (pageId: string) => withDoc(pageId, (doc) => threadQuotes(doc.getXmlFragment(COLLAB_FRAGMENT)).size);
const row = async (id: string) => (await db.select().from(page).where(eq(page.id, id)))[0];
const childrenOf = (parentId: string) => db.select().from(page).where(eq(page.parentId, parentId));

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE, WRITE_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 1000; i++) {
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "templates-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const ids = {
  owner: `${RUN}-owner`,
  member: `${RUN}-member`,
  viewer: `${RUN}-viewer`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const owner = { userId: ids.owner };
const member = { userId: ids.member };

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  // ---------------------------------------------------------------------------------------------
  // Saving a page as a template
  const word = `zebracorn${Date.now().toString(36)}`;
  const spec = await pages.createPage(owner, { workspaceId, title: "Spec", markdown: `Goals of the ${word} project.\n\nSecond part.` });
  const specChild = await pages.createPage(owner, { workspaceId, parentId: spec.id, title: "Spec details", markdown: "Details." });
  const thread = await changeComments(ids.member, spec.id, { type: "createThread", body: "Is this right?", anchor: { quote: "Goals" } });
  check(thread.anchored && (await threadCount(spec.id)) === 1, "the source page has a comment thread");

  const saved = await templates.saveAsTemplate(member, spec.id);
  const template = await row(saved.id);
  check(
    template.isTemplate && template.inTemplate && template.parentId === null && template.title === "Spec" && saved.databaseId === null,
    "saving a page makes a top-level workspace template with its title",
    template,
  );
  const templateChildren = await childrenOf(template.id);
  check(
    templateChildren.length === 1 && templateChildren[0].title === "Spec details" && templateChildren[0].inTemplate && !templateChildren[0].isTemplate,
    "…its subpages come along, inside the template",
    templateChildren,
  );
  check((await getCollab().readPage(template.id)).markdown.includes(word), "…with the page's body");
  check((await threadCount(template.id)) === 0 && (await markCount(template.id)) === 0, "…but without its comment threads or their marks");
  check((await threadCount(spec.id)) === 1 && (await markCount(spec.id)) === 1, "the page itself keeps its comments");
  check((await failure(() => templates.saveAsTemplate(owner, template.id))) === "isTemplate", "a template can't be saved as a template again");

  // Templates stay out of page lists
  const tree = await pages.getTree(ids.owner, workspaceId);
  check(!tree.some((n) => n.id === template.id || n.id === templateChildren[0].id), "the sidebar leaves templates and their subpages out");
  const hits = await pages.searchPages(ids.owner, word, { workspaceId });
  check(hits.some((h) => h.id === spec.id) && !hits.some((h) => h.id === template.id), "search finds the page but not the template", hits);
  check(!(await pages.listChildren(ids.owner, workspaceId, null)).some((c) => c.id === template.id), "top-level page lists leave templates out");
  check(!(await pages.recentPages(ids.owner, workspaceId, 50)).some((c) => c.id === template.id), "recent pages leave templates out");
  await setFavorite(ids.owner, template.id, true);
  check(!(await listFavorites(ids.owner, workspaceId)).some((f) => f.id === template.id), "favorites leave templates out");
  const listed = await templates.listTemplates(ids.viewer, workspaceId);
  check(listed.length === 1 && listed[0].id === template.id && listed[0].level === "full", "the template picker lists it for everyone in the workspace", listed);
  check((await failure(() => templates.listTemplates(ids.outsider, workspaceId))) === "access", "people outside the workspace see no templates");

  // Templates don't go to the trash and don't move
  check((await failure(() => pages.archivePage(ids.owner, template.id))) === "isTemplate", "templates can't be moved to the trash");
  check((await failure(() => pages.movePage(ids.owner, template.id, spec.id))) === "isTemplate", "templates can't be moved under a page");
  check(
    (await failure(() => pages.movePage(ids.owner, templateChildren[0].id, spec.id))) === "isTemplate",
    "a template's subpage can't be moved out of it",
  );
  check((await failure(() => pages.movePage(ids.owner, specChild.id, template.id))) === "isTemplate", "pages can't be moved into a template");
  const added = await pages.createPage(owner, { workspaceId, parentId: template.id, title: "Added later" });
  check((await row(added.id)).inTemplate, "a page added under a template belongs to it");
  await pages.archivePage(ids.owner, added.id);
  const trash = await pages.listTrash(ids.owner, workspaceId);
  check(trash.some((t) => t.id === added.id) && !trash.some((t) => t.id === template.id), "…and can go to the trash on its own, unlike the template", trash);
  await pages.deletePagePermanently(ids.owner, added.id);

  // ---------------------------------------------------------------------------------------------
  // New pages from a template
  await getCollab().setTitle(template.id, "Spec template", owner);
  const made = await templates.createFromTemplate(member, template.id);
  const madePage = await row(made.id);
  check(
    !madePage.isTemplate && !madePage.inTemplate && madePage.parentId === null && madePage.title === "Spec template",
    "a new page from a template is an ordinary top-level page with the template's title",
    madePage,
  );
  const madeChildren = await childrenOf(made.id);
  check(madeChildren.length === 1 && !madeChildren[0].inTemplate, "…with ordinary copies of its subpages", madeChildren);
  check((await getCollab().readPage(made.id)).markdown.includes(word), "…and its body");
  check((await pages.getTree(ids.member, workspaceId)).some((n) => n.id === made.id), "…which shows up in the sidebar");
  check((await row(template.id)).isTemplate && (await childrenOf(template.id)).length === 1, "the template stays as it was");

  const folder = await pages.createPage(owner, { workspaceId, title: "Folder" });
  const nested = await templates.createFromTemplate(member, template.id, { parentId: folder.id, title: "Kickoff" });
  const nestedPage = await row(nested.id);
  check(nestedPage.parentId === folder.id && nestedPage.title === "Kickoff", "a template can make a page under another page, with a new title", nestedPage);

  // Access: view on the template, edit where the copy goes
  // Members only view the folder; the owner keeps full access.
  await setPagePermission(ids.owner, folder.id, ids.owner, "full");
  await setPagePermission(ids.owner, folder.id, null, "view");
  check(
    (await failure(() => templates.createFromTemplate({ userId: ids.viewer }, template.id, { parentId: folder.id }))) === "access",
    "making a page needs edit access where it goes",
  );
  check((await failure(() => templates.createFromTemplate({ userId: ids.guest }, template.id))) === "access", "guests can't see workspace templates");
  await setPagePermission(ids.owner, template.id, ids.guest, "view");
  check(
    (await failure(() => templates.createFromTemplate({ userId: ids.guest }, template.id))) === "access",
    "a guest who sees a template still can't add top-level pages from it",
  );
  await setPagePermission(ids.owner, folder.id, ids.guest, "edit");
  const guestMade = await templates.createFromTemplate({ userId: ids.guest }, template.id, { parentId: folder.id });
  check((await row(guestMade.id)).parentId === folder.id, "…but can under a page they may edit");
  await setPagePermission(ids.owner, template.id, ids.owner, "full");
  await setPagePermission(ids.owner, template.id, null, "none");
  check(!(await templates.listTemplates(ids.member, workspaceId)).some((t) => t.id === template.id), "a template hidden from someone isn't listed for them");
  check((await failure(() => templates.createFromTemplate(member, template.id))) === "access", "…and can't be used by them");
  check((await failure(() => templates.createFromTemplate({ userId: ids.outsider }, template.id))) === "access", "people outside the workspace can't use templates");
  check((await failure(() => templates.createFromTemplate(owner, spec.id))) === "notATemplate", "ordinary pages aren't templates");

  // Deleting needs full access and is for good
  await setPagePermission(ids.owner, template.id, ids.member, "edit");
  check((await failure(() => templates.deleteTemplate(ids.member, template.id))) === "access", "deleting a template needs full access");
  await templates.deleteTemplate(ids.owner, template.id);
  check(!(await row(template.id)) && !(await childrenOf(template.id)).length, "deleting a template removes it with its subpages");
  check((await failure(() => templates.deleteTemplate(ids.owner, spec.id))) === "notATemplate", "deleting refuses ordinary pages");

  // ---------------------------------------------------------------------------------------------
  // Row templates
  const tasks = await pages.createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  await databases.addProperty(ids.owner, tasks.id, { name: "Assignee", type: "person" });
  const clients = await pages.createPage(owner, { workspaceId, kind: "database", title: "Clients" });
  const acme = await pages.createPage(owner, { workspaceId, parentId: clients.id, title: "Acme" });
  const client = await databases.addProperty(ids.owner, tasks.id, {
    name: "Client",
    type: "relation",
    relation: { databaseId: clients.id, twoWay: true, pairedName: "Tasks" },
  });
  const paired = (await databases.getProperties(clients.id)).find((p) => p.type === "relation")!;
  const status = (await databases.getProperties(tasks.id)).find((p) => p.type === "status")!;
  const inProgress = status.options.options!.find((o) => o.name === "In progress")!;

  const bug = await templates.createRowTemplate(owner, tasks.id, {
    title: "Bug",
    properties: { Status: "In progress", Assignee: [ids.member], Client: [acme.id] },
    markdown: "## Steps to reproduce\n\n- [ ] ",
  });
  const bugRow = await row(bug.id);
  check(bugRow.isTemplate && bugRow.inTemplate && bugRow.parentId === tasks.id, "a row template is stored with its database", bugRow);
  check(
    (bugRow.properties[status.id] as string) === inProgress.id && JSON.stringify(bugRow.properties[client.id]) === JSON.stringify([acme.id]),
    "…with its property values",
    bugRow.properties,
  );
  check(!((await row(acme.id)).properties[paired.id] as string[] | undefined)?.includes(bug.id), "a template's links don't show up on the linked row");
  const assigned = () =>
    db.select().from(notification).where(and(eq(notification.userId, ids.member), eq(notification.kind, "assignment")));
  check((await assigned()).length === 0, "a template assigns nobody");
  check(!(await databases.listRows(ids.owner, tasks.id)).some((r) => r.id === bug.id), "views and queries leave row templates out");
  const snapshot = await databases.getDatabaseSnapshot(ids.owner, tasks.id);
  check(
    !snapshot.rows.some((r) => r.id === bug.id) && snapshot.templates.some((t) => t.id === bug.id) && snapshot.database.defaultTemplateId === null,
    "the database snapshot lists row templates apart from its rows",
    snapshot.templates,
  );
  const clientTargets = await databases.getRelationTargets(ids.owner, await databases.getProperties(clients.id));
  check(!clientTargets[paired.id].rows.some((r) => r.id === bug.id), "row templates aren't offered as relation targets");
  check(
    (await failure(() => databases.updateRowProperties(ids.owner, acme.id, { Tasks: [bug.id] }))) === "invalidRelation",
    "…and can't be linked to",
  );
  const bulk = await pages.archiveRows(ids.owner, tasks.id, [bug.id]);
  check(bulk.skipped.includes(bug.id) && !bulk.done.length && (await row(bug.id)).archivedAt === null, "bulk row actions skip row templates", bulk);

  // The default template and "New"
  const blank = await templates.createRow(owner, tasks.id, { useDefault: true });
  check(blank.templateId === null && (await row(blank.id)).title === "", "without a default template, New adds a blank row");
  // Members only view the database; the owner and one member may change it.
  await setPagePermission(ids.owner, tasks.id, ids.owner, "full");
  await setPagePermission(ids.owner, tasks.id, ids.member, "edit");
  await setPagePermission(ids.owner, tasks.id, null, "view");
  check(
    (await failure(() => templates.setDefaultRowTemplate(ids.viewer, tasks.id, bug.id))) === "access",
    "choosing the default template needs edit access",
  );
  await templates.setDefaultRowTemplate(ids.owner, tasks.id, bug.id);
  check((await databases.getDatabaseSnapshot(ids.owner, tasks.id)).database.defaultTemplateId === bug.id, "the default template is saved");
  // The owner adds it: people aren't told about rows they assign to themselves.
  const fromDefault = await templates.createRow(owner, tasks.id, { useDefault: true });
  const fromDefaultRow = await row(fromDefault.id);
  check(
    fromDefault.templateId === bug.id && !fromDefaultRow.isTemplate && !fromDefaultRow.inTemplate && fromDefaultRow.title === "Bug",
    "New starts from the default template",
    fromDefaultRow,
  );
  check((fromDefaultRow.properties[status.id] as string) === inProgress.id, "…with its values");
  check((await getCollab().readPage(fromDefault.id)).markdown.includes("Steps to reproduce"), "…and its body");
  check(((await row(acme.id)).properties[paired.id] as string[]).includes(fromDefault.id), "…linking back like any new row");
  check((await assigned()).length === 1, "…and assigning its people");
  check((await databases.listRows(ids.owner, tasks.id)).some((r) => r.id === fromDefault.id), "the new row shows in views");
  const chosen = await templates.createRow(owner, tasks.id, { templateId: bug.id, title: "Login bug", properties: { Status: "Done" } });
  const chosenRow = await row(chosen.id);
  check(chosenRow.title === "Login bug" && chosenRow.properties[status.id] !== inProgress.id, "values given with a template go over its values", chosenRow);
  const other = await pages.createPage(owner, { workspaceId, kind: "database", title: "Other" });
  check(
    (await failure(() => templates.createRow(owner, other.id, { templateId: bug.id }))) === "notATemplate",
    "a row template only makes rows of its own database",
  );
  check(
    (await failure(() => templates.setDefaultRowTemplate(ids.owner, other.id, bug.id))) === "notATemplate",
    "…and is only the default of its own database",
  );

  // Saving a row as a row template; duplicating a database keeps its templates
  const savedRow = await templates.saveAsTemplate(owner, chosen.id);
  const savedRowPage = await row(savedRow.id);
  check(
    savedRow.databaseId === tasks.id && savedRowPage.isTemplate && savedRowPage.parentId === tasks.id && savedRowPage.title === "Login bug",
    "saving a row as a template makes a row template of its database",
    savedRowPage,
  );
  const copy = await duplicatePage(owner, tasks.id, " (copy)");
  const copyRows = await childrenOf(copy.id);
  const copiedTemplates = copyRows.filter((r) => r.isTemplate);
  const copyDb = await row(copy.id);
  check(copiedTemplates.length === 2 && copiedTemplates.every((t) => t.inTemplate), "duplicating a database copies its row templates", copyRows);
  check(
    copiedTemplates.some((t) => t.id === copyDb.defaultTemplateId && t.title === "Bug"),
    "…and points its default at the copied template",
    copyDb.defaultTemplateId,
  );
  check(copyRows.filter((r) => !r.isTemplate).every((r) => !r.inTemplate), "…while its rows stay ordinary rows");

  // Deleting the default template leaves blank rows
  await templates.deleteTemplate(ids.owner, savedRow.id);
  await templates.deleteTemplate(ids.owner, bug.id);
  check((await row(tasks.id)).defaultTemplateId === null, "deleting the default template clears the default");

  // Database templates show their own rows when opened
  const dbTemplate = await templates.saveAsTemplate(owner, copy.id);
  const dbTemplateRows = await databases.listRows(ids.owner, dbTemplate.id);
  check(dbTemplateRows.length > 0, "a database saved as a template still shows its rows when opened", dbTemplateRows.length);
  check(
    (await childrenOf(dbTemplate.id)).every((r) => r.inTemplate),
    "…which are part of the template",
  );
  check(
    !(await databases.listWorkspaceDatabases(ids.owner, workspaceId)).some((d) => d.id === dbTemplate.id),
    "database templates aren't offered as relation targets",
  );
  const fromDbTemplate = await templates.createFromTemplate(owner, dbTemplate.id);
  const fromDbRows = await childrenOf(fromDbTemplate.id);
  check(
    fromDbRows.length === dbTemplateRows.length + 2 && fromDbRows.filter((r) => !r.isTemplate).every((r) => !r.inTemplate)
      && fromDbRows.filter((r) => r.isTemplate).length === 2 && fromDbRows.filter((r) => r.isTemplate).every((r) => r.inTemplate),
    "a database made from a template gets ordinary rows and keeps its row templates",
    fromDbRows.map((r) => ({ title: r.title, isTemplate: r.isTemplate, inTemplate: r.inTemplate })),
  );
  check(
    (await failure(() => templates.createFromTemplate(owner, dbTemplate.id, { parentId: tasks.id }))) === "nestedDatabase",
    "a database template can't make a row",
  );

  // ---------------------------------------------------------------------------------------------
  // Published sites never show templates
  const report = await templates.createRowTemplate(owner, tasks.id, { title: "Report" });
  const { token } = await publishPage(ids.owner, tasks.id);
  const published = await getPublishedPage(token);
  check(published?.database && !published.database.rows.some((r) => r.id === report.id), "a published database leaves its row templates out", published?.database?.rows);
  check((await getPublishedPage(token, report.id)) === null, "…and doesn't serve them by id");
  check((await failure(() => publishPage(ids.owner, dbTemplate.id))) === "Templates can't be published", "templates can't be published");

  // ---------------------------------------------------------------------------------------------
  // Built-in gallery
  const meeting = await templates.createFromBuiltin(member, workspaceId, "meeting-notes", { locale: "en" });
  const meetingPage = await row(meeting.id);
  check(meetingPage.title === "Meeting notes" && !meetingPage.inTemplate, "a built-in page template makes an ordinary page");
  check((await getCollab().readPage(meeting.id)).markdown.includes("Action items"), "…with its body");
  const tracker = await templates.createFromBuiltin(member, workspaceId, "project-tracker", { locale: "tr" });
  const trackerDb = await databases.getDatabaseSnapshot(ids.member, tracker.id);
  check(
    trackerDb.database.title === "Proje takibi" && trackerDb.properties.some((p) => p.name === "Öncelik") && trackerDb.views.some((v) => v.type === "board"),
    "the built-in project tracker makes a database in the user's language",
    { title: trackerDb.database.title, properties: trackerDb.properties.map((p) => p.name), views: trackerDb.views.map((v) => v.type) },
  );
  check(
    trackerDb.rows.length === 3 && trackerDb.templates.length === 1 && trackerDb.database.defaultTemplateId === trackerDb.templates[0].id,
    "…with example rows and a default row template",
    { rows: trackerDb.rows.length, templates: trackerDb.templates },
  );
  check(!(await templates.listTemplates(ids.member, workspaceId)).some((t) => t.id === tracker.id), "built-ins don't add workspace templates");
  check((await failure(() => templates.createFromBuiltin({ userId: ids.guest }, workspaceId, "weekly-plan"))) === "access", "guests can't add built-ins at the top level");

  // ---------------------------------------------------------------------------------------------
  // A subpage saved as a template keeps the access it had from above
  const vault = await pages.createPage(owner, { workspaceId, title: "Vault" });
  await setPagePermission(ids.owner, vault.id, ids.owner, "full");
  await setPagePermission(ids.owner, vault.id, null, "none");
  await setPagePermission(ids.owner, vault.id, ids.member, "view");
  const vaultNotes = await pages.createPage(owner, { workspaceId, parentId: vault.id, title: "Vault notes", markdown: "Not for everyone." });
  const vaultTemplate = await templates.saveAsTemplate(member, vaultNotes.id);
  check((await row(vaultTemplate.id)).parentId === null, "a subpage saved as a template goes to the top level");
  const levelOf = async (userId: string, pageId: string) =>
    Number((await db.execute<{ level: number }>(sql`select page_access_level(${userId}, ${pageId}) as level`))[0].level);
  for (const who of [ids.owner, ids.member, ids.viewer, ids.guest]) {
    const [source, copy] = [await levelOf(who, vaultNotes.id), await levelOf(who, vaultTemplate.id)];
    check(copy === source, `…and ${who.slice(RUN.length + 1)} has the same access to it as to the subpage`, { source, copy });
  }
  check(!(await templates.listTemplates(ids.viewer, workspaceId)).some((t) => t.id === vaultTemplate.id), "…so members it wasn't shared with don't see it");

  // ---------------------------------------------------------------------------------------------
  // MCP
  const pageTemplate = await templates.saveAsTemplate(owner, spec.id);
  const listedMcp = await callTool(ids.owner, "list_templates", { workspace_id: workspaceId });
  check(
    listedMcp.data?.templates.some((t: { id: string }) => t.id === pageTemplate.id)
      && listedMcp.data.built_in.some((t: { id: string }) => t.id === "builtin:weekly-plan"),
    "list_templates lists the workspace's templates and the built-in gallery",
    listedMcp.text,
  );
  const mcpPage = await callTool(ids.owner, "create_page", { workspace_id: workspaceId, template_id: pageTemplate.id });
  check(mcpPage.data?.title === "Spec" && mcpPage.data.from_template === pageTemplate.id, "create_page copies a template", mcpPage.text);
  check((await childrenOf(mcpPage.data.id)).length === 1, "…with its subpages");
  const mcpBuiltin = await callTool(ids.owner, "create_page", { workspace_id: workspaceId, template_id: "builtin:weekly-plan", title: "Week 40" });
  check(mcpBuiltin.data?.title === "Week 40", "create_page makes a page from a built-in template", mcpBuiltin.text);
  check((await callTool(ids.owner, "create_page", { workspace_id: workspaceId })).isError, "create_page still needs a title without a template");
  const searchMcp = await callTool(ids.owner, "search", { query: word, workspace_id: workspaceId, limit: 50 });
  check(!searchMcp.data.results.some((r: { id: string }) => r.id === pageTemplate.id), "MCP search leaves templates out");
  const listMcp = await callTool(ids.owner, "list_pages", { workspace_id: workspaceId });
  check(!listMcp.data.pages.some((p: { id: string }) => p.id === pageTemplate.id), "list_pages leaves templates out");
  const getMcp = await callTool(ids.owner, "get_page", { page_id: pageTemplate.id });
  check(getMcp.data?.template === "page_template", "get_page says a page is a template", getMcp.text);

  const rowTemplates = await callTool(ids.owner, "list_templates", { database_id: tracker.id });
  check(
    rowTemplates.data?.templates.length === 1 && rowTemplates.data.templates[0].default === true,
    "list_templates lists a database's row templates and its default",
    rowTemplates.text,
  );
  const mcpRow = await callTool(ids.owner, "create_database_row", { database_id: tracker.id, title: "From MCP" });
  check(
    mcpRow.data?.from_template === rowTemplates.data.default_template_id && mcpRow.data.title === "From MCP" && mcpRow.data.properties["Öncelik"] === "Orta",
    "create_database_row without values starts from the default template",
    mcpRow.text,
  );
  const mcpBlank = await callTool(ids.owner, "create_database_row", { database_id: tracker.id, title: "Blank", template_id: "none" });
  check(mcpBlank.data && !mcpBlank.data.from_template && mcpBlank.data.properties["Öncelik"] == null, "template_id \"none\" makes a blank row", mcpBlank.text);
  const mcpValues = await callTool(ids.owner, "create_database_row", { database_id: tracker.id, title: "Values", properties: { Öncelik: "Düşük" } });
  check(mcpValues.data && !mcpValues.data.from_template, "rows with values don't use the default template", mcpValues.text);
  const query = await callTool(ids.owner, "query_database", { database_id: tracker.id });
  check(
    !query.data.rows.some((r: { id: string }) => r.id === rowTemplates.data.default_template_id),
    "query_database leaves row templates out",
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
