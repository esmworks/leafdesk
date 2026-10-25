/**
 * End-to-end check of the Markdown source view's reading and saving (server/markdown-source.ts):
 * a page with a callout, a toggle, equations, a footnote, a diagram, an inline database, a synced
 * block, a mention and a comment reads as Markdown and is written back from an edit of it with
 * nothing lost; a save keeps a history version; someone else's edit meanwhile makes a save a
 * conflict that writes nothing, and saving again over it works; what Markdown can't hold is listed;
 * and only people who may edit the page can read or save it. Creates its own users and workspace
 * and deletes them afterwards.
 *
 *   pnpm tsx scripts/markdown-source-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. No app server needed.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { randomUUID } = await import("node:crypto");
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, pageSnapshot, user, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { referenceLine } = await import("@/lib/embed-blocks");
const { syncedFragmentName } = await import("@/lib/synced-blocks");
const { changedSyncedRegions } = await import("@/lib/markdown-source");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { threadQuotes } = await import("@/server/collab/comment-marks");
const { serverEditor } = await import("@/server/blocknote");
const { changeComments } = await import("@/server/comments");
const { createInlineDatabase } = await import("@/server/embeds");
const { archivePage, createPage, ENGLISH_SEED_NAMES, setPageLocked } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { AccessError } = await import("@/server/access");
const { readMarkdownSource, saveMarkdownSource } = await import("@/server/markdown-source");
const { getPage } = await import("@/server/operations");
const Y = await import("yjs");

const RUN = `mdsource-e2e-${Date.now().toString(36)}`;

// The real collab service: reads and writes go through the live document as the app's do.
const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
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
    return String((error as { code?: unknown }).code ?? (error as Error).message);
  }
}

type Block = { id: string; type: string; props: Record<string, unknown>; content?: unknown; children: Block[] };

/** The page's document, as a second browser would see and change it. */
async function inDoc<T>(pageId: string, userId: string, fn: (doc: import("yjs").Doc) => T): Promise<T> {
  const conn = await hocuspocus.openDirectConnection(`page:${pageId}`, { userId });
  try {
    let out!: T;
    await conn.transact((doc) => {
      out = fn(doc);
    });
    return out;
  } finally {
    await conn.disconnect();
  }
}

const bodyOf = (pageId: string) =>
  inDoc(pageId, ids.owner, (doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT)) as unknown as Block[]);

function walk(blocks: Block[], fn: (block: Block) => void) {
  for (const block of blocks) {
    fn(block);
    walk(block.children ?? [], fn);
  }
}

const find = (blocks: Block[], test: (block: Block) => boolean) => {
  let hit: Block | undefined;
  walk(blocks, (block) => {
    if (!hit && test(block)) hit = block;
  });
  return hit;
};

const inlineOf = (block: Block | undefined) => (Array.isArray(block?.content) ? (block!.content as { type: string; props?: Record<string, unknown>; text?: string }[]) : []);
const textOf = (block: Block | undefined) => inlineOf(block).map((n) => n.text ?? "").join("");

const ids = { owner: `${RUN}-owner`, editor: `${RUN}-editor`, viewer: `${RUN}-viewer` };
const names = { owner: "Ada Owner", editor: "Ben Editor", viewer: "Cy Viewer" };
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(
    (Object.keys(ids) as (keyof typeof ids)[]).map((key) => ({ id: ids[key], name: names[key], email: `${ids[key]}@example.test` })),
  );
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.viewer, role: "member" },
  ]);
  const owner = { userId: ids.owner };

  // A page with every kind of block the Markdown has a form for, and some it only refers to
  const spec = await createPage(owner, { workspaceId, title: "Spec" });
  await setPagePermission(ids.owner, spec.id, ids.owner, "full");
  await setPagePermission(ids.owner, spec.id, null, "none");
  await setPagePermission(ids.owner, spec.id, ids.editor, "edit");
  await setPagePermission(ids.owner, spec.id, ids.viewer, "view");
  const inline = await createInlineDatabase(owner, spec.id, ENGLISH_SEED_NAMES);
  const syncId = randomUUID();
  const body = [
    "# Spec",
    "",
    "> [!NOTE]",
    "> 💡 Read this first",
    "",
    "<details>",
    "<summary>",
    "",
    "More detail",
    "",
    "</summary>",
    "",
    "Hidden text",
    "",
    "</details>",
    "",
    "Euler wrote $e^{i\\pi}+1=0$ once.[^1]",
    "",
    "$$",
    "\\int_0^1 x\\,dx",
    "$$",
    "",
    "```mermaid",
    "graph TD; A-->B",
    "```",
    "",
    referenceLine("database", inline.id),
    "",
    `<!-- leafdesk:synced-block ${spec.id} ${syncId} -->`,
    "<!-- leafdesk:synced-block-end -->",
    "",
    "Ask @Ada Owner about it.",
    "",
    "Last paragraph stays.",
    "",
    "[^1]: The note.",
  ].join("\n");
  await service.replaceContent(spec.id, body, owner);
  // The synced block's own blocks live in a fragment of the page's document.
  await inDoc(spec.id, ids.owner, (doc) =>
    serverEditor.blocksToYXmlFragment([{ type: "paragraph", content: "Shared text" }] as never, doc.getXmlFragment(syncedFragmentName(syncId))),
  );
  await changeComments(ids.owner, spec.id, { type: "createThread", body: "Check this", anchor: { quote: "Last paragraph" } });
  const before = await bodyOf(spec.id);
  const mentionBefore = inlineOf(find(before, (b) => textOf(b).startsWith("Ask"))).find((n) => n.type === "mention");
  check(mentionBefore?.props?.userId === ids.owner, "the page mentions the owner", mentionBefore);

  // Reading
  const source = await readMarkdownSource(ids.editor, spec.id);
  check(source.version === (await service.pageVersion(spec.id)), "the Markdown comes with the body's version", source.version);
  for (const [part, label] of [
    ["> [!NOTE]", "the callout"],
    ["<details>", "the toggle"],
    ["$e^{i\\pi}+1=0$", "the inline equation"],
    ["$$\n\\int_0^1 x\\,dx\n$$", "the equation block"],
    ["[^1]: The note.", "the footnote"],
    ["```mermaid", "the diagram"],
    [referenceLine("database", inline.id), "the inline database's reference line"],
    ["Shared text", "the synced block's blocks"],
  ] as const) {
    check(source.markdown.includes(part), `the Markdown holds ${label}`, source.markdown);
  }
  check(source.losses.length === 0, "nothing on the page is lost by writing it as Markdown", source.losses);
  check(source.people.some((p) => p.id === ids.owner && p.name === names.owner), "the read names the people @Name mentions", source.people);

  // Saving an edit
  const edited = source.markdown
    .replace("Last paragraph stays.", "A new paragraph.\n\nLast paragraph stays.")
    .replace("[^1]: The note.", "Added at the end.\n\n[^1]: The note.");
  const saved = await saveMarkdownSource({ userId: ids.editor }, spec.id, edited, source.version);
  check(!saved.conflict && saved.version === (await service.pageVersion(spec.id)), "the edit is saved", saved);
  const after = await bodyOf(spec.id);
  check(textOf(find(after, (b) => b.type === "paragraph" && textOf(b) === "A new paragraph.")) === "A new paragraph.", "the new paragraph is there");
  check(textOf(after.filter((b) => b.type === "paragraph" && textOf(b)).at(-1)) === "Added at the end.", "…and the one at the end");
  check(find(after, (b) => b.type === "callout" && textOf(b).includes("Read this first")), "the callout survives");
  const toggle = find(after, (b) => b.type === "toggleListItem");
  check(toggle && textOf(toggle) === "More detail" && textOf(toggle.children[0]) === "Hidden text", "the toggle survives with its nested block", toggle);
  check(find(after, (b) => b.type === "math" && textOf(b).includes("\\int_0^1")), "the equation block survives");
  const euler = find(after, (b) => textOf(b).startsWith("Euler"));
  check(inlineOf(euler).some((n) => n.type === "inlineMath"), "the inline equation survives", euler);
  check(inlineOf(euler).some((n) => n.type === "footnote"), "the footnote survives", euler);
  check(find(after, (b) => b.type === "mermaid"), "the diagram survives");
  const database = find(after, (b) => b.type === "database");
  const databaseBefore = find(before, (b) => b.type === "database");
  check(database?.props.databaseId === inline.id, "the inline database survives", database);
  // Links to its blocks (#block-…) and open editors' places in them stay put.
  const lost = before.filter((b) => !after.some((a) => a.id === b.id)).map(textOf);
  check(lost.length === 0 && database.id === databaseBefore?.id, "the blocks the edit left alone keep their ids", lost);
  const synced = find(after, (b) => b.type === "syncedBlock");
  check(synced?.props.syncId === syncId && synced.props.pageId === spec.id, "the synced block survives", synced);
  const sharedText = await inDoc(spec.id, ids.owner, (doc) =>
    (serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(syncedFragmentName(syncId))) as unknown as Block[]).map(textOf).join("|"),
  );
  check(sharedText === "Shared text", "…and keeps its own blocks", sharedText);
  const mentionAfter = inlineOf(find(after, (b) => textOf(b).startsWith("Ask"))).find((n) => n.type === "mention");
  check(
    mentionAfter?.props?.userId === ids.owner && mentionAfter.props.id === mentionBefore.props?.id,
    "the mention keeps its identity",
    { before: mentionBefore, after: mentionAfter },
  );
  const quotes = await inDoc(spec.id, ids.owner, (doc) => [...threadQuotes(doc.getXmlFragment(COLLAB_FRAGMENT)).values()]);
  check(quotes.some((q) => q.includes("Last paragraph")), "the comment stays on its text", quotes);
  const versions = await db.select({ reason: pageSnapshot.reason, createdBy: pageSnapshot.createdBy }).from(pageSnapshot).where(eq(pageSnapshot.pageId, spec.id));
  check(
    versions.some((v) => v.reason === "before_markdown_edit" && v.createdBy === ids.editor),
    "the page was saved to its history before the write",
    versions,
  );
  const again = await readMarkdownSource(ids.editor, spec.id);
  check(again.losses.length === 0 && again.markdown.includes("A new paragraph."), "read again, the page still loses nothing", again.losses);

  // The page's own synced block is the editor's to change: a change there isn't warned of
  check(again.readOnlySynced.length === 0, "the page's own synced block isn't read-only to its editor", again.readOnlySynced);
  check(changedSyncedRegions(again.markdown, again.markdown.replace("Shared text", "Changed text"), again.readOnlySynced) === 0, "an edit inside its lines isn't a loss");

  // Writing through synced blocks: lines changed between a synced block's lines go to its blocks
  const fragmentText = () =>
    inDoc(spec.id, ids.owner, (doc) =>
      (serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(syncedFragmentName(syncId))) as unknown as Block[]).map(textOf).join("|"),
    );
  const stateOf = () => inDoc(spec.id, ids.owner, (doc) => Buffer.from(Y.encodeStateVector(doc)).toString("base64"));
  const throughSave = await saveMarkdownSource({ userId: ids.editor }, spec.id, again.markdown.replace("Shared text", "Shared text, edited"), again.version);
  check((await fragmentText()) === "Shared text, edited", "a save that changes a synced block's lines changes its blocks", await fragmentText());
  check(!throughSave.conflict && throughSave.version === (await service.pageVersion(spec.id)), "…and reports the version with them", throughSave);
  const reread = await readMarkdownSource(ids.editor, spec.id);
  check(reread.markdown.includes("Shared text, edited"), "…which the Markdown reads back", reread.markdown);

  // A page showing it (a reference): writes from there reach the original only for who may edit it
  const shower = await createPage(owner, { workspaceId, title: "Shower" });
  await setPagePermission(ids.owner, shower.id, ids.editor, "edit");
  await setPagePermission(ids.owner, shower.id, ids.viewer, "edit");
  await service.replaceContent(shower.id, `Shown here:\n\n<!-- leafdesk:synced-block ${spec.id} ${syncId} -->\n<!-- leafdesk:synced-block-end -->`, owner);
  check((await fragmentText()) === "Shared text, edited", "placing it with nothing between its lines leaves its blocks as they are", await fragmentText());
  const read = (await getPage({ userId: ids.editor, actor: { userId: ids.editor } }, { page_id: shower.id } as never)) as { markdown: string };
  check(read.markdown.includes("Shared text, edited"), "get_page shows the synced block's blocks", read.markdown);
  const stateBefore = await stateOf();
  const specVersions = async () => (await db.select({ id: pageSnapshot.id }).from(pageSnapshot).where(eq(pageSnapshot.pageId, spec.id))).length;
  const versionsBefore = await specVersions();
  await service.replaceContent(shower.id, read.markdown, { userId: ids.editor }, true, { syncedBlocks: true });
  check((await stateOf()) === stateBefore && (await specVersions()) === versionsBefore, "writing back what get_page read changes nothing on the original");
  await service.replaceContent(shower.id, read.markdown.replace("Shared text, edited", "Changed from the other page"), { userId: ids.editor }, true, { syncedBlocks: true });
  check((await fragmentText()) === "Changed from the other page", "a change made on a page showing it reaches the original", await fragmentText());
  const importState = await stateOf();
  await service.replaceContent(shower.id, read.markdown.replace("Shared text, edited", "From an old export"), { userId: ids.editor }, false, { wikilinks: false });
  check((await stateOf()) === importState, "a write that only places synced blocks (an import, a new page) changes nothing on the original");
  await service.replaceContent(shower.id, read.markdown, { userId: ids.editor });
  const mcpVersions = await db.select({ reason: pageSnapshot.reason, createdBy: pageSnapshot.createdBy }).from(pageSnapshot).where(eq(pageSnapshot.pageId, spec.id));
  check(mcpVersions.length === versionsBefore + 1 && mcpVersions.some((v) => v.reason === "before_mcp_write" && v.createdBy === ids.editor), "…saving the original to its history first", mcpVersions);
  const viewerRead = (await getPage({ userId: ids.viewer, actor: { userId: ids.viewer } }, { page_id: shower.id } as never)) as { markdown: string };
  const viewerState = await stateOf();
  await service.replaceContent(shower.id, viewerRead.markdown.replace("Changed from the other page", "Viewer's change"), { userId: ids.viewer }, true, { syncedBlocks: true });
  check((await stateOf()) === viewerState && (await fragmentText()) === "Changed from the other page", "someone who may only view the original changes nothing there");
  const viewerSource = await readMarkdownSource(ids.viewer, shower.id);
  const editorSource = await readMarkdownSource(ids.editor, shower.id);
  check(
    viewerSource.markdown.includes("Changed from the other page") && viewerSource.readOnlySynced.includes(`${spec.id}:${syncId}`) && editorSource.readOnlySynced.length === 0,
    "the Markdown source view shows a synced block from another page, read-only to who may only view the original",
    { viewer: viewerSource.readOnlySynced, editor: editorSource.readOnlySynced },
  );
  check(
    changedSyncedRegions(viewerSource.markdown, viewerSource.markdown.replace("Changed from the other page", "Mine"), viewerSource.readOnlySynced) === 1,
    "…so a change there is warned of",
  );
  await service.replaceContent(shower.id, read.markdown.replace("Shared text, edited", "Suggested"), { userId: ids.editor, asSuggestions: true }, true, { syncedBlocks: true });
  check((await fragmentText()) === "Changed from the other page", "a write made as suggestions leaves synced blocks alone");

  // A link in it to a page whose title changed reads with the new title, and writing that back is no change either
  await inDoc(spec.id, ids.owner, (doc) =>
    serverEditor.blocksToYXmlFragment(
      [{ type: "paragraph", content: [{ type: "text", text: "See ", styles: {} }, { type: "link", href: `/w/${workspaceId}/p/${shower.id}`, content: "an old title" }] }] as never,
      doc.getXmlFragment(syncedFragmentName(syncId)),
    ),
  );
  const labelled = (await getPage({ userId: ids.editor, actor: { userId: ids.editor } }, { page_id: shower.id } as never)) as { markdown: string };
  check(labelled.markdown.includes("[Shower]("), "get_page labels the link with the page's title", labelled.markdown);
  const labelledState = await stateOf();
  await service.replaceContent(shower.id, labelled.markdown, { userId: ids.editor }, true, { syncedBlocks: true });
  check((await stateOf()) === labelledState, "…and writing it back changes nothing on the original");

  // Tables keep their widths, header settings and cell colors through Markdown
  const tablePage = await createPage(owner, { workspaceId, title: "Table" });
  const cell = (text: string, props: Record<string, unknown> = {}) => ({ type: "tableCell", props, content: [{ type: "text", text, styles: {} }] });
  await service.transformBlocks(
    tablePage.id,
    () => [
      {
        type: "table",
        content: {
          type: "tableContent",
          columnWidths: [220, 90],
          headerRows: 1,
          rows: [
            { cells: [cell("Name"), cell("Score", { backgroundColor: "blue" })] },
            { cells: [cell("Ada"), cell("10", { textColor: "red", textAlignment: "right" })] },
          ],
        },
      },
    ],
    owner,
  );
  const tableSource = await readMarkdownSource(ids.owner, tablePage.id);
  check(!tableSource.losses.includes("table"), "a table's widths and colors aren't listed as lost", tableSource.losses);
  await service.replaceContent(tablePage.id, tableSource.markdown.replace("10", "12"), owner, true);
  const [tableBlock] = await bodyOf(tablePage.id);
  const content = tableBlock.content as { columnWidths: unknown[]; rows: { cells: { props: Record<string, unknown> }[] }[] };
  check(
    JSON.stringify(content.columnWidths) === "[220,90]" &&
      content.rows[0].cells[1].props.backgroundColor === "blue" &&
      content.rows[1].cells[1].props.textColor === "red" &&
      content.rows[1].cells[1].props.textAlignment === "right",
    "a table rewritten through Markdown keeps its widths, colors and alignment",
    content,
  );

  // Someone else types meanwhile: a conflict, and nothing is written
  const stale = await readMarkdownSource(ids.editor, spec.id);
  await inDoc(spec.id, ids.owner, (doc) => {
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    const blocks = serverEditor.yXmlFragmentToBlocks(fragment);
    serverEditor.blocksToYXmlFragment([...blocks, { type: "paragraph", content: "Typed by the owner" }] as never, fragment);
  });
  const mine = `${stale.markdown.replace("[^1]: The note.", "")}\n\nMy late change.\n\n[^1]: The note.`;
  const conflict = await saveMarkdownSource({ userId: ids.editor }, spec.id, mine, stale.version);
  check(conflict.conflict && conflict.version !== stale.version, "a save over someone else's edit is a conflict", conflict);
  const untouched = await bodyOf(spec.id);
  check(
    untouched.some((b) => textOf(b) === "Typed by the owner") && !untouched.some((b) => textOf(b) === "My late change."),
    "…that writes nothing and keeps their edit",
    untouched.map(textOf),
  );
  // Overwriting: the same save, expecting the version the conflict reported
  const overwrite = await saveMarkdownSource({ userId: ids.editor }, spec.id, mine, conflict.version);
  const overwritten = await bodyOf(spec.id);
  check(
    !overwrite.conflict && overwritten.some((b) => textOf(b) === "My late change.") && !overwritten.some((b) => textOf(b) === "Typed by the owner"),
    "saving again over it writes the Markdown",
    overwritten.map(textOf),
  );
  // An old version stays old: a save expecting it after the overwrite is a conflict again
  check((await saveMarkdownSource({ userId: ids.editor }, spec.id, "Gone", stale.version)).conflict, "a save expecting an old version stays refused");

  // What Markdown can't hold is listed
  const styled = await createPage(owner, { workspaceId, title: "Styled" });
  await service.transformBlocks(
    styled.id,
    () => [
      { type: "paragraph", props: { textColor: "red", textAlignment: "center" }, content: "Red and centered" },
      { type: "paragraph", content: [{ type: "text", text: "Underlined", styles: { underline: true } }] },
      { type: "paragraph", content: [{ type: "text", text: "Highlighted", styles: { backgroundColor: "yellow" } }] },
      { type: "image", props: { url: "https://example.com/a.png", previewWidth: 240 } },
    ],
    owner,
  );
  const lossy = await readMarkdownSource(ids.owner, styled.id);
  check(
    ["textColor", "backgroundColor", "alignment", "mediaSize", "textStyle"].every((kind) => lossy.losses.includes(kind as never)),
    "colors, alignment, image widths and underlines are listed as lost",
    lossy.losses,
  );

  // Who may read and save
  check((await failure(() => readMarkdownSource(ids.viewer, spec.id))) === "access", "a viewer can't read the page as Markdown to edit");
  check((await failure(() => saveMarkdownSource({ userId: ids.viewer }, spec.id, "Nope", conflict.version))) === "access", "…nor save it");
  check((await failure(() => readMarkdownSource(ids.owner, inline.id))) === "database", "a database has no Markdown body to edit");
  await setPageLocked(ids.owner, spec.id, true);
  const lockedVersion = await service.pageVersion(spec.id);
  check((await failure(() => saveMarkdownSource({ userId: ids.editor }, spec.id, "Locked", lockedVersion))) === "pageLocked", "a locked page refuses a save");
  await setPageLocked(ids.owner, spec.id, false);
  await archivePage(ids.owner, styled.id);
  check((await failure(() => readMarkdownSource(ids.owner, styled.id))) === "trashed", "a page in the trash can't be edited as Markdown");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(page).where(eq(page.workspaceId, workspaceId));
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await hocuspocus.closeConnections?.();
  process.exit(process.exitCode ?? 0);
}
