/**
 * End-to-end check that an export comes back as it went: a workspace (a page with a subpage and an
 * uploaded image, a database with rows, an untitled row and a row's subpage, a row template, a
 * workspace template with a subpage) is exported as a ZIP (server/export), the ZIP imported into
 * an empty workspace (server/import) and exported again, and the two archives compared. Also a page
 * export imported under a page, where the workspace's templates can't go.
 * Creates its own user and workspaces, stores files in a temporary directory, and deletes all of
 * it afterwards.
 *
 *   pnpm tsx scripts/roundtrip-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Readable } = await import("node:stream");
const { randomBytes } = await import("node:crypto");

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-roundtrip-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { strFromU8, unzipSync } = await import("fflate");
const { db } = await import("@/db");
const { file, fileReference, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { addProperty } = await import("@/server/databases");
const { createRowTemplate } = await import("@/server/templates");
const { uploadFile } = await import("@/server/files");
const { getStorage } = await import("@/server/storage");
const exporter = await import("@/server/export");
const { importPages } = await import("@/server/import/markdown");

const RUN = `roundtrip-e2e-${Date.now().toString(36)}`;

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

/** Waits for what the collab store hook makes true (it persists a little after the write). */
async function eventually(fn: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const ownerId = `${RUN}-owner`;
const owner = { userId: ownerId };
const source = `${RUN}-source`;
const target = `${RUN}-target`;

async function exportOf(scope: Parameters<typeof exporter.planExport>[1]) {
  const plan = await exporter.planExport(ownerId, scope);
  const data = new Uint8Array(await new Response(exporter.exportArchive(ownerId, plan)).arrayBuffer());
  const entries = unzipSync(data);
  return { data, entries, names: Object.keys(entries).sort(), text: (path: string) => (entries[path] ? strFromU8(entries[path]) : null) };
}

const pagesOf = (workspaceId: string) =>
  db
    .select({
      id: page.id,
      parentId: page.parentId,
      title: page.title,
      kind: page.kind,
      isTemplate: page.isTemplate,
      inTemplate: page.inTemplate,
      md: page.contentMarkdown,
    })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), isNull(page.archivedAt)));

/** Every page as "parent title > title [kind, template flags]", sorted: the tree without ids. */
async function treeOf(workspaceId: string, under: string | null = null) {
  const pages = await pagesOf(workspaceId);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const pathOf = (id: string | null): string => {
    if (!id || id === under) return "";
    const p = byId.get(id)!;
    return `${pathOf(p.parentId)}/${p.title || "(untitled)"}`;
  };
  const inside = (id: string | null): boolean => (under === null ? true : id === under || (id !== null && inside(byId.get(id)?.parentId ?? null)));
  return pages
    .filter((p) => p.id !== under && inside(p.parentId))
    .map((p) => `${pathOf(p.id)} [${p.kind}${p.isTemplate ? ", template" : ""}${p.inTemplate ? ", in template" : ""}]`)
    .sort();
}

/** Waits until every page's body is stored and every upload a body shows is recorded as shown. */
async function settled(workspaceId: string, bodies: Record<string, string>, shows: string[]) {
  await eventually(async () => {
    const pages = await pagesOf(workspaceId);
    return Object.entries(bodies).every(([title, text]) => pages.some((p) => p.title === title && p.md.includes(text)));
  }, "bodies");
  await eventually(async () => {
    const pages = await pagesOf(workspaceId);
    const refs = await db
      .select({ pageId: fileReference.pageId })
      .from(fileReference)
      .where(inArray(fileReference.pageId, pages.map((p) => p.id)));
    return shows.every((title) => refs.some((r) => pages.find((p) => p.id === r.pageId)?.title === title));
  }, "file references");
}

try {
  await db.insert(user).values({ id: ownerId, name: ownerId, email: `${ownerId}@example.test` });
  await db.insert(workspace).values([
    { id: source, name: `${RUN} source` },
    { id: target, name: `${RUN} target` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId: source, userId: ownerId, role: "owner" },
    { workspaceId: target, userId: ownerId, role: "owner" },
  ]);

  // The source workspace:
  //   Project                 shows photo.png, links to Plan
  //     Plan                  links back to Project
  //     Tasks (database)      Status, Tags, Points; rows "Write docs" (with a body and a subpage
  //                           "Draft"), "Ship", and an untitled one with a body
  //       Bug report          a row template, with a body
  //   Meeting                 a workspace template
  //     Agenda                …with a subpage
  const link = (id: string, text: string) => `[${text}](/w/${source}/p/${id})`;
  const project = await createPage(owner, { workspaceId: source, title: "Project" });
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), randomBytes(500)]);
  const photo = await uploadFile(ownerId, project.id, { name: "photo.png", contentType: "image/png", body: Readable.from([png]), declaredSize: png.length });
  const plan = await createPage(owner, { workspaceId: source, parentId: project.id, title: "Plan", markdown: `The plan, for ${link(project.id, "Project")}.` });
  await getCollab().replaceContent(project.id, `Start with ${link(plan.id, "Plan")}.\n\n![photo](${photo.url})\n\nThe end.`, owner);
  const tasks = await createPage(owner, { workspaceId: source, parentId: project.id, title: "Tasks", kind: "database" });
  const points = await addProperty(ownerId, tasks.id, { name: "Points", type: "number" });
  const docs = await createPage(owner, {
    workspaceId: source,
    parentId: tasks.id,
    title: "Write docs",
    properties: { Status: "Done", [points.id]: 3 },
    markdown: "Docs body.\n\n- a list the body starts after",
  });
  await createPage(owner, { workspaceId: source, parentId: docs.id, title: "Draft", markdown: "Draft text: E = mc<sup>2</sup> and H<sub>2</sub>O." });
  await createPage(owner, { workspaceId: source, parentId: tasks.id, title: "Ship", properties: { Status: "In progress" } });
  await createPage(owner, { workspaceId: source, parentId: tasks.id, title: "", properties: { [points.id]: 1 }, markdown: "Nameless body." });
  await createRowTemplate(owner, tasks.id, { title: "Bug report", markdown: "Steps to reproduce." });
  const meeting = await createPage(owner, { workspaceId: source, title: "Meeting", template: true, markdown: "Meeting notes." });
  await createPage(owner, { workspaceId: source, parentId: meeting.id, title: "Agenda", markdown: "Agenda items." });
  await settled(
    source,
    { Project: "The end.", Plan: "The plan", "Write docs": "Docs body", Draft: "Draft text", "": "Nameless body", "Bug report": "Steps", Meeting: "Meeting notes", Agenda: "Agenda items" },
    ["Project"],
  );

  // Export, import into an empty workspace at its top level, export again
  const first = await exportOf({ workspaceId: source });
  check(first.names.includes("Project/Tasks/Templates/Bug report.md") && first.names.includes("Templates/Meeting.md"), "the export keeps templates in Templates folders", first.names);
  check(first.text("Project/Tasks/Write docs.md")!.startsWith("# Write docs\n\n- Status: Done\n- Points: 3\n\nDocs body."), "a row's page starts with its properties", first.text("Project/Tasks/Write docs.md"));

  const result = await importPages(owner, { workspaceId: target, parentId: null, files: [{ path: "export.zip", data: first.data }] });
  check(
    JSON.stringify(result.created) === JSON.stringify({ pages: 4, databases: 1, rows: 3, templates: 2, files: 1 }),
    "the import counts pages, the database, its rows, the templates and the file",
    result.created,
  );
  check(JSON.stringify(result.pages.map((p) => p.title)) === JSON.stringify(["Project", "Meeting"]), "the imported pages list templates last", result.pages);
  check(result.warnings.length === 0, "…without warnings", result.warnings);

  const sourceTree = await treeOf(source);
  const targetTree = await treeOf(target);
  check(JSON.stringify(targetTree) === JSON.stringify(sourceTree), "the page tree comes back the same, template flags included", { sourceTree, targetTree });
  check(!targetTree.some((p) => p.includes("/Templates")), "no page named Templates stands in for the templates");

  const imported = await pagesOf(target);
  const one = (title: string) => imported.find((p) => p.title === title)!;
  const importedTasks = one("Tasks");
  check(imported.filter((p) => p.parentId === importedTasks.id && !p.isTemplate).length === 3, "the database has its three rows, no more");
  const bug = one("Bug report");
  check(bug.parentId === importedTasks.id && bug.isTemplate && bug.inTemplate, "the row template is a template of the imported database", bug);
  check(bug.md.includes("Steps to reproduce."), "…with its body", bug.md);
  const importedMeeting = one("Meeting");
  check(importedMeeting.parentId === null && importedMeeting.isTemplate, "the workspace template is one again");
  check(one("Agenda").inTemplate && one("Agenda").parentId === importedMeeting.id, "…and its subpage is part of it");

  const [sourceCsv, targetCsv] = [await exporter.databaseCsv(ownerId, tasks.id), await exporter.databaseCsv(ownerId, importedTasks.id)];
  check(targetCsv.csv === sourceCsv.csv, "the database's CSV comes back the same", { source: sourceCsv.csv, target: targetCsv.csv });

  const docsBody = await getCollab().readPage(one("Write docs").id);
  check(!docsBody.markdown.includes("Status:") && docsBody.markdown.startsWith("Docs body."), "a row's body leaves out the property list", docsBody.markdown);
  check(/^[*-] a list the body starts after$/m.test(docsBody.markdown), "…but keeps the list of its own", docsBody.markdown);
  const scripts = "Draft text: E = mc<sup>2</sup> and H<sub>2</sub>O.";
  const draftFile = first.names.find((name) => name.endsWith("/Draft.md"));
  check(draftFile && first.text(draftFile)!.includes(scripts), "superscript and subscript are exported as <sup> and <sub>", draftFile && first.text(draftFile));
  const draftBlocks = (await getCollab().readPage(one("Draft").id)).markdown;
  check(draftBlocks.includes(scripts), "…and imported as such", draftBlocks);
  const nameless = imported.find((p) => p.parentId === importedTasks.id && p.title === "")!;
  check((await getCollab().readPage(nameless.id)).markdown.includes("Nameless body."), "the untitled row's page goes to the untitled row");

  const [storedPhoto] = await db.select().from(file).where(eq(file.workspaceId, target));
  check(storedPhoto?.name === "photo.png", "the image is uploaded to the new workspace", storedPhoto);
  const stored = Buffer.from(await new Response(await getStorage().get(storedPhoto.storageKey)).arrayBuffer());
  check(stored.equals(png), "…byte for byte");
  const projectBody = (await getCollab().readPage(one("Project").id)).markdown;
  check(projectBody.includes(`/api/files/${storedPhoto.id}`) && projectBody.includes(`/w/${target}/p/${one("Plan").id}`), "the body shows the upload and links the imported Plan", projectBody);

  await settled(
    target,
    { Project: "The end.", Plan: "The plan", "Write docs": "Docs body", Draft: "Draft text", "": "Nameless body", "Bug report": "Steps", Meeting: "Meeting notes", Agenda: "Agenda items" },
    ["Project"],
  );
  const second = await exportOf({ workspaceId: target });
  check(JSON.stringify(second.names) === JSON.stringify(first.names), "exporting the import gives the same files", { first: first.names, second: second.names });
  const differing = first.names.filter((name) => !Buffer.from(first.entries[name]).equals(Buffer.from(second.entries[name])));
  check(
    differing.length === 0,
    "…with the same contents",
    differing.map((name) => ({ name, first: first.text(name), second: second.text(name) })),
  );

  // A page's export under a page: its row template still comes back; a workspace export's
  // templates can't be workspace templates there, so they're pages under a "Templates" page.
  const holder = await createPage(owner, { workspaceId: target, title: "Holder" });
  const pageExport = await exportOf({ pageId: project.id });
  const under = await importPages(owner, { workspaceId: target, parentId: holder.id, files: [{ path: "project.zip", data: pageExport.data }] });
  check(under.created.templates === 1 && under.created.rows === 3, "a page export keeps its row template under a page too", under.created);
  const underTree = await treeOf(target, holder.id);
  check(JSON.stringify(underTree) === JSON.stringify(sourceTree.filter((p) => p.startsWith("/Project"))), "…and its tree", underTree);
  const holder2 = await createPage(owner, { workspaceId: target, title: "Holder 2" });
  const nested = await importPages(owner, { workspaceId: target, parentId: holder2.id, files: [{ path: "export.zip", data: first.data }] });
  const nestedTree = await treeOf(target, holder2.id);
  check(nested.created.templates === 1 && nestedTree.includes("/Templates [page]") && nestedTree.includes("/Templates/Meeting/Agenda [page]"), "under a page, the workspace's templates are pages in a Templates page", nestedTree);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [source, target]));
  await db.delete(user).where(eq(user.id, ownerId));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
