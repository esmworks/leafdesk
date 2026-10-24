/**
 * End-to-end check of importing: Markdown files and ZIPs as a page tree (folders, index files,
 * Notion's layout and ids, databases from CSV files with their row pages, links between the files
 * as page links, images uploaded, an Obsidian vault's wikilinks, embeds, aliases and callouts), CSV files as new databases (guessed and chosen types) and into
 * existing ones (column mapping, new options, people and relations by name, cells that don't fit),
 * Excel workbooks (a database exported as one comes back with the same values), Word documents
 * (a page each, titled by their first heading, pictures uploaded), PDFs (a page of their text: headings
 * by size, paragraphs joined across lines and page breaks, lists, running headers and footers left
 * out, the PDF itself attached; a scan refused), Trello boards (a database on a
 * board view grouped by list, labels, members as people or text, dates, checklists, custom fields,
 * comments and card links in the rows' bodies, no assignment notifications), Asana projects (CSV
 * and JSON) and Monday.com boards (Excel) as databases on a board view (sections or groups, a
 * status, people by email or name, typed columns, sub-items and dependencies on both sides, links
 * between tasks, updates as comments, what was left out), access, limits,
 * taking back a failed import, and the /api/import route.
 * Creates its own users and workspaces, stores files in a temporary directory, and deletes all of
 * it afterwards.
 *
 *   pnpm tsx scripts/import-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { mkdtemp, readFile, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { randomBytes } = await import("node:crypto");

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-import-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;
process.env.UPLOAD_MAX_FILE_MB = String(10_000 / 1024 / 1024); // 10,000 bytes

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, desc, eq, inArray, isNull } = await import("drizzle-orm");
const { strToU8, unzipSync, zipSync } = await import("fflate");
const { db } = await import("@/db");
const { auditEvent, databaseView, file, notification, page, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { csvTable } = await import("@/lib/import/csv");
const { IMPORT_LIMITS } = await import("@/lib/import/markdown");
const { ImportError } = await import("@/lib/import/result");
const { pagePath } = await import("@/lib/mentions");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const databases = await import("@/server/databases");
const { AccessError } = await import("@/server/access");
const { importPages } = await import("@/server/import/markdown");
const { importDocx } = await import("@/server/import/docx");
const docxFixture = await import("@/server/import/docx-fixtures");
const { importPdf } = await import("@/server/import/pdf");
const { default: pdfmake } = await import("pdfmake");
const { importCsvAsDatabase, importCsvIntoDatabase } = await import("@/server/import/csv");
const { importTrello } = await import("@/server/import/trello");
const { importBoard } = await import("@/server/import/board");
const { readAsanaExport } = await import("@/lib/import/asana");
const { readMondayExport } = await import("@/lib/import/monday");
const boardFixtures = await import("@/lib/import/board-fixtures");
const { databaseCsv, databaseXlsx } = await import("@/server/export");
const importRoute = await import("@/app/api/import/route");

const RUN = `import-e2e-${Date.now().toString(36)}`;

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
    if (error instanceof ImportError) return error.code;
    throw error;
  }
}

/** Waits for a condition the collab store hook makes true (it persists after the write returns). */
async function eventually(fn: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ayse has the full name of a member of the Trello board.
const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider`, ayse: `${RUN}-ayse` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;

const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));
const children = async (parentId: string | null) =>
  db
    .select({ id: page.id, title: page.title, kind: page.kind })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), parentId ? eq(page.parentId, parentId) : isNull(page.parentId), isNull(page.archivedAt)))
    .orderBy(page.position);
const titles = async (parentId: string | null) => (await children(parentId)).map((c) => c.title);
const body = async (pageId: string) => (await getCollab().readPage(pageId)).markdown;
const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), randomBytes(200)]);
const NOTION = "0123456789abcdef0123456789abcdef";

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id === ids.ayse ? "Ayşe Yılmaz" : id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId, userId: ids.ayse, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  const owner = { userId: ids.owner };
  const home = await createPage(owner, { workspaceId, title: "Home" });

  // Markdown and ZIPs as pages
  const notionZip = zip({
    [`Export-${NOTION}/Project ${NOTION}.md`]: [
      "# Project",
      "",
      `See [the notes](Project%20${NOTION}/Notes.md), [tasks](Tasks%20${NOTION}.csv) and [the archive](Archive).`,
      "",
      `![diagram](Project%20${NOTION}/img/diagram.png)`,
      "",
      "![gone](img/gone.png)",
      "",
      "![too big](big.bin)",
    ].join("\n"),
    [`Export-${NOTION}/Project ${NOTION}/Notes.md`]: `# Notes\n\nBack to [the project](../Project%20${NOTION}.md). Same image: ![d](img/diagram.png)`,
    [`Export-${NOTION}/Project ${NOTION}/img/diagram.png`]: png,
    [`Export-${NOTION}/big.bin`]: randomBytes(12_000),
    [`Export-${NOTION}/Archive/index.md`]: "# Archive\n\nOld things.",
    [`Export-${NOTION}/Archive/Old.md`]: "---\ntitle: Very old\n---\nOld text",
    [`Export-${NOTION}/Tasks ${NOTION}.csv`]: "Name,Points,Due,Done,Tag\nWrite docs,3,2026-10-01,Yes,a\nShip,5,2026-10-02,No,a\n",
    [`Export-${NOTION}/Tasks ${NOTION}_all.csv`]: "Name,Points,Due,Done,Tag\nWrite docs,3,2026-10-01,Yes,a\nShip,5,2026-10-02,No,a\nReview,,2026-10-03,No,b\n",
    [`Export-${NOTION}/Tasks ${NOTION}/Write docs ${NOTION}.md`]: "# Write docs\n\nThe row's page.",
    [`Export-${NOTION}/Tasks ${NOTION}/Extra.md`]: "# Extra\n\nNot in the CSV.",
    [`Export-${NOTION}/Part-2.zip`]: zip({ "Second part.md": "From the inner ZIP" }),
    "__MACOSX/._junk.md": "junk",
  });
  const result = await importPages(owner, { workspaceId, parentId: home.id, files: [{ path: "export.zip", data: notionZip }] });
  check(
    JSON.stringify(result.pages.map((p) => `${p.kind}:${p.title}`)) ===
      JSON.stringify(["page:Archive", "page:Project", "page:Second part", "database:Tasks"]),
    "a ZIP's top-level files and folders become pages under the destination, the Export folder and system files left out",
    result.pages,
  );
  check(
    result.created.pages === 5 && result.created.databases === 1 && result.created.rows === 4 && result.created.files === 1,
    "…with counts of what was created (the image stored once for both pages that show it)",
    result.created,
  );
  const byTitle = async (parentId: string, title: string) => (await children(parentId)).find((c) => c.title === title)!;
  const project = await byTitle(home.id, "Project");
  const archive = await byTitle(home.id, "Archive");
  const tasks = await byTitle(home.id, "Tasks");
  check((await titles(project.id)).join() === "Notes", "a folder next to a file of the same name holds that page's subpages");
  check((await titles(archive.id)).join() === "Very old", "a folder without one becomes a page, titled from front matter inside");
  await eventually(async () => (await body(archive.id)).includes("Old things."), "the archive body");
  check(!(await body(archive.id)).includes("# Archive"), "…whose body is its index file, without the title heading");
  const notes = await byTitle(project.id, "Notes");
  await eventually(async () => (await body(project.id)).includes(pagePath(workspaceId, notes.id)), "the project body");
  const projectBody = await body(project.id);
  check(
    projectBody.includes(pagePath(workspaceId, notes.id)) &&
      projectBody.includes(pagePath(workspaceId, tasks.id)) &&
      projectBody.includes(pagePath(workspaceId, archive.id)),
    "links to other imported files (a page, a CSV, a folder) point at their pages",
    projectBody,
  );
  const stored = await db.select().from(file).where(eq(file.workspaceId, workspaceId));
  check(stored.length === 1 && stored[0].name === "diagram.png" && stored[0].pageId === project.id, "an image the page shows is uploaded to it", stored);
  check(projectBody.includes(`/api/files/${stored[0].id}`), "…and the image points at the upload", projectBody);
  check(projectBody.includes("img/gone.png") && projectBody.includes("big.bin"), "links to files that are missing or too large stay as they were");
  await eventually(async () => (await body(notes.id)).includes(`/api/files/${stored[0].id}`), "the notes body");
  check((await body(notes.id)).includes(pagePath(workspaceId, project.id)), "a link back up a folder works too");
  const warned = result.warnings.map((w) => `${w.code}:${"path" in w ? w.path : ""}:${"reason" in w ? w.reason : ""}`);
  check(
    warned.includes("missingFile:img/gone.png:") && warned.includes("fileNotStored:big.bin:tooLarge") && !warned.some((w) => w.endsWith(":duplicate")),
    "the result warns about the missing image and the file over the limit, not about Notion's duplicate CSV",
    result.warnings,
  );

  // The database from the CSV, with its rows' pages
  const tasksDb = await databases.getDatabase(ids.owner, tasks.id);
  const typeOf = Object.fromEntries(tasksDb.properties.map((p) => [p.name, p.type]));
  check(
    JSON.stringify(typeOf) === JSON.stringify({ Points: "number", Due: "date", Done: "checkbox", Tag: "select" }),
    "a CSV becomes a database with its column types guessed (the full _all file, no starter properties)",
    typeOf,
  );
  const rows = await databases.listRows(ids.owner, tasks.id);
  const prop = (name: string) => tasksDb.properties.find((p) => p.name === name)!;
  check(
    JSON.stringify(rows.map((r) => r.title)) === JSON.stringify(["Write docs", "Ship", "Review", "Extra"]),
    "each line is a row, and a page of the folder no line matches is added as one",
    rows.map((r) => r.title),
  );
  const docs = rows[0];
  check(
    docs.properties[prop("Points").id] === 3 && docs.properties[prop("Due").id] === "2026-10-01" && docs.properties[prop("Done").id] === true,
    "…with typed values",
    docs.properties,
  );
  await eventually(async () => (await body(docs.id)).includes("The row's page."), "the row body");
  check(true, "a page of the database's folder becomes the body of the row with its title");
  check((await titles(null)).join() === "Home", "nothing was created at the top level");

  // Loose files, with folder paths as a browser sends them
  const loose = await importPages(owner, {
    workspaceId,
    parentId: null,
    files: [
      { path: "Notes/a.md", data: strToU8("Links to [b](b.md)") },
      { path: "Notes/b.md", data: strToU8("# B title\nText") },
    ],
  });
  check(
    loose.pages.length === 1 && loose.pages[0].title === "Notes" && (await titles(loose.pages[0].id)).join() === "a,B title",
    "a picked folder imports at the top level as a page holding its files",
    loose.pages,
  );

  // An Obsidian vault: wikilinks and embeds by name, aliases, links by name, callouts
  const vaultZip = zip({
    "Vault/Welcome.md": [
      "---",
      "aliases: [Start here]",
      "tags: [home]",
      "---",
      "See [[Launch plan|the plan]], [[Ideas]] and [[Launch plan#Countdown]]. Gone: [[Missing mission]].",
      "",
      "![[photo.png]]",
      "",
      "![[Ideas]]",
      "",
      "> [!tip]- Folded",
      "> Callout text ^block-1",
      "",
      "Some ==marked== text %%a comment%%.",
      "",
      "Area grows with r ^2",
    ].join("\n"),
    "Vault/Projects/Launch plan.md": "Back to [[Start here]], [the welcome](Welcome.md) and [[Welcome#^block-1|its callout]].\n\n## Countdown\n\nT-10",
    "Vault/Notes/Ideas.md": "Ideas list",
    "Vault/Archive/Old/Ideas.md": "Old ideas",
    "Vault/attachments/photo.png": png,
    "Vault/.obsidian/workspace.json": "{}",
  });
  // A page outside the vault with the title of a link the vault can't resolve: the link still stays text.
  await createPage(owner, { workspaceId, title: "Missing mission" });
  const vault = await importPages(owner, { workspaceId, parentId: home.id, files: [{ path: "vault.zip", data: vaultZip }] });
  const vaultRoot = vault.pages.find((p) => p.title === "Vault")!;
  check(vault.pages.length === 1 && vaultRoot && vault.created.files === 1, "a vault's ZIP imports as its folders, the .obsidian folder left out", vault);
  const welcome = await byTitle(vaultRoot.id, "Welcome");
  const projects = await byTitle(vaultRoot.id, "Projects");
  const plan = await byTitle(projects.id, "Launch plan");
  const ideas = await byTitle((await byTitle(vaultRoot.id, "Notes")).id, "Ideas");
  await eventually(async () => (await body(welcome.id)).includes(pagePath(workspaceId, plan.id)), "the welcome body");
  const welcomeBody = await body(welcome.id);
  check(
    welcomeBody.includes(pagePath(workspaceId, plan.id)) && welcomeBody.includes(pagePath(workspaceId, ideas.id)),
    "wikilinks to notes in other folders point at their pages (the shortest path for a name two notes share)",
    welcomeBody,
  );
  check(
    welcomeBody.includes(`${pagePath(workspaceId, ideas.id)}) <!-- leafdesk:page-link -->`),
    "a note embedded on a line of its own becomes a link-to-page block",
    welcomeBody,
  );
  const photo = (await db.select().from(file).where(eq(file.pageId, welcome.id)))[0];
  check(photo?.name === "photo.png" && welcomeBody.includes(`/api/files/${photo.id}`), "an embedded image from the attachments folder is uploaded", welcomeBody);
  check(welcomeBody.includes("[[Missing mission]]"), "a wikilink naming nothing in the vault stays as written, even with a page of that title elsewhere", welcomeBody);
  check(
    vault.warnings.some((w) => w.code === "unresolvedLink" && w.target === "Missing mission" && w.page === "Welcome"),
    "…and is reported",
    vault.warnings,
  );
  check(
    /> \[!TIP\]/.test(welcomeBody) && !welcomeBody.includes("^block-1") && !welcomeBody.includes("a comment") && !welcomeBody.includes("=="),
    "callouts get the editor's kinds; block ids, comments and highlight marks are left out",
    welcomeBody,
  );
  check(welcomeBody.includes("r ^2"), "…but text ending in ^ and a word no link points at stays", welcomeBody);

  // A vault picked as a folder: the dialog doesn't send .obsidian, it says it was there.
  const folderNote = { path: "Picked vault/Note.md", data: new TextEncoder().encode("> [!info]- Heads up\n> Text") };
  const asVault = await importPages(owner, { workspaceId, parentId: home.id, files: [folderNote], vault: true });
  const asVaultNote = await byTitle(asVault.pages[0].id, "Note");
  await eventually(async () => (await body(asVaultNote.id)).includes("[!NOTE]"), "the folder vault's note");
  check((await body(asVaultNote.id)).includes("[!NOTE]"), "a vault picked as a folder (its .obsidian not sent) is read as a vault", await body(asVaultNote.id));
  check(!welcomeBody.includes("aliases") && !welcomeBody.includes("tags:"), "front matter isn't in the body", welcomeBody);
  await eventually(async () => (await body(plan.id)).includes(pagePath(workspaceId, welcome.id)), "the plan body");
  const planBody = await body(plan.id);
  check(
    planBody.split(pagePath(workspaceId, welcome.id)).length === 4,
    "an alias, a Markdown link by name (not a path from the file) and a link to a block all lead to the note",
    planBody,
  );

  // Plain Markdown (no wikilinks, no .obsidian folder) isn't read as a vault
  const plain = await importPages(owner, {
    workspaceId,
    parentId: home.id,
    files: [
      {
        path: "plain.zip",
        data: zip({
          "Plain/A.md": "Area is r ^2, 50%% off, a ==b== c.\n\n[By name](B.md), [broken path](img/logo.png)",
          "Plain/Sub/B.md": "B",
          "Plain/other/logo.png": png,
        }),
      },
    ],
  });
  const plainRoot = plain.pages.find((p) => p.title === "Plain")!;
  const plainA = await byTitle(plainRoot.id, "A");
  const plainB = await byTitle((await byTitle(plainRoot.id, "Sub")).id, "B");
  await eventually(async () => (await body(plainA.id)).includes("Area"), "the plain body");
  const plainBody = await body(plainA.id);
  check(plainBody.includes("r ^2") && plainBody.includes("50%% off") && plainBody.includes("==b=="), "outside a vault, ^, %% and == stay as written", plainBody);
  check(plainBody.includes(pagePath(workspaceId, plainB.id)), "…a bare file name still finds the note elsewhere in the upload", plainBody);
  check(
    plainBody.includes("img/logo.png") && plain.warnings.some((w) => w.code === "missingFile" && w.path === "Plain/img/logo.png"),
    "…but a broken path isn't taken for a file of the same name elsewhere",
    { plainBody, warnings: plain.warnings },
  );
  const settings = await importPages(owner, {
    workspaceId,
    parentId: home.id,
    files: [{ path: "v2.zip", data: zip({ "V2/Note.md": "Kept %%hidden%% text", "V2/.obsidian/app.json": "{}" }) }],
  });
  const v2Note = await byTitle(settings.pages[0].id, "Note");
  await eventually(async () => (await body(v2Note.id)).includes("Kept"), "the second vault's note");
  check(!(await body(v2Note.id)).includes("hidden"), "a ZIP with a .obsidian folder is a vault even without wikilinks");

  // Access
  await setPagePermission(ids.owner, home.id, ids.guest, "view");
  const md = [{ path: "x.md", data: strToU8("x") }];
  check((await failure(() => importPages({ userId: ids.guest }, { workspaceId, parentId: home.id, files: md }))) === "access", "viewing a page isn't enough to import into it");
  check((await failure(() => importPages({ userId: ids.outsider }, { workspaceId, parentId: null, files: md }))) === "access", "people outside the workspace can't import into it");
  check((await failure(() => importPages({ userId: ids.owner }, { workspaceId, parentId: tasks.id, files: md }))) === "badRequest", "pages go into pages, not databases");
  check(
    (await failure(() => importPages({ userId: ids.guest }, { workspaceId, parentId: null, files: md }))) === "access",
    "guests can't import at the top level unless the workspace lets them have private pages",
  );

  // Limits, and all or nothing
  const before = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  check((await failure(() => importPages(owner, { workspaceId, parentId: home.id, files: [{ path: "a.zip", data: strToU8("not a zip") }] }))) === "badZip", "a broken ZIP is refused");
  check((await failure(() => importPages(owner, { workspaceId, parentId: home.id, files: [{ path: "a.png", data: png }] }))) === "nothingToImport", "an upload without Markdown or CSV is refused");
  const pagesLimit = IMPORT_LIMITS.pages;
  IMPORT_LIMITS.pages = 2;
  check((await failure(() => importPages(owner, { workspaceId, parentId: home.id, files: ["a", "b", "c"].map((n) => ({ path: `${n}.md`, data: strToU8(n) })) }))) === "tooManyPages", "an import over the page limit is refused");
  IMPORT_LIMITS.pages = pagesLimit;
  const wide = `${Array.from({ length: 101 }, (_, i) => `c${i}`).join(",")}\n`;
  check(
    (await failure(() => importPages(owner, { workspaceId, parentId: home.id, files: [{ path: "a.md", data: strToU8("A") }, { path: "b/c.md", data: strToU8("C") }, { path: "zz.csv", data: strToU8(wide) }] }))) === "tooManyColumns",
    "a CSV over the column limit fails the import after other pages were made…",
  );
  const after = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  check(after === before, "…and they are taken back", { before, after });

  // CSV as a new database
  const table = csvTable("Title;Amount;When;Status;Site\nFirst;1,5;28.09.2026;Open;https://example.com\nSecond;n/a;29.09.2026;Closed;\nThird;3;;Open;\n");
  const created = await importCsvAsDatabase(owner, {
    workspaceId,
    parentId: home.id,
    title: "Imported",
    table,
    titleColumn: 0,
    types: [null, "number", "date", "select", null],
  });
  const importedDb = await databases.getDatabase(ids.owner, created.database.id);
  check(
    JSON.stringify(importedDb.properties.map((p) => `${p.name}:${p.type}`)) === JSON.stringify(["Amount:number", "When:date", "Status:select"]),
    "chosen types are used and left-out columns get no property",
    importedDb.properties.map((p) => `${p.name}:${p.type}`),
  );
  check(
    JSON.stringify(importedDb.properties[2].options.options?.map((o) => o.name)) === JSON.stringify(["Open", "Closed"]),
    "a select column gets its values as options",
  );
  const newRows = await databases.listRows(ids.owner, created.database.id);
  const [amount, when] = importedDb.properties;
  check(
    newRows.map((r) => r.properties[amount.id] ?? null).join() === "1.5,,3" && newRows[0].properties[when.id] === "2026-09-28",
    "values are read the way people write them (decimal comma, day-first dates)",
    newRows.map((r) => r.properties),
  );
  check(
    created.warnings.list.length === 1 && JSON.stringify(created.warnings.list[0]) === JSON.stringify({ code: "invalidValues", column: "Amount", count: 1 }),
    "a cell that isn't a number is left empty and counted",
    created.warnings.list,
  );

  // CSV into an existing database
  const target = await createPage(owner, { workspaceId, parentId: home.id, kind: "database", title: "Target" });
  const targetProps = (await databases.getDatabase(ids.owner, target.id)).properties;
  const status = targetProps.find((p) => p.type === "status")!;
  const tags = targetProps.find((p) => p.type === "multi_select")!;
  const who = await databases.addProperty(ids.owner, target.id, { name: "Who", type: "person" });
  const link = await databases.addProperty(ids.owner, target.id, { name: "Link", type: "relation", relation: { databaseId: tasks.id } });
  const mergeTable = csvTable(
    [
      "Task,State,Labels,Owner,Related,Ignored",
      `One,Done,"x, y",${ids.member}@example.test,Ship,zzz`,
      `Two,Blocked,y,nobody@example.test,Nope,zzz`,
    ].join("\n"),
  );
  const merged = await importCsvIntoDatabase(owner, {
    databaseId: target.id,
    table: mergeTable,
    mapping: ["title", status.id, tags.id, who.id, link.id, null],
  });
  const mergedRows = await databases.listRows(ids.owner, target.id);
  const after2 = await databases.getDatabase(ids.owner, target.id);
  const optionName = (propId: string, id: unknown) => after2.properties.find((p) => p.id === propId)!.options.options!.find((o) => o.id === id)?.name;
  check(merged.rows.length === 2 && mergedRows.map((r) => r.title).join() === "One,Two", "mapped rows are added with the title column as titles");
  check(
    optionName(status.id, mergedRows[0].properties[status.id]) === "Done" && optionName(status.id, mergedRows[1].properties[status.id]) === "Blocked",
    "existing options are matched and missing ones added (a new status option starts as to do)",
  );
  check(
    after2.properties.find((p) => p.id === status.id)!.options.options!.find((o) => o.name === "Blocked")?.group === "todo",
    "…in the to do group",
  );
  check(
    (mergedRows[0].properties[tags.id] as string[]).map((id) => optionName(tags.id, id)).join() === "x,y",
    "multi-select cells are split into options",
  );
  check(
    JSON.stringify(mergedRows[0].properties[who.id]) === JSON.stringify([ids.member]) &&
      JSON.stringify(mergedRows[0].properties[link.id]) === JSON.stringify([rows[1].id]),
    "people are found by email and related rows by title",
    mergedRows[0].properties,
  );
  check(
    !(who.id in mergedRows[1].properties) && !(link.id in mergedRows[1].properties) &&
      merged.warnings.list.some((w) => w.code === "invalidValues" && w.column === "Who") &&
      merged.warnings.list.some((w) => w.code === "invalidValues" && w.column === "Link"),
    "an unknown person or row leaves the cell empty and is reported",
    merged.warnings.list,
  );
  check((await failure(() => importCsvIntoDatabase(owner, { databaseId: target.id, table: mergeTable, mapping: ["title", "title"] }))) === "badMapping", "two columns can't go to one property");
  check((await failure(() => importCsvIntoDatabase(owner, { databaseId: target.id, table: mergeTable, mapping: [] }))) === "badMapping", "at least one column has to go somewhere");
  check((await failure(() => importCsvIntoDatabase(owner, { databaseId: home.id, table: mergeTable, mapping: ["title"] }))) === "notADatabase", "rows only go into databases");
  check((await failure(() => importCsvIntoDatabase({ userId: ids.guest }, { databaseId: target.id, table: mergeTable, mapping: ["title"] }))) === "access", "viewers can't add rows");
  const failing = csvTable("Task,Labels\nA,x\n");
  const beforeRows = (await databases.listRows(ids.owner, target.id)).length;
  check(
    (await failure(() => importCsvIntoDatabase(owner, { databaseId: target.id, table: failing, mapping: ["title", "no-such-property"] }))) === "badMapping" &&
      (await databases.listRows(ids.owner, target.id)).length === beforeRows,
    "an unknown property is refused before any row is added",
  );

  // Word documents: a page each
  const { docx, hyperlink, image, paragraph, PNG } = docxFixture;
  const report = docx({
    body: [
      paragraph("Quarterly report", { style: "Heading1" }),
      paragraph([hyperlink("rIdWeb", "The plan")]),
      paragraph("Section", { style: "Heading2" }),
      paragraph([image({ embed: "rIdSmall" }, "Chart")]),
      paragraph([image({ embed: "rIdBig" })]),
      paragraph([image({ link: "rIdOutside" })]),
      paragraph([image({ embed: "rIdMetafile" })]),
    ].join(""),
    relationships: [
      { id: "rIdWeb", type: "hyperlink", target: "https://example.com/plan", external: true },
      { id: "rIdSmall", type: "image", target: "media/small.png" },
      { id: "rIdBig", type: "image", target: "media/big.png" },
      { id: "rIdOutside", type: "image", target: "https://example.com/tracker.png", external: true },
      { id: "rIdMetafile", type: "image", target: "media/drawing.emf" },
    ],
    media: { "small.png": PNG, "big.png": Buffer.concat([png, randomBytes(12_000)]), "drawing.emf": randomBytes(100) },
  });
  const notesDocx = docx({ body: paragraph("Just some notes.") });
  const docsHome = await createPage(owner, { workspaceId, title: "Documents" });
  const fromWord = await importDocx(owner, {
    workspaceId,
    parentId: docsHome.id,
    files: [
      { name: "Report.docx", data: report },
      { name: "Plain notes.docx", data: notesDocx },
    ],
  });
  check(
    JSON.stringify(fromWord.pages.map((p) => `${p.kind}:${p.title}`)) === JSON.stringify(["page:Quarterly report", "page:Plain notes"]) &&
      (await titles(docsHome.id)).join() === "Quarterly report,Plain notes",
    "each Word document becomes a page, titled by the heading it starts with or else by its file name",
    fromWord.pages,
  );
  const reportId = fromWord.pages[0].id;
  const wordFiles = await db.select().from(file).where(eq(file.pageId, reportId));
  check(
    fromWord.created.pages === 2 && fromWord.created.files === 1 && wordFiles.length === 1 && wordFiles[0].name === "image-1.png" && wordFiles[0].contentType === "image/png",
    "…its picture uploaded to the page",
    { created: fromWord.created, wordFiles },
  );
  await eventually(async () => (await body(reportId)).includes("Section"), "the report body");
  const reportBody = await body(reportId);
  check(
    reportBody.includes(`/api/files/${wordFiles[0].id}`) && reportBody.includes("[The plan](https://example.com/plan)") && reportBody.includes("## Section") &&
      !reportBody.includes("# Quarterly report") && !reportBody.includes("example.com/tracker") && (reportBody.match(/!\[/g) ?? []).length === 1,
    "…with its links and headings, the title heading out of the body, and no picture but the uploaded one",
    reportBody,
  );
  await eventually(async () => (await body(fromWord.pages[1].id)).includes("Just some notes."), "the notes body");
  const wordWarned = fromWord.warnings.map((w) => `${w.code}:${"path" in w ? w.path : ""}:${"reason" in w ? w.reason : ""}`);
  check(
    JSON.stringify(wordWarned) ===
      JSON.stringify([
        "fileNotStored:Report.docx/image-2.png:tooLarge",
        "fileNotStored:Report.docx/image-3:external",
        "fileNotStored:Report.docx/image-4.emf:unsupportedType",
      ]),
    "pictures over the upload limit, linked from outside or of a type pages don't show are left out and reported",
    fromWord.warnings,
  );
  const [wordAudit] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.imported"), eq(auditEvent.actorUserId, ids.owner)))
    .orderBy(desc(auditEvent.createdAt))
    .limit(1);
  check(
    (wordAudit?.details as { format?: string; count?: number } | undefined)?.format === "docx" && (wordAudit?.details as { count?: number }).count === 2,
    "a Word import is recorded in the audit log",
    wordAudit,
  );
  const docsBefore = (await titles(docsHome.id)).length;
  check(
    (await failure(() =>
      importDocx(owner, { workspaceId, parentId: docsHome.id, files: [{ name: "Good.docx", data: notesDocx }, { name: "Broken.docx", data: report.slice(0, 300) }] }),
    )) === "badDocx" && (await titles(docsHome.id)).length === docsBefore,
    "a damaged document stops the import before any page is created",
  );
  check(
    (await failure(() => importDocx(owner, { workspaceId, parentId: docsHome.id, files: [{ name: "old.doc", data: notesDocx }] }))) === "badDocx",
    "only .docx files are taken",
  );
  check(
    (await failure(() => importDocx({ userId: ids.guest }, { workspaceId, parentId: docsHome.id, files: [{ name: "x.docx", data: notesDocx }] }))) === "access",
    "Word documents go only where the user may add pages",
  );

  // PDFs: a page of their text each (generated here with the standard Helvetica font, so they stay small)
  pdfmake.setFonts({ Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italics: "Helvetica-Oblique", bolditalics: "Helvetica-BoldOblique" } });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path) => /^Helvetica/.test(path));
  const makePdf = async (content: unknown[], furniture = false) =>
    new Uint8Array(
      await pdfmake
        .createPdf({
          defaultStyle: { font: "Helvetica", fontSize: 11 },
          ...(furniture
            ? {
                header: { text: "Acme Cooling — service report", fontSize: 9, margin: [40, 20, 40, 0] },
                footer: (current: number, count: number) => ({ text: `Page ${current} of ${count}`, alignment: "center", fontSize: 9 }),
              }
            : {}),
          content,
        } as never)
        .getBuffer(),
    );
  const sentence = "Cold rooms keep food fresh when their doors close well and their compressors run. ";
  const reportPdf = await makePdf(
    [
      { text: "Service report", fontSize: 24, margin: [0, 0, 0, 12] },
      { text: "We serviced every cold room this quarter, and this paragraph wraps over more than one line of the page before it ends." },
      { text: "What we found", fontSize: 16, margin: [0, 12, 0, 6] },
      { text: "• Two compressors needed new oil." },
      { text: "• One fan was replaced." },
      { text: "Next steps", fontSize: 16, margin: [0, 12, 0, 6] },
      { text: "1. Order the spare parts." },
      { text: "2. Book the second visit." },
      { text: `${sentence.repeat(150)}The end.`, margin: [0, 12, 0, 0] },
      { text: "Details", fontSize: 13, margin: [0, 12, 0, 6] },
      { text: "Last words." },
    ],
    true,
  );
  const scanPdf = await makePdf([{ canvas: [{ type: "rect", x: 0, y: 0, w: 300, h: 400, color: "#888888" }] }]);
  const memoPdf = await makePdf([{ text: "A short memo." }]);
  const pdfHome = await createPage(owner, { workspaceId, title: "PDFs" });
  const fromPdf = await importPdf(owner, { workspaceId, parentId: pdfHome.id, files: [{ name: "Service.pdf", data: reportPdf }, { name: "Memo notes.pdf", data: memoPdf }], attach: true });
  check(
    JSON.stringify(fromPdf.pages.map((p) => p.title)) === JSON.stringify(["Service report", "Memo notes"]) && fromPdf.created.pages === 2,
    "each PDF becomes a page, titled by the heading it starts with or else by its file name",
    fromPdf,
  );
  const memoId = fromPdf.pages[1].id;
  await eventually(async () => (await body(memoId)).includes("A short memo."), "the memo body");
  const memoBody = await body(memoId);
  const [storedPdf] = await db.select().from(file).where(eq(file.pageId, memoId));
  check(
    fromPdf.created.files === 1 && storedPdf?.name === "Memo notes.pdf" && storedPdf.contentType === "application/pdf" &&
      memoBody.includes(`/api/files/${storedPdf.id}`) && memoBody.indexOf(`/api/files/${storedPdf.id}`) > memoBody.indexOf("A short memo."),
    "…the PDF itself uploaded to it and shown at its end, after the text",
    { storedPdf, memoBody },
  );
  check(
    JSON.stringify(fromPdf.warnings) === JSON.stringify([{ code: "fileNotStored", path: "Service.pdf", reason: "tooLarge" }]) &&
      (await db.select().from(file).where(eq(file.pageId, fromPdf.pages[0].id))).length === 0,
    "…unless it is over the upload limit: then its page has the text only, and the import says so",
    fromPdf.warnings,
  );
  const pdfId = fromPdf.pages[0].id;
  await eventually(async () => (await body(pdfId)).includes("Last words."), "the PDF page body");
  const pdfBody = await body(pdfId);
  const paragraphs = pdfBody.split(/\n{2,}/);
  check(
    !pdfBody.includes("# Service report") && pdfBody.includes("## What we found") && pdfBody.includes("### Details") &&
      paragraphs.includes("We serviced every cold room this quarter, and this paragraph wraps over more than one line of the page before it ends."),
    "…with headings by font size, the title heading out of the body, and wrapped lines joined into one paragraph",
    pdfBody,
  );
  check(
    /^[-*] Two compressors needed new oil\.$/m.test(pdfBody) && /^[-*] One fan was replaced\.$/m.test(pdfBody) && /^1\. Order the spare parts\.$/m.test(pdfBody) && /^2\. Book the second visit\.$/m.test(pdfBody),
    "…bulleted and numbered lines as lists",
    pdfBody,
  );
  check(
    paragraphs.some((p) => p.startsWith("Cold rooms keep") && p.endsWith("The end.") && p.split("Cold rooms keep").length === 151) &&
      !pdfBody.includes("Acme Cooling") && !/Page \d of \d/.test(pdfBody),
    "…a paragraph running over a page break kept whole, running headers, footers and page numbers left out",
    pdfBody,
  );
  const [pdfAudit] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.imported"), eq(auditEvent.actorUserId, ids.owner)))
    .orderBy(desc(auditEvent.createdAt))
    .limit(1);
  check((pdfAudit?.details as { format?: string } | undefined)?.format === "pdf", "a PDF import is recorded in the audit log", pdfAudit);
  const unattached = await importPdf(owner, { workspaceId, parentId: pdfHome.id, files: [{ name: "Memo.pdf", data: memoPdf }] });
  check(
    unattached.created.files === 0 && (await db.select().from(file).where(eq(file.pageId, unattached.pages[0].id))).length === 0,
    "without attaching, the PDF itself isn't uploaded",
    unattached,
  );
  const pdfsBefore = (await titles(pdfHome.id)).length;
  check(
    (await failure(() => importPdf(owner, { workspaceId, parentId: pdfHome.id, files: [{ name: "Memo.pdf", data: memoPdf }, { name: "Scan.pdf", data: scanPdf }] }))) === "pdfNoText" &&
      (await titles(pdfHome.id)).length === pdfsBefore,
    "a scan without a text layer stops the import before any page is created",
  );
  check(
    (await failure(() => importPdf(owner, { workspaceId, parentId: pdfHome.id, files: [{ name: "Broken.pdf", data: reportPdf.slice(0, 400) }] }))) === "badPdf" &&
      (await failure(() => importPdf(owner, { workspaceId, parentId: pdfHome.id, files: [{ name: "memo.txt", data: memoPdf }] }))) === "badPdf",
    "a damaged PDF, or a file that isn't one, is refused",
  );
  check(
    (await failure(() => importPdf({ userId: ids.guest }, { workspaceId, parentId: pdfHome.id, files: [{ name: "x.pdf", data: memoPdf }] }))) === "access",
    "PDFs go only where the user may add pages",
  );

  // Trello boards: a database opening on a board view grouped by list
  const trelloBoard = JSON.parse(await readFile(new URL("../src/lib/import/trello-fixture.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const boardsHome = await createPage(owner, { workspaceId, title: "Boards" });
  const fromTrello = await importTrello(owner, { workspaceId, parentId: boardsHome.id, board: trelloBoard, timeZone: "Europe/Istanbul" });
  const boardId = fromTrello.pages[0].id;
  check(
    fromTrello.pages.length === 1 && fromTrello.pages[0].kind === "database" && fromTrello.pages[0].title === "Website relaunch" &&
      fromTrello.created.databases === 1 && fromTrello.created.rows === 5 && fromTrello.warnings.length === 0,
    "a Trello board becomes one database named after the board, a row per open card",
    fromTrello,
  );
  const boardDb = await databases.getDatabase(ids.owner, boardId);
  const boardProp = (name: string) => boardDb.properties.find((p) => p.name === name)!;
  const options = (name: string) => (boardProp(name).options.options ?? []).map((o) => `${o.name}:${o.color}`);
  check(
    JSON.stringify(boardDb.properties.map((p) => `${p.name}:${p.type}`)) ===
      JSON.stringify([
        "List:select",
        "Labels:multi_select",
        "Members:person",
        "Other members:text",
        "Dates:date",
        "Complete:checkbox",
        "Checklist:checklist",
        "Link:url",
        "Priority:select",
        "Estimate:number",
        "Sprint:text",
        "Reviewed:checkbox",
        "Launch:date",
      ]),
    "…with a property for the list, labels, members (people for a workspace member of the same name, text for the others), dates, checklist, link and each custom field",
    boardDb.properties.map((p) => `${p.name}:${p.type}`),
  );
  check(
    (boardProp("List").options.options ?? []).map((o) => o.name).join() === "Backlog,In progress,Review,Done",
    "the lists are options in board order, the archived list left out",
    options("List"),
  );
  check(
    JSON.stringify(options("Labels")) ===
      JSON.stringify(["Design:green", "Bug:red", "Backend:blue", "Yellow:yellow", "Frontend:blue", "Blocked:gray", "Purple:purple"]),
    "labels keep the colors closest to Trello's, color-only ones named after their color",
    options("Labels"),
  );
  check(JSON.stringify(options("Priority")) === JSON.stringify(["High:red", "Low:green"]), "a list custom field is a select with its options' colors", options("Priority"));
  const views = await db.select().from(databaseView).where(eq(databaseView.databaseId, boardId)).orderBy(databaseView.position);
  check(
    views.length === 2 && views[0].type === "board" && views[0].position === 0 && views[0].config.groupBy === boardProp("List").id && views[1].type === "table",
    "the database opens on a board view grouped by list, before its table",
    views.map((v) => ({ type: v.type, position: v.position, config: v.config })),
  );

  const boardRows = await databases.listRows(ids.owner, boardId);
  const card = (title: string) => boardRows.find((r) => r.title === title)!;
  const value = (title: string, name: string) => card(title).properties[boardProp(name).id];
  const optionOf = (name: string, id: unknown) => boardProp(name).options.options?.find((o) => o.id === id)?.name;
  check(
    JSON.stringify(boardRows.map((r) => r.title)) ===
      JSON.stringify(["Draft the new homepage copy", "Set up staging server", "Fix broken contact form", "Write release notes", "Ship v2"]),
    "rows follow the lists and the cards' order in them; archived cards and the cards of an archived list are left out",
    boardRows.map((r) => r.title),
  );
  check(
    boardRows.map((r) => optionOf("List", r.properties[boardProp("List").id])).join() === "Backlog,In progress,In progress,Review,Done",
    "each row has its card's list",
    boardRows.map((r) => r.properties),
  );
  check(
    (value("Ship v2", "Labels") as string[]).map((id) => optionOf("Labels", id)).join() === "Frontend,Blocked,Purple" &&
      (value("Fix broken contact form", "Labels") as string[]).map((id) => optionOf("Labels", id)).join() === "Bug",
    "…its labels, labels of the same name as one option",
    { ship: value("Ship v2", "Labels"), fix: value("Fix broken contact form", "Labels") },
  );
  check(
    JSON.stringify(value("Write release notes", "Members")) === JSON.stringify([ids.ayse]) &&
      value("Write release notes", "Other members") === "Bob Stone" &&
      value("Set up staging server", "Other members") === "Bob Stone" &&
      value("Set up staging server", "Members") === undefined,
    "a member whose name one person in the workspace has is that person; the others are text",
    { notes: card("Write release notes").properties, staging: card("Set up staging server").properties },
  );
  const assignments = await db
    .select()
    .from(notification)
    .where(and(eq(notification.userId, ids.ayse), eq(notification.kind, "assignment")));
  check(assignments.length === 0, "imported assignments notify nobody", assignments);
  check(
    value("Fix broken contact form", "Dates") === "2026-10-20T07:00:00.000Z/2026-10-24T15:00:00.000Z" &&
      value("Draft the new homepage copy", "Dates") === "2026-11-03T09:00:00.000Z" &&
      value("Set up staging server", "Complete") === true &&
      value("Draft the new homepage copy", "Complete") === undefined,
    "start and due dates are a range (the due date alone otherwise), a completed due date checks Complete",
    { fix: value("Fix broken contact form", "Dates"), draft: value("Draft the new homepage copy", "Dates") },
  );
  const checklist = (title: string) => (value(title, "Checklist") as { text: string; checked: boolean }[]).map((i) => `${i.checked ? "x" : " "} ${i.text}`);
  check(
    JSON.stringify(checklist("Draft the new homepage copy")) === JSON.stringify(["x Collect old copy", "  Write first draft", "  Review with marketing"]) &&
      JSON.stringify(checklist("Fix broken contact form")) === JSON.stringify(["x Deploy: Point the form at the new endpoint", "  QA: Test on mobile"]),
    "checklists are one checklist, items named after their checklist when a card has several",
    { draft: value("Draft the new homepage copy", "Checklist"), fix: value("Fix broken contact form", "Checklist") },
  );
  check(
    value("Draft the new homepage copy", "Link") === "https://www.figma.com/file/abc123/Homepage" &&
      value("Set up staging server", "Link") === "https://docs.example.com/runbooks/staging",
    "the first linked attachment is the Link",
  );
  check(
    value("Set up staging server", "Estimate") === 5 &&
      value("Set up staging server", "Sprint") === "S42" &&
      value("Set up staging server", "Reviewed") === true &&
      value("Set up staging server", "Launch") === "2026-11-15T09:00:00.000Z" &&
      optionOf("Priority", value("Set up staging server", "Priority")) === "Low" &&
      optionOf("Priority", value("Fix broken contact form", "Priority")) === "High",
    "custom fields keep their values",
    card("Set up staging server").properties,
  );

  const draftPath = pagePath(workspaceId, card("Draft the new homepage copy").id);
  const fixId = card("Fix broken contact form").id;
  await eventually(async () => (await body(fixId)).includes("Bob Stone"), "the contact form card's body");
  const fixBody = await body(fixId);
  // A link to a page is stored as a mention of it, shown with the page's title.
  check(
    fixBody.slice(0, fixBody.indexOf("### Comments")).includes(`](${draftPath})`) && !fixBody.includes("trello.com/c/"),
    "a link to another card leads to its row",
    fixBody,
  );
  check(
    fixBody.includes("### Comments") &&
      fixBody.indexOf("**Ayşe Yılmaz** · 2026-10-15 00:45") > 0 &&
      fixBody.indexOf("**Ayşe Yılmaz** · 2026-10-15 00:45") < fixBody.indexOf("**Bob Stone** · 2026-10-16 17:02") &&
      fixBody.includes(`(${draftPath})`, fixBody.indexOf("**Bob Stone**")),
    "comments follow the description under their author and time (the importer's time zone), oldest first, card addresses in them leading to rows",
    fixBody,
  );
  const draftId = card("Draft the new homepage copy").id;
  await eventually(async () => (await body(draftId)).includes("Wireframe"), "the homepage card's body");
  const draftBody = await body(draftId);
  check(
    draftBody.includes("Tone: friendly") &&
      draftBody.includes("[Wireframe](https://trello.com/1/cards/") &&
      !draftBody.includes("![") &&
      draftBody.includes("### Attachments") &&
      draftBody.includes("wireframe.png") &&
      (await db.select().from(file).where(eq(file.pageId, draftId))).length === 0,
    "a card's description is its row's body, images and uploads left as links (nothing downloaded)",
    draftBody,
  );
  const [trelloAudit] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.imported"), eq(auditEvent.targetId, boardId)));
  check(
    (trelloAudit?.details as { format?: string; count?: number } | undefined)?.format === "trello" && (trelloAudit?.details as { count?: number }).count === 6,
    "a Trello import is recorded in the audit log",
    trelloAudit,
  );

  // A guest can't look people up: every member is text.
  await setPagePermission(ids.owner, boardsHome.id, ids.guest, "edit");
  const guestBoard = await importTrello({ userId: ids.guest }, { workspaceId, parentId: boardsHome.id, title: "Guest copy", board: trelloBoard });
  const guestDb = await databases.getDatabase(ids.guest, guestBoard.pages[0].id);
  const guestMembers = guestDb.properties.find((p) => p.name === "Members");
  const guestNotes = (await databases.listRows(ids.guest, guestBoard.pages[0].id)).find((r) => r.title === "Write release notes")!;
  check(
    guestBoard.pages[0].title === "Guest copy" &&
      !guestDb.properties.some((p) => p.type === "person") &&
      guestMembers?.type === "text" &&
      guestNotes.properties[guestMembers.id] === "Ayşe Yılmaz, Bob Stone",
    "a guest's import (named as asked) writes every member as text",
    { properties: guestDb.properties.map((p) => `${p.name}:${p.type}`), notes: guestNotes.properties },
  );

  // A failure midway takes the database back with its rows.
  const pagesBefore = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  const replaceContent = service.replaceContent;
  service.replaceContent = async () => {
    throw new Error("writing a body failed");
  };
  let midway: unknown = null;
  try {
    await importTrello(owner, { workspaceId, parentId: boardsHome.id, title: "Doomed", board: trelloBoard });
  } catch (error) {
    midway = error;
  } finally {
    service.replaceContent = replaceContent;
  }
  const pagesAfter = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  check(
    midway instanceof Error && midway.message === "writing a body failed" && pagesAfter === pagesBefore && !(await titles(boardsHome.id)).includes("Doomed"),
    "a Trello import failing after its rows were written takes the database back",
    { midway: String(midway), pagesBefore, pagesAfter },
  );

  // Asana projects: a database opening on a board view grouped by section
  const asanaCsv = boardFixtures.ASANA_CSV.replaceAll(boardFixtures.AYSE_EMAIL, `${ids.ayse}@example.test`);
  const asanaBoard = readAsanaExport("Website_launch.csv", strToU8(asanaCsv));
  const fromAsana = await importBoard(owner, { workspaceId, parentId: boardsHome.id, board: asanaBoard, timeZone: "Europe/Istanbul" });
  const asanaId = fromAsana.pages[0].id;
  const asanaWarnings = fromAsana.warnings.map((w) => `${w.code}:${"column" in w ? w.column : ""}:${"count" in w ? w.count : ""}`);
  check(
    fromAsana.pages[0].title === "Website launch" && fromAsana.created.rows === 6 &&
      JSON.stringify(asanaWarnings) ===
        JSON.stringify([
          "invalidValues:Parent task:1",
          "invalidValues:Blocked By (Dependencies):1",
          "leftOutColumn:Created At:",
          "leftOutColumn:Last Modified:",
          "leftOutColumn:Projects:",
        ]),
    "an Asana project's CSV becomes a database named after the project, a row per task, with what was left out listed",
    fromAsana,
  );
  const asanaDb = await databases.getDatabase(ids.owner, asanaId);
  const asanaProp = (name: string) => asanaDb.properties.find((p) => p.name === name)!;
  check(
    JSON.stringify(asanaDb.properties.map((p) => `${p.name}:${p.type}`)) ===
      JSON.stringify([
        "Section:select",
        "Status:status",
        "Dates:date",
        "Assignee:person",
        "Assignee (others):text",
        "Tags:multi_select",
        "Priority:select",
        "Estimate:number",
        "Launch day:date",
        "Budget link:url",
        "Parent item:relation",
        "Sub-items:relation",
        "Blocked by:relation",
        "Blocking:relation",
      ]),
    "…with a property for the section, completion, dates, assignee (people by email, text for the others), tags, each custom field, sub-items and dependencies",
    asanaDb.properties.map((p) => `${p.name}:${p.type}`),
  );
  check(
    (asanaProp("Section").options.options ?? []).map((o) => o.name).join() === "To do,In progress,Done" &&
      (asanaProp("Status").options.options ?? []).map((o) => `${o.name}:${o.group}`).join() === "To do:todo,Done:done",
    "sections are options in the order they appear; the status is to do or done",
  );
  const asanaViews = await db.select().from(databaseView).where(eq(databaseView.databaseId, asanaId)).orderBy(databaseView.position);
  check(asanaViews[0]?.type === "board" && asanaViews[0].config.groupBy === asanaProp("Section").id, "…opening on a board view grouped by section", asanaViews);
  const asanaRows = await databases.listRows(ids.owner, asanaId);
  const task = (title: string) => asanaRows.find((r) => r.title === title)!;
  const taskValue = (title: string, name: string) => task(title).properties[asanaProp(name).id];
  const taskOption = (name: string, id: unknown) => asanaProp(name).options.options?.find((o) => o.id === id)?.name;
  check(
    taskOption("Status", taskValue("Design the mockups", "Status")) === "Done" &&
      taskOption("Status", taskValue("Launch", "Status")) === "To do" &&
      taskOption("Section", taskValue("Write the press release", "Section")) === "Done" &&
      taskValue("Write the homepage copy", "Dates") === "2026-10-01/2026-10-05" &&
      (taskValue("Write the homepage copy", "Tags") as string[]).map((id) => taskOption("Tags", id)).join() === "Content,Marketing" &&
      taskValue("Launch", "Estimate") === 8 &&
      taskValue("Write the homepage copy", "Budget link") === "https://docs.example.com/copy",
    "tasks keep their completion, section (a subtask its parent's), dates as a range, tags and custom fields",
    asanaRows.map((r) => [r.title, r.properties]),
  );
  check(
    JSON.stringify(taskValue("Write the homepage copy", "Assignee")) === JSON.stringify([ids.ayse]) &&
      JSON.stringify(taskValue("Write the press release", "Assignee")) === JSON.stringify([ids.ayse]) &&
      taskValue("Proofread the copy", "Assignee (others)") === "Bob Stone" &&
      taskValue("Proofread the copy", "Assignee") === undefined,
    "an assignee is the member with their email address (or, without one, their name); the others are text",
  );
  const linkedTitles = (title: string, name: string) => ((taskValue(title, name) as string[] | undefined) ?? []).map((id) => asanaRows.find((r) => r.id === id)?.title).join();
  check(
    linkedTitles("Write the press release", "Parent item") === "Launch" &&
      linkedTitles("Launch", "Sub-items") === "Write the press release" &&
      linkedTitles("Launch", "Blocked by") === "Write the homepage copy,Design the mockups" &&
      linkedTitles("Proofread the copy", "Blocked by") === "Write the homepage copy" &&
      linkedTitles("Write the homepage copy", "Blocking") === "Proofread the copy,Launch" &&
      asanaProp("Parent item").options.relation?.role === "parent" &&
      asanaProp("Blocked by").options.relation?.role === "blocked_by",
    "subtasks are sub-items and dependencies are the database's dependencies, both sides linked",
    asanaRows.map((r) => [r.title, r.properties]),
  );
  const homepageCopyId = task("Write the homepage copy").id;
  await eventually(async () => (await body(homepageCopyId)).includes("Draft the copy."), "the copy task's body");
  check(
    (await body(homepageCopyId)).includes(pagePath(workspaceId, task("Design the mockups").id)) && !(await body(homepageCopyId)).includes("app.asana.com"),
    "a task's notes are its row's body, links to other tasks leading to their rows",
    await body(homepageCopyId),
  );
  check(
    (await db.select().from(notification).where(and(eq(notification.userId, ids.ayse), eq(notification.kind, "assignment")))).length === 0,
    "imported assignees are not notified",
  );
  const [asanaAudit] = await db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "page.imported"), eq(auditEvent.targetId, asanaId)));
  check((asanaAudit?.details as { format?: string } | undefined)?.format === "asana", "an Asana import is recorded in the audit log", asanaAudit);

  // The JSON export: nested subtasks, typed custom fields with colors, comments.
  const fromAsanaJson = await importBoard(owner, {
    workspaceId,
    parentId: boardsHome.id,
    board: readAsanaExport("offsite.json", strToU8(JSON.stringify(boardFixtures.ASANA_JSON).replaceAll(boardFixtures.AYSE_EMAIL, `${ids.ayse}@example.test`))),
    timeZone: "Europe/Istanbul",
  });
  const offsiteDb = await databases.getDatabase(ids.owner, fromAsanaJson.pages[0].id);
  const offsiteRows = await databases.listRows(ids.owner, fromAsanaJson.pages[0].id);
  const offsiteProp = (name: string) => offsiteDb.properties.find((p) => p.name === name)!;
  const offsitePlan = offsiteRows.find((r) => r.title === "Plan the offsite")!;
  await eventually(async () => (await body(offsitePlan.id)).includes("Booked the venue."), "the offsite task's body");
  const offsiteBody = await body(offsitePlan.id);
  check(
    fromAsanaJson.pages[0].title === "Team offsite" &&
      fromAsanaJson.created.rows === 3 &&
      JSON.stringify((offsiteProp("Priority").options.options ?? []).map((o) => `${o.name}:${o.color}`)) === JSON.stringify(["High:red", "Low:green"]) &&
      offsitePlan.properties[offsiteProp("Cost").id] === 1250.5 &&
      offsiteBody.indexOf("**Ayşe Yılmaz** · 2026-09-02 12:15") > 0 &&
      offsiteBody.indexOf("**Ayşe Yılmaz**") < offsiteBody.indexOf("**Bob Stone**") &&
      offsiteBody.includes("venue.pdf") &&
      offsiteBody.includes(pagePath(workspaceId, offsiteRows.find((r) => r.title === "Write the agenda")!.id)),
    "an Asana JSON export keeps its fields' types and colors, its comments under their author and time, and attachments as links",
    { properties: offsiteDb.properties.map((p) => `${p.name}:${p.type}`), offsiteBody },
  );

  // Monday.com boards: groups, columns by kind, subitems, updates
  const mondayBytes = boardFixtures.workbookOf([
    { name: "Marketing board", rows: boardFixtures.MONDAY_BOARD.map((row) => row.map((v) => (v === boardFixtures.AYSE_EMAIL ? `${ids.ayse}@example.test` : v))) },
    { name: "Updates", rows: boardFixtures.MONDAY_UPDATES },
    { name: "Chart data", rows: [["Status", "Count"]] },
  ]);
  const fromMonday = await importBoard(owner, { workspaceId, parentId: boardsHome.id, board: readMondayExport("Marketing.xlsx", mondayBytes), timeZone: "Europe/Istanbul" });
  const mondayId = fromMonday.pages[0].id;
  const mondayWarnings = fromMonday.warnings.map((w) => `${w.code}:${"column" in w ? w.column : "path" in w ? w.path : ""}`);
  check(
    fromMonday.pages[0].title === "Marketing board" &&
      fromMonday.created.rows === 7 &&
      JSON.stringify(mondayWarnings) === JSON.stringify(["invalidValues:Dependency", "invalidValues:Item Name", "skipped:Chart data"]),
    "a Monday.com board becomes a database named after the board, a row per item and subitem, with what was left out listed",
    fromMonday,
  );
  const mondayDb = await databases.getDatabase(ids.owner, mondayId);
  const mondayProp = (name: string) => mondayDb.properties.find((p) => p.name === name)!;
  check(
    JSON.stringify(mondayDb.properties.map((p) => `${p.name}:${p.type}`)) ===
      JSON.stringify([
        "Group:select",
        "Owner:person",
        "Owner (others):text",
        "Status:status",
        "Due date:date",
        "Timeline:date",
        "Budget:number",
        "Tags:multi_select",
        "Brief:url",
        "Contact:email",
        "Phone:phone",
        "Approved:checkbox",
        "Notes:text",
        "Location:place",
        "Date:date",
        "Parent item:relation",
        "Sub-items:relation",
        "Blocked by:relation",
        "Blocking:relation",
      ]),
    "…with a property per column of the kind its name and values suggest",
    mondayDb.properties.map((p) => `${p.name}:${p.type}`),
  );
  const mondayRows = await databases.listRows(ids.owner, mondayId);
  const mItem = (title: string) => mondayRows.find((r) => r.title === title)!;
  const mValue = (title: string, name: string) => mItem(title).properties[mondayProp(name).id];
  const mOption = (name: string, id: unknown) => mondayProp(name).options.options?.find((o) => o.id === id);
  check(
    mOption("Status", mValue("Launch campaign", "Status"))?.group === "in_progress" &&
      mOption("Status", mValue("Write brief", "Status"))?.group === "done" &&
      mOption("Group", mValue("Book ads", "Group"))?.name === "This week" &&
      mValue("Launch campaign", "Timeline") === "2026-10-01/2026-10-15" &&
      mValue("Launch campaign", "Budget") === 1200 &&
      mValue("Launch campaign", "Brief") === "https://docs.example.com/brief" &&
      mValue("Launch campaign", "Approved") === true &&
      mValue("Launch campaign", "Phone") === "+90 555 111 2233" &&
      JSON.stringify(mValue("Launch campaign", "Owner")) === JSON.stringify([ids.ayse]) &&
      JSON.stringify(mValue("Plan event", "Owner")) === JSON.stringify([ids.ayse]) &&
      mValue("Plan event", "Owner (others)") === "Bob Stone" &&
      mValue("Write brief", "Date") === "2026-10-05" &&
      (mValue("Launch campaign", "Location") as { address?: string; lat?: number })?.address === "Galata Tower, Istanbul" &&
      (mValue("Launch campaign", "Location") as { lat?: number }).lat === 41.0256,
    "items keep their group, status (options grouped by their labels), timeline as a range, numbers, links, checkboxes, places with their coordinates and people by name",
    mondayRows.map((r) => [r.title, r.properties]),
  );
  const mIds = (title: string, name: string) => ((mValue(title, name) as string[] | undefined) ?? []).map((id) => mondayRows.find((r) => r.id === id)?.title).join();
  check(
    mIds("Launch campaign", "Sub-items") === "Write brief,Book ads" && mIds("Collect feedback", "Parent item") === "Retro" && mIds("Launch campaign", "Blocked by") === "Plan event",
    "subitems are sub-items and the Dependency column the database's dependencies",
  );
  const launchId = mItem("Launch campaign").id;
  await eventually(async () => (await body(launchId)).includes("The brief is ready."), "the campaign's body");
  const launchBody = await body(launchId);
  check(
    launchBody.indexOf("**Bob Stone** · 2026-10-01 11:00") > 0 &&
      launchBody.indexOf("**Bob Stone**") < launchBody.indexOf("**Ayşe Yılmaz**") &&
      launchBody.includes(pagePath(workspaceId, mItem("Plan event").id)),
    "updates are comments in the row's body, oldest first, links to items leading to their rows",
    launchBody,
  );

  // Columns the importer chose otherwise, a guest's import, a failure midway.
  const chosen = await importBoard(owner, {
    workspaceId,
    parentId: boardsHome.id,
    title: "Chosen",
    board: asanaBoard,
    types: ["person", "multi_select", "text", null, "date", "url"],
  });
  const chosenDb = await databases.getDatabase(ids.owner, chosen.pages[0].id);
  check(
    chosenDb.properties.find((p) => p.name === "Priority")?.type === "text" && !chosenDb.properties.some((p) => p.name === "Estimate"),
    "a column becomes the type the importer picked, or is left out",
    chosenDb.properties.map((p) => `${p.name}:${p.type}`),
  );
  const guestAsana = await importBoard({ userId: ids.guest }, { workspaceId, parentId: boardsHome.id, title: "Guest tasks", board: asanaBoard });
  const guestAsanaDb = await databases.getDatabase(ids.guest, guestAsana.pages[0].id);
  check(
    !guestAsanaDb.properties.some((p) => p.type === "person") && guestAsanaDb.properties.find((p) => p.name === "Assignee")?.type === "text",
    "a guest's import writes every assignee as text",
    guestAsanaDb.properties.map((p) => `${p.name}:${p.type}`),
  );
  const beforeBoard = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  const keepContent = service.replaceContent;
  service.replaceContent = async () => {
    throw new Error("writing a body failed");
  };
  let boardFailure: unknown = null;
  try {
    await importBoard(owner, { workspaceId, parentId: boardsHome.id, title: "Doomed board", board: asanaBoard });
  } catch (error) {
    boardFailure = error;
  } finally {
    service.replaceContent = keepContent;
  }
  const afterBoard = (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  check(boardFailure instanceof Error && afterBoard === beforeBoard, "a board import failing midway takes the database back", { beforeBoard, afterBoard });

  // The route
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${RUN}-session`, token, userId: ids.member, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
  const post = async (fields: Record<string, string>, files: { name: string; data: Uint8Array | string; path?: string }[], headers: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) {
      form.append("file", new Blob([typeof f.data === "string" ? f.data : Buffer.from(f.data)]), f.name);
      form.append("path", f.path ?? f.name);
    }
    const request = new Request("http://localhost:3000/api/import", { method: "POST", body: form, headers: { cookie, "x-leafdesk-import": "1", ...headers } });
    const bodyBytes = await request.arrayBuffer();
    const sized = new Request(request.url, {
      method: "POST",
      body: bodyBytes,
      headers: { ...Object.fromEntries(request.headers), "content-length": String(bodyBytes.byteLength) },
    });
    const response = await importRoute.POST(sized);
    return { status: response.status, json: await response.json() };
  };
  const viaRoute = await post({ mode: "pages", workspaceId, parentId: home.id }, [
    { name: "a.md", path: "Folder/a.md", data: "# Via route\n\nHello" },
  ]);
  check(viaRoute.status === 201 && viaRoute.json.pages[0].title === "Folder" && viaRoute.json.created.pages === 2, "the route imports pages with their folder paths", viaRoute);
  const csvRoute = await post(
    { mode: "csv-new", workspaceId, parentId: home.id, titleColumn: "0", types: JSON.stringify([null, "number"]) },
    [{ name: "Scores.csv", data: "Name,Score\nA,1\nB,2\n" }],
  );
  check(csvRoute.status === 201 && csvRoute.json.pages[0].title === "Scores" && csvRoute.json.created.rows === 2, "…a CSV as a new database named after the file", csvRoute);
  const mergeRoute = await post(
    { mode: "csv-merge", databaseId: csvRoute.json.pages[0].id, mapping: JSON.stringify(["title", null]) },
    [{ name: "more.csv", data: "Name,Other\nC,x\n" }],
  );
  check(mergeRoute.status === 201 && mergeRoute.json.created.rows === 1, "…and rows into a database", mergeRoute);
  check((await post({ mode: "pages", workspaceId, parentId: home.id }, md.map(() => ({ name: "x.md", data: "x" })), { "x-leafdesk-import": "" })).status === 403, "the route needs its header");
  check((await post({ mode: "pages", workspaceId, parentId: home.id }, [{ name: "x.md", data: "x" }], { origin: "https://evil.example" })).status === 403, "…and refuses foreign origins");
  const noAccess = await post({ mode: "pages", workspaceId: otherWorkspace, parentId: "" }, [{ name: "x.md", data: "x" }]);
  check(noAccess.status === 404 && noAccess.json.code === "noAccess", "workspaces the user isn't in read as missing", noAccess);
  const wordRoute = await post({ mode: "docx", workspaceId, parentId: home.id }, [{ name: "Memo.docx", data: notesDocx }]);
  check(wordRoute.status === 201 && wordRoute.json.pages[0].title === "Memo" && wordRoute.json.created.pages === 1, "…Word documents as pages", wordRoute);
  const brokenWord = await post({ mode: "docx", workspaceId, parentId: home.id }, [{ name: "Broken.docx", data: "not a document" }]);
  check(
    brokenWord.status === 400 && brokenWord.json.code === "badDocx" && brokenWord.json.params.name === "Broken.docx",
    "…and refuses a damaged one with a code the dialog translates",
    brokenWord,
  );
  const pdfRoute = await post({ mode: "pdf", workspaceId, parentId: home.id, attach: "1" }, [{ name: "Memo.pdf", data: memoPdf }]);
  check(pdfRoute.status === 201 && pdfRoute.json.pages[0].title === "Memo" && pdfRoute.json.created.files === 1, "…PDFs as pages, attached when asked", pdfRoute);
  const scanRoute = await post({ mode: "pdf", workspaceId, parentId: home.id }, [{ name: "Scan.pdf", data: scanPdf }]);
  check(
    scanRoute.status === 400 && scanRoute.json.code === "pdfNoText" && scanRoute.json.params.name === "Scan.pdf",
    "…and refuses a scan with a code the dialog translates",
    scanRoute,
  );
  const empty = await post({ mode: "csv-new", workspaceId, parentId: home.id }, [{ name: "e.csv", data: "" }]);
  check(empty.status === 400 && empty.json.code === "emptyCsv", "an empty CSV is refused with a code the dialog translates", empty);

  // Excel workbooks: a database exported as one and imported again has the same values
  const source = await post({ mode: "csv-new", workspaceId, parentId: home.id, titleColumn: "0" }, [
    {
      name: "Typed.csv",
      data: 'Name,Points,Done,Due,Status,Notes\nWrite docs,3.5,yes,2026-09-28,Open,"two\nlines"\nShip,-2,no,,Closed,=not a formula\nPlan,1000000,yes,2026-10-01,Open,\n',
    },
  ]);
  check(source.status === 201 && source.json.created.rows === 3, "a database to export as a workbook", source);
  const sourceId = source.json.pages[0].id as string;
  const workbook = await databaseXlsx(ids.member, sourceId);
  check(workbook.title === "Typed" && workbook.xlsx[0] === 0x50 && workbook.xlsx[1] === 0x4b, "the database exports as a workbook (a ZIP)", workbook.title);
  const sheetXml = new TextDecoder().decode(unzipSync(workbook.xlsx)["xl/worksheets/sheet1.xml"]);
  check(
    sheetXml.includes('<c r="B2"><v>3.5</v></c>') && sheetXml.includes('<c r="C2" t="b"><v>1</v></c>') && /<c r="D2" s="2"><v>46293<\/v><\/c>/.test(sheetXml),
    "…with numbers, checkboxes and dates as typed cells",
    sheetXml,
  );
  const fromXlsx = await post({ mode: "csv-new", workspaceId, parentId: home.id, titleColumn: "0" }, [{ name: "Typed copy.xlsx", data: workbook.xlsx }]);
  check(fromXlsx.status === 201 && fromXlsx.json.pages[0].title === "Typed copy" && fromXlsx.json.created.rows === 3, "the workbook imports as a new database", fromXlsx);
  const copyId = fromXlsx.json.pages[0].id as string;
  const copyTypes = (await databases.getDatabase(ids.member, copyId)).properties.map((p) => `${p.name}:${p.type}`);
  check(
    JSON.stringify(copyTypes) === JSON.stringify(["Points:number", "Done:checkbox", "Due:date", "Status:select", "Notes:text"]),
    "…its columns typed as the original's",
    copyTypes,
  );
  const [sourceCsv, copyCsv] = [await databaseCsv(ids.member, sourceId), await databaseCsv(ids.member, copyId)];
  check(copyCsv.csv === sourceCsv.csv, "…with the same values", { source: sourceCsv.csv, copy: copyCsv.csv });
  const mergeXlsx = await post({ mode: "csv-merge", databaseId: copyId, mapping: JSON.stringify(["title", null, null, null, null, null]), sheet: "0" }, [
    { name: "more.xlsx", data: workbook.xlsx },
  ]);
  check(mergeXlsx.status === 201 && mergeXlsx.json.created.rows === 3 && mergeXlsx.json.warnings.length === 0, "a workbook's rows go into a database too", mergeXlsx);
  const oldXls = await post({ mode: "csv-new", workspaceId, parentId: home.id }, [
    { name: "old.xls", data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]) },
  ]);
  check(oldXls.status === 400 && oldXls.json.code === "unsupportedWorkbook", "an old .xls (or a password-protected workbook) is refused with its own code", oldXls);
  const brokenXlsx = await post({ mode: "csv-new", workspaceId, parentId: home.id }, [{ name: "broken.xlsx", data: workbook.xlsx.slice(0, 200) }]);
  check(brokenXlsx.status === 400 && brokenXlsx.json.code === "badWorkbook", "…and a workbook that can't be read with another", brokenXlsx);

  // Trello boards through the route
  const trelloRoute = await post({ mode: "trello", workspaceId, parentId: home.id }, [{ name: "board.json", data: JSON.stringify(trelloBoard) }]);
  check(
    trelloRoute.status === 201 && trelloRoute.json.pages[0].title === "Website relaunch" && trelloRoute.json.created.databases === 1 && trelloRoute.json.created.rows === 5,
    "the route imports a Trello export as a database named after the board",
    trelloRoute,
  );
  const routeViews = await db.select().from(databaseView).where(eq(databaseView.databaseId, trelloRoute.json.pages[0].id)).orderBy(databaseView.position);
  check(routeViews[0]?.type === "board", "…opening on its board view", routeViews);
  const namedRoute = await post({ mode: "trello", workspaceId, parentId: home.id, title: "Relaunch" }, [{ name: "board.json", data: JSON.stringify(trelloBoard) }]);
  check(namedRoute.status === 201 && namedRoute.json.pages[0].title === "Relaunch", "…or under the name it is given", namedRoute);
  const notTrello = await post({ mode: "trello", workspaceId, parentId: home.id }, [{ name: "pages.json", data: '{"pages": []}' }]);
  check(notTrello.status === 400 && notTrello.json.code === "badTrello", "other JSON is refused with a code the dialog translates", notTrello);

  // Asana and Monday.com through the route
  const asanaRoute = await post({ mode: "asana", workspaceId, parentId: home.id, types: JSON.stringify(["person", "multi_select", "text", null, "date", "url"]) }, [
    { name: "Website_launch.csv", data: asanaCsv },
  ]);
  check(
    asanaRoute.status === 201 && asanaRoute.json.pages[0].title === "Website launch" && asanaRoute.json.created.rows === 6 &&
      !(await databases.getDatabase(ids.member, asanaRoute.json.pages[0].id)).properties.some((p) => p.name === "Estimate"),
    "the route imports an Asana export with the column types it is given",
    asanaRoute,
  );
  const mondayRoute = await post({ mode: "monday", workspaceId, parentId: home.id, title: "Campaigns" }, [{ name: "Marketing.xlsx", data: mondayBytes }]);
  check(mondayRoute.status === 201 && mondayRoute.json.pages[0].title === "Campaigns" && mondayRoute.json.created.rows === 7, "…and a Monday.com board", mondayRoute);
  const notAsana = await post({ mode: "asana", workspaceId, parentId: home.id }, [{ name: "x.csv", data: "Name,Points\nA,1\n" }]);
  const notMonday = await post({ mode: "monday", workspaceId, parentId: home.id }, [{ name: "x.xlsx", data: workbook.xlsx }]);
  check(
    notAsana.status === 400 && notAsana.json.code === "badAsana" && notMonday.status === 400 && notMonday.json.code === "badMonday",
    "other files are refused with codes the dialog translates",
    { notAsana, notMonday },
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
