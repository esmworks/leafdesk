/**
 * End-to-end check of the "Linked from" list against the database: the text kept around each link
 * (other pages' titles left out, kept up to date, none for a "Link to page" block, carried to
 * copies, in MCP's get_page), unlinked mentions (whole words, the Turkish dotted and dotless i,
 * leaving out the page itself, linking pages, the trash, templates, other workspaces and pages the
 * reader can't see) and linking one (first plain occurrence, not in code, edit access, locked
 * pages, a source open in an editor). Creates its own users and workspaces and deletes them
 * afterwards.
 *
 *   pnpm tsx scripts/backlinks-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { LINK_PLACEHOLDER: P } = await import("@/lib/link-context");
const { eachMention } = await import("@/lib/mentions");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, setPageLocked } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { setPagePermission } = await import("@/server/permissions");
const { linkUnlinkedMention, listBacklinks, listUnlinkedMentions } = await import("@/server/mentions");
const { getPage } = await import("@/server/operations");
const { AccessError } = await import("@/server/access");

const RUN = `backlinks-e2e-${Date.now().toString(36)}`;

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
    return String((error as { code?: unknown }).code ?? error);
  }
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-other`;
const owner = { userId: ids.owner };
const link = (pageId: string) => `[x](/w/${workspaceId}/p/${pageId})`;
const make = (title: string, parentId: string | null = null) => createPage(owner, { workspaceId, parentId, title });
const write = (pageId: string, markdown: string) => getCollab().replaceContent(pageId, markdown, owner);
const backlink = async (target: string, source: string, userId = ids.owner) =>
  (await listBacklinks(userId, target)).find((b) => b.id === source);
const unlinkedIds = async (target: string, userId = ids.owner) => (await listUnlinkedMentions(userId, target)).map((m) => m.id);

async function pageMentions(pageId: string) {
  const { blocks } = await getCollab().readBlocks(pageId);
  const found: string[] = [];
  eachMention(blocks as Parameters<typeof eachMention>[0], (m) => m.kind === "page" && found.push(m.pageId));
  return found;
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN} other` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  // ── Context around links ─────────────────────────────────────────────────────────────────
  const target = await make("Launch plan");
  const secret = await make("Secret layoffs");
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  const notes = await make("Weekly notes");
  await write(notes.id, `Intro line.\n\nWe agreed on ${link(target.id)} after ${link(secret.id)} came up.`);
  const linked = await backlink(target.id, notes.id);
  check(linked?.context === `We agreed on ${P} after  came up.`, "a backlink keeps the text around the link, the link as a placeholder", linked);
  const secretLink = await backlink(secret.id, notes.id);
  check(
    secretLink?.context === `We agreed on  after ${P} came up.` && !linked.context.includes("Secret"),
    "…and other pages' titles stay out of it",
    secretLink,
  );

  await write(notes.id, `Intro line.\n\nNow ${link(target.id)} ships first.`);
  check((await backlink(target.id, notes.id))?.context === `Now ${P} ships first.`, "editing the text updates the context");

  const linkBlock = await make("Index");
  await write(linkBlock.id, `${link(target.id)} <!-- leafdesk:page-link -->`);
  check((await backlink(target.id, linkBlock.id))?.context === null, "a Link to page block has no context");

  const long = await make("Long text");
  await write(long.id, `${"word ".repeat(60)}${link(target.id)}${" more".repeat(60)}`);
  const longContext = (await backlink(target.id, long.id))?.context ?? "";
  check(
    longContext.startsWith("…word") && longContext.endsWith("more…") && longContext.length < 220,
    "a long block is cut around the link",
    longContext,
  );

  const copy = await duplicatePage(owner, notes.id, " (copy)");
  check((await backlink(target.id, copy.id))?.context === `Now ${P} ships first.`, "a copy keeps the context of its links");

  const mcp = (await getPage({ userId: ids.owner, actor: owner }, { page_id: target.id, offset: 0 })) as {
    linked_from?: { id: string; context?: string }[];
  };
  check(
    mcp.linked_from?.find((l) => l.id === notes.id)?.context === "Now Launch plan ships first." &&
      mcp.linked_from?.find((l) => l.id === linkBlock.id)?.context === undefined,
    "MCP's get_page shows the context with the page's title",
    mcp.linked_from,
  );

  // ── Unlinked mentions ────────────────────────────────────────────────────────────────────
  const plain = await make("Standup");
  await write(plain.id, "Agenda\n\nReview the **launch PLAN** and the launch plan budget.");
  const partial = await make("Planning");
  await write(partial.id, "Launch planning starts later.");
  const codeOnly = await make("Snippets");
  await write(codeOnly.id, "```\nlaunch plan\n```");
  const archived = await make("Old standup");
  await write(archived.id, "The launch plan, again.");
  await archivePage(ids.owner, archived.id);
  const template = await make("Template notes");
  await write(template.id, "Fill in the launch plan.");
  await db.update(page).set({ inTemplate: true }).where(eq(page.id, template.id));
  const titled = await make("Launch plan review");
  const foreign = await createPage({ userId: ids.outsider }, { workspaceId: otherWorkspace, title: "Elsewhere" });
  await getCollab().replaceContent(foreign.id, "Our launch plan too.", { userId: ids.outsider });
  const privateNote = await make("Private");
  await write(privateNote.id, "My launch plan thoughts.");
  await setPagePermission(ids.owner, privateNote.id, ids.owner, "full");
  await setPagePermission(ids.owner, privateNote.id, null, "none");
  await write(target.id, "This launch plan is about the launch plan.");

  const found = await listUnlinkedMentions(ids.owner, target.id);
  const foundIds = found.map((m) => m.id);
  check(
    foundIds.includes(plain.id) && foundIds.includes(codeOnly.id) && foundIds.includes(privateNote.id),
    "pages writing the title as words are unlinked mentions",
    found,
  );
  check(
    ![partial.id, archived.id, template.id, titled.id, foreign.id, target.id, notes.id, linkBlock.id].some((id) => foundIds.includes(id)),
    "…not part of a word, the trash, templates, a title alone, other workspaces, the page itself or pages already linking",
    found,
  );
  const standup = found.find((m) => m.id === plain.id);
  check(
    standup?.excerpt.match === "launch PLAN" && standup.excerpt.after.startsWith(" and the") && standup.canEdit,
    "an unlinked mention shows where the title is written",
    standup,
  );
  check(!(await unlinkedIds(target.id, ids.member)).includes(privateNote.id), "…and leaves out pages the reader can't see");
  check((await failure(() => listUnlinkedMentions(ids.member, secret.id))) === "access", "a page's unlinked mentions need access to it");

  await setPagePermission(ids.owner, target.id, ids.guest, "view");
  await setPagePermission(ids.owner, plain.id, ids.guest, "view");
  const asGuest = await listUnlinkedMentions(ids.guest, target.id);
  check(
    asGuest.map((m) => m.id).join() === plain.id && asGuest[0].canEdit === false,
    "a guest sees only the pages shared with them, without linking them",
    asGuest,
  );

  const turkish = await make("İçe aktarma");
  const turkishNote = await make("Notlar");
  await write(turkishNote.id, "Yarın içe aktarma denenecek.");
  check((await unlinkedIds(turkish.id)).includes(turkishNote.id), "the Turkish dotted İ matches a lower-case i");
  const shouted = await make("Pazarlama");
  await write(shouted.id, "Sosyal medya için LANSMAN PLANI taslağı.");
  const dotless = await make("Lansman planı");
  check((await unlinkedIds(dotless.id)).includes(shouted.id), "…and a title with ı is found written in capitals");
  const short = await make("Q");
  await write(turkishNote.id, "Q and q everywhere.");
  check((await listUnlinkedMentions(ids.owner, short.id)).length === 0, "titles too short to look for find nothing");

  // ── Linking ──────────────────────────────────────────────────────────────────────────────
  check((await failure(() => linkUnlinkedMention(ids.guest, plain.id, target.id))) === "access", "linking needs edit access to the source");
  check(await linkUnlinkedMention(ids.owner, plain.id, target.id), "linking an unlinked mention works");
  check((await pageMentions(plain.id)).join() === target.id, "…it becomes one mention of the page");
  const after = (await getCollab().readPage(plain.id)).text;
  check(after.includes("Review the ") && after.includes(" and the launch plan budget."), "…in place of the first occurrence only", after);
  check(Boolean(await backlink(target.id, plain.id)), "…and the page shows under Linked from right away");
  check(!(await unlinkedIds(target.id)).includes(plain.id), "…and not as unlinked any more");
  check(!(await linkUnlinkedMention(ids.owner, codeOnly.id, target.id)), "a title only in code can't be linked");
  check(
    (await failure(() => linkUnlinkedMention(ids.owner, foreign.id, target.id))) === "access",
    "a page of another workspace can't be linked",
  );

  await setPageLocked(ids.owner, privateNote.id, true);
  check((await failure(() => linkUnlinkedMention(ids.owner, privateNote.id, target.id))) === "pageLocked", "a locked page refuses");
  await setPageLocked(ids.owner, privateNote.id, false);

  // Open in an editor: the document changes live and the list doesn't wait for the save. Opened
  // right after a write, while that write's save is still about to unload its document: the new
  // document must stay the one everyone edits (or closing the editor would undo the link).
  const open = await make("Open page");
  await write(open.id, "Draft of the launch plan.");
  const editor = await hocuspocus.openDirectConnection(`page:${open.id}`, { userId: ids.owner });
  try {
    check(await linkUnlinkedMention(ids.owner, open.id, target.id), "linking a page open in an editor works");
    check(Boolean(await backlink(target.id, open.id)), "…and shows under Linked from without waiting for the save");
  } finally {
    await editor.disconnect();
  }
  check((await pageMentions(open.id)).join() === target.id, "…and the open document has the mention");

  // The same, made certain: a save's late unload of a document closed and opened again since.
  const reopened = await make("Reopened");
  const first = await hocuspocus.openDirectConnection(`page:${reopened.id}`, { userId: ids.owner });
  const closed = first.document!;
  await first.disconnect();
  const second = await hocuspocus.openDirectConnection(`page:${reopened.id}`, { userId: ids.owner });
  try {
    check(second.document !== closed, "a page closed and opened again gets a new document");
    await hocuspocus.unloadDocument(closed);
    check(
      hocuspocus.documents.get(`page:${reopened.id}`) === second.document,
      "unloading the closed document leaves the open one in place",
    );
  } finally {
    await second.disconnect();
  }

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
