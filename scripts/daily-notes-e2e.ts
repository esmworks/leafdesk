/**
 * End-to-end check of daily notes: one private page per person, workspace and day under their
 * journal, made once (also when asked twice at the same moment), replaced when it went to the
 * trash, started from a few headings, blank or a template; the journal page made again when it is
 * gone; guests without private pages refused; `type:journal` in search; the MCP tools.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/daily-notes-e2e.ts
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
const { dailyNote, journal: journalTable, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const pages = await import("@/server/pages");
const journal = await import("@/server/journal");
const templates = await import("@/server/templates");
const { AccessError, resolvePageAccess } = await import("@/server/access");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");

const RUN = `daily-notes-e2e-${Date.now().toString(36)}`;

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

async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AccessError) return "access";
    if (error instanceof journal.JournalError) return error.code;
    throw error;
  }
}

const row = async (id: string) => (await db.select().from(page).where(eq(page.id, id)))[0];
const bodyOf = async (id: string) => (await getCollab().readPage(id)).markdown;

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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "daily-notes-e2e", version: "1" } },
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
const owner = { userId: ids.owner };
const member = { userId: ids.member };

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);

  // ---------------------------------------------------------------------------------------------
  // The first note makes the journal
  const first = await journal.getOrCreateDailyNote(member, workspaceId, "2026-10-17", { locale: "tr" });
  const firstPage = await row(first.pageId);
  check(first.created && first.day === "2026-10-17" && firstPage.title === "17 Ekim 2026", "a new note is titled with its day in the user's language", first);
  const journalPage = await row(firstPage.parentId!);
  check(
    journalPage.title === "Günlük" && journalPage.parentId === null && journalPage.teamspaceId === null && journalPage.createdBy === ids.member,
    "…under the user's journal, a private top-level page",
    journalPage,
  );
  check((await bodyOf(first.pageId)).includes("## Odak"), "…started with a few headings in their language");
  check((await resolvePageAccess(ids.owner, first.pageId)).level === "none", "…and nobody else sees it, not even an owner");

  const again = await journal.getOrCreateDailyNote(member, workspaceId, "2026-10-17", { locale: "en" });
  check(!again.created && again.pageId === first.pageId, "asking again for the same day opens the same note");

  // Made at the same moment (two tabs, an assistant): still one note.
  const [a, b, c] = await Promise.all([
    journal.getOrCreateDailyNote(member, workspaceId, "2026-10-18"),
    journal.getOrCreateDailyNote(member, workspaceId, "2026-10-18"),
    journal.getOrCreateDailyNote(member, workspaceId, "2026-10-18"),
  ]);
  check(a.pageId === b.pageId && b.pageId === c.pageId, "notes asked for at the same moment are one note", [a, b, c]);
  const sameDay = await db
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.parentId, journalPage.id), eq(page.title, "October 18, 2026"), isNull(page.archivedAt)));
  check(sameDay.length === 1, "…and no extra page is left behind", sameDay);
  const journals = await db.select().from(journalTable).where(and(eq(journalTable.workspaceId, workspaceId), eq(journalTable.userId, ids.member)));
  check(journals.length === 1 && journals[0].pageId === journalPage.id, "…nor a second journal");

  await journal.getOrCreateDailyNote(member, workspaceId, "2026-10-12");
  const listed = await journal.listDailyNotes(ids.member, workspaceId);
  check(
    listed.map((n) => n.day).join() === "2026-10-18,2026-10-17,2026-10-12",
    "notes are listed newest first",
    listed,
  );
  const tree = (await pages.getTree(ids.member, workspaceId)).filter((n) => n.parentId === journalPage.id);
  check(
    tree.map((n) => n.title).join(" | ") === "October 18, 2026 | 17 Ekim 2026 | October 12, 2026",
    "the journal lists the latest day first in the sidebar",
    tree.map((n) => n.title),
  );
  check(
    (await journal.listDailyNotes(ids.member, workspaceId, { from: "2026-10-13", to: "2026-10-17" })).map((n) => n.day).join() === "2026-10-17",
    "notes can be listed from one day to another",
  );
  check((await journal.listDailyNotes(ids.owner, workspaceId)).length === 0, "each person lists only their own notes");

  // ---------------------------------------------------------------------------------------------
  // Trash
  await pages.archivePage(ids.member, first.pageId);
  check((await journal.findDailyNote(ids.member, workspaceId, "2026-10-17")) === null, "a note in the trash no longer counts");
  const replaced = await journal.getOrCreateDailyNote(member, workspaceId, "2026-10-17");
  check(replaced.created && replaced.pageId !== first.pageId, "opening its day makes a new note");

  await pages.archivePage(ids.member, journalPage.id);
  const afterJournal = await journal.getOrCreateDailyNote(member, workspaceId, "2026-10-19");
  const newJournal = (await row(afterJournal.pageId)).parentId!;
  check(afterJournal.created && newJournal !== journalPage.id, "a journal in the trash is replaced by a new one", afterJournal);
  check((await journal.getJournalSettings(ids.member, workspaceId)).pageId === newJournal, "…which the settings point at");
  check((await journal.findDailyNote(ids.member, workspaceId, "2026-10-17")) === null, "the old journal's notes went to the trash with it");

  // ---------------------------------------------------------------------------------------------
  // How notes start
  const word = `kumquat${Date.now().toString(36)}`;
  const template = await pages.createPage(owner, { workspaceId, title: "Daily review", markdown: `## Review ${word}\n\nWhat went well?`, template: true });
  const ownerTemplate = await pages.createPage(owner, { workspaceId, teamspaceId: null, title: "Owner only", template: true });
  check(
    (await refused(() => journal.setJournalStart(ids.member, workspaceId, { start: "template", templateId: ownerTemplate.id }))) === "notATemplate",
    "a template the user can't see can't be picked",
  );
  check(
    (await refused(() => journal.setJournalStart(ids.member, workspaceId, { start: "template", templateId: first.pageId }))) === "notATemplate",
    "nor a page that isn't a template",
  );
  const picked = await journal.setJournalStart(ids.member, workspaceId, { start: "template", templateId: template.id });
  check(picked.start === "template" && picked.template?.id === template.id, "a workspace template can be picked", picked);
  const fromTemplate = await journal.getOrCreateDailyNote(member, workspaceId, "2026-10-20");
  const fromTemplateRow = await row(fromTemplate.pageId);
  check(
    (await bodyOf(fromTemplate.pageId)).includes(word) && fromTemplateRow.title === "October 20, 2026" && !fromTemplateRow.isTemplate && !fromTemplateRow.inTemplate,
    "a new note copies the template, titled with its day",
    fromTemplateRow,
  );
  check((await resolvePageAccess(ids.owner, fromTemplate.pageId)).level === "none", "…and stays private");

  await journal.setJournalStart(ids.member, workspaceId, { start: "blank" });
  const blank = await journal.getOrCreateDailyNote(member, workspaceId, "2026-10-21");
  check((await bodyOf(blank.pageId)).trim() === "", "a blank start makes an empty note");

  await journal.setJournalStart(ids.member, workspaceId, { start: "template", templateId: template.id });
  await templates.deleteTemplate(ids.owner, template.id);
  const fallback = await journal.getJournalSettings(ids.member, workspaceId);
  check(fallback.start === "default" && fallback.template === null, "a deleted template falls back to the headings", fallback);

  // ---------------------------------------------------------------------------------------------
  // Who may
  check((await refused(() => journal.getOrCreateDailyNote({ userId: ids.guest }, workspaceId, "2026-10-17"))) === "access", "guests without private pages can't keep a journal");
  check((await refused(() => journal.getOrCreateDailyNote({ userId: ids.outsider }, workspaceId, "2026-10-17"))) === "access", "nor can people outside the workspace");
  check((await refused(() => journal.getOrCreateDailyNote(member, workspaceId, "2026-02-30"))) === "badDay", "a day that doesn't exist is refused");
  check((await refused(() => journal.getOrCreateDailyNote(member, workspaceId, "3001-01-01"))) === "badDay", "…and so is one far out");

  // ---------------------------------------------------------------------------------------------
  // Search
  const found = await pages.searchWithQuery(ids.member, workspaceId, "type:journal", 50);
  const foundIds = new Set(found.map((h) => h.id));
  check(
    foundIds.has(afterJournal.pageId) && foundIds.has(fromTemplate.pageId) && !foundIds.has(newJournal) && !foundIds.has(replaced.pageId),
    "type:journal lists the user's notes, not the journal page or notes in the trash",
    found.map((h) => h.title),
  );
  const ownerNote = await journal.getOrCreateDailyNote(owner, workspaceId, "2026-10-17");
  const ownerFound = await pages.searchWithQuery(ids.owner, workspaceId, "type:journal", 50);
  check(ownerFound.length === 1 && ownerFound[0].id === ownerNote.pageId, "…and only their own", ownerFound.map((h) => h.title));
  const byWord = await pages.searchWithQuery(ids.member, workspaceId, `type:journal ${word}`, 50);
  check(byWord.length === 1 && byWord[0].id === fromTemplate.pageId, "type:journal narrows a search for words", byWord.map((h) => h.title));

  // ---------------------------------------------------------------------------------------------
  // MCP
  const mcp = await callTool(ids.member, "get_or_create_daily_note", { workspace_id: workspaceId, date: "2026-10-20" });
  check(mcp.data?.id === fromTemplate.pageId && mcp.data.created === false && mcp.data.url.includes(fromTemplate.pageId), "get_or_create_daily_note opens an existing note", mcp.text);
  const mcpNew = await callTool(ids.member, "get_or_create_daily_note", { workspace_id: workspaceId, date: "2026-11-01" });
  check(mcpNew.data?.created === true && mcpNew.data.title === "November 1, 2026", "…and makes a missing one, titled in English", mcpNew.text);
  const mcpBad = await callTool(ids.member, "get_or_create_daily_note", { workspace_id: workspaceId, date: "2026-13-01" });
  check(mcpBad.isError && /YYYY-MM-DD/.test(mcpBad.text), "…refusing a day that doesn't exist with the reason", mcpBad.text);
  const mcpList = await callTool(ids.member, "list_daily_notes", { workspace_id: workspaceId, from: "2026-10-20" });
  check(
    mcpList.data?.notes.map((n: { date: string }) => n.date).join() === "2026-11-01,2026-10-21,2026-10-20",
    "list_daily_notes lists the user's notes from a day on",
    mcpList.text,
  );
  const stored = await db.select().from(dailyNote).where(and(eq(dailyNote.workspaceId, workspaceId), inArray(dailyNote.userId, [ids.member])));
  check(stored.length === 7, "one row per day the member has a note for", stored.map((s) => s.day));

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
