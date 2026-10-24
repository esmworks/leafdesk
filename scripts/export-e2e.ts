/**
 * End-to-end check of ZIP exports: a page with its subpages and a whole workspace as Markdown,
 * database CSVs and the uploaded files they show; the folder layout; links rewritten into the
 * archive; only what the exporting user can view (hidden subpages, pages shared on their own,
 * guests, owners-only workspace export); link mentions as links and cropped images whole; the trash
 * and templates; limits, one export at a time, and streaming. With EXPORT_E2E_URL pointing at a
 * running server, also the export routes over HTTP.
 * Creates its own users, workspace and files, and deletes all of it afterwards.
 *
 *   pnpm tsx scripts/export-e2e.ts
 *   EXPORT_E2E_URL=http://localhost:3900 pnpm tsx scripts/export-e2e.ts    # with the HTTP checks
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be
 * applied. Files go to the storage the environment picks (the same the server uses), and are
 * removed from it afterwards.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { Readable } = await import("node:stream");
const { randomBytes } = await import("node:crypto");
const { unzipSync, strFromU8 } = await import("fflate");

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, fileReference, page, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage } = await import("@/server/pages");
const { addProperty, updateRowProperties } = await import("@/server/databases");
const { setPagePermission } = await import("@/server/permissions");
const { createRowTemplate } = await import("@/server/templates");
const { AccessError } = await import("@/server/access");
const files = await import("@/server/files");
const { instanceStorage } = await import("@/server/storage");
const exporter = await import("@/server/export");

const RUN = `export-e2e-${Date.now().toString(36)}`;

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
    if (error instanceof exporter.ExportError) return error.code;
    throw error;
  }
}

/** Waits for what the collab store hook makes true (it persists a little after the write). */
async function eventually(fn: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const bytes = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const upload = (userId: string, pageId: string, name: string, body: Buffer, contentType?: string) =>
  files.uploadFile(userId, pageId, { name, contentType, body: Readable.from([body]), declaredSize: body.length });

/** Reads an archive stream the way a browser would, and unpacks it. */
async function unpack(stream: ReadableStream<Uint8Array>) {
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  const entries = unzipSync(data);
  const text = (path: string) => (entries[path] ? strFromU8(entries[path]) : null);
  return { entries, names: Object.keys(entries).sort(), text, size: data.length };
}

async function exportOf(userId: string, scope: Parameters<typeof exporter.planExport>[1]) {
  const plan = await exporter.planExport(userId, scope);
  return { plan, ...(await unpack(exporter.exportArchive(userId, plan))) };
}

const ids = {
  owner: `${RUN}-owner`,
  member: `${RUN}-member`,
  guest: `${RUN}-guest`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const link = (pageId: string, text = "x") => `[${text}](/w/${workspaceId}/p/${pageId})`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: "Acme: Docs" },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  const owner = { userId: ids.owner };

  // A small workspace:
  //   Project                 links to Plan, Secret, Elsewhere; shows photo.png
  //     Plan                  shows photo.png and notes.txt, links back to Project
  //     Notes, notes          two pages whose names clash
  //     Secret                only the owner can see it
  //       Shared bit          shared with the member on its own
  //     Tasks (database)      Status, Attachments; rows "Write docs" (with a subpage) and "Ship"
  //       Bug report          a row template
  //     Old stuff             in the trash, with its subpage
  //   Elsewhere               outside Project
  //   Meeting                 a workspace template
  const project = await createPage(owner, { workspaceId, title: "Project" });
  const photo = await upload(ids.owner, project.id, "photo.png", Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), bytes(2000)]), "image/png");
  const notesFile = await upload(ids.owner, project.id, "notes.txt", Buffer.from("plain notes\n".repeat(50)), "text/plain");
  const plan = await createPage(owner, {
    workspaceId,
    parentId: project.id,
    title: "Plan",
    markdown: `![photo](/api/files/${photo.id})\n\n[notes.txt](${env.appUrl}/api/files/${notesFile.id})\n\nBack to ${link(project.id)}.`,
  });
  const notes1 = await createPage(owner, { workspaceId, parentId: project.id, title: "Notes" });
  const notes2 = await createPage(owner, { workspaceId, parentId: project.id, title: "notes" });
  const secret = await createPage(owner, { workspaceId, parentId: project.id, title: "Secret" });
  const sharedBit = await createPage(owner, { workspaceId, parentId: secret.id, title: "Shared bit" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  await setPagePermission(ids.owner, sharedBit.id, ids.member, "view");
  const tasks = await createPage(owner, { workspaceId, parentId: project.id, title: "Tasks", kind: "database" });
  const attachments = await addProperty(ids.owner, tasks.id, { name: "Attachments", type: "files" });
  const docsRow = await createPage(owner, { workspaceId, parentId: tasks.id, title: "Write docs", properties: { Status: "Done" } });
  const shipRow = await createPage(owner, { workspaceId, parentId: tasks.id, title: "Ship", properties: { Status: "In progress" } });
  const rowFile = await upload(ids.owner, docsRow.id, "spec.pdf", Buffer.from("%PDF-1.4\n%fake"), "application/pdf");
  await updateRowProperties(ids.owner, docsRow.id, { [attachments.id]: [rowFile.url] });
  const draft = await createPage(owner, { workspaceId, parentId: docsRow.id, title: "Draft", markdown: `Draft of ${link(docsRow.id)}` });
  const bugTemplate = await createRowTemplate(owner, tasks.id, { title: "Bug report" });
  const oldStuff = await createPage(owner, { workspaceId, parentId: project.id, title: "Old stuff" });
  const oldChild = await createPage(owner, { workspaceId, parentId: oldStuff.id, title: "Old child" });
  await archivePage(ids.owner, oldStuff.id);
  const elsewhere = await createPage(owner, { workspaceId, title: "Elsewhere" });
  const meeting = await createPage(owner, { workspaceId, title: "Meeting", template: true });
  await getCollab().replaceContent(
    project.id,
    `See ${link(plan.id)}, ${link(secret.id)} and ${link(elsewhere.id)}.\n\n![](/api/files/${photo.id})\n\n\`\`\`\n${link(plan.id)}\n\`\`\``,
    owner,
  );
  // A link shown as a mention and a cropped image: Markdown has the link and the whole image.
  await getCollab().appendBlocks(
    project.id,
    [
      { type: "paragraph", content: [{ type: "mention", props: { kind: "link", url: "https://example.com/guide", title: "The guide", siteName: "Example" } }] },
      { type: "image", props: { url: `/api/files/${photo.id}`, name: "cropped", crop: JSON.stringify({ x: 0.5, y: 0, w: 0.5, h: 0.5, ar: 2 }) } },
    ],
    owner,
  );
  await eventually(async () => {
    const [row] = await db.select({ md: page.contentMarkdown }).from(page).where(eq(page.id, project.id));
    return Boolean(row?.md.includes("The guide"));
  }, "the project's appended blocks");
  // The store hook records which files each body shows; exports go by that.
  const shown = async (pageId: string, fileId: string) =>
    (await db.select().from(fileReference).where(and(eq(fileReference.pageId, pageId), eq(fileReference.fileId, fileId)))).length > 0;
  await eventually(async () => (await shown(project.id, photo.id)) && (await shown(plan.id, notesFile.id)), "file references");
  await eventually(async () => {
    const [row] = await db.select({ md: page.contentMarkdown }).from(page).where(eq(page.id, draft.id));
    return Boolean(row?.md.includes("/p/"));
  }, "the draft's body");

  // The owner exports Project with its subpages
  const own = await exportOf(ids.owner, { pageId: project.id });
  check(
    JSON.stringify(own.names) ===
      JSON.stringify(
        [
          "Project.md",
          "Project/Plan.md",
          "Project/Notes.md",
          "Project/notes (2).md",
          "Project/Secret.md",
          "Project/Secret/Shared bit.md",
          "Project/Tasks.csv",
          "Project/Tasks/Write docs.md",
          "Project/Tasks/Write docs/Draft.md",
          "Project/Tasks/Ship.md",
          "Project/Tasks/Templates/Bug report.md",
          "files/photo.png",
          "files/notes.txt",
          "files/spec.pdf",
        ].sort(),
      ),
    "the archive mirrors the page tree: folders beside pages, databases as CSV with their rows, files apart",
    own.names,
  );
  check(!own.names.some((n) => n.includes("Old")), "pages in the trash are left out");
  check(!own.names.some((n) => n.includes("Elsewhere") || n.includes("Meeting")), "pages outside the page stay out");
  check(own.plan.title === "Project" && own.plan.pages.length === 11 && own.plan.files.length === 3, "the plan counts pages and files", {
    title: own.plan.title,
    pages: own.plan.pages.length,
    files: own.plan.files.length,
  });

  const projectMd = own.text("Project.md")!;
  check(projectMd.startsWith("# Project\n\n"), "a page starts with its title", projectMd);
  check(projectMd.includes("[Plan](Project/Plan.md)") && projectMd.includes("[Secret](Project/Secret.md)"), "links to exported pages point into the archive", projectMd);
  check(projectMd.includes(`[Elsewhere](${env.appUrl}/w/${workspaceId}/p/${elsewhere.id})`), "links to pages left out point at the app", projectMd);
  check(projectMd.includes("](files/photo.png)"), "uploaded images point at their copy", projectMd);
  check(projectMd.includes("[The guide](https://example.com/guide)"), "a link shown as a mention exports as a link with its title", projectMd);
  check(projectMd.includes("![cropped](files/photo.png)"), "…and a cropped image as the whole image", projectMd);
  check(projectMd.includes(`\n[x](/w/${workspaceId}/p/${plan.id})\n\`\`\``), "fenced code is left alone", projectMd);
  const planMd = own.text("Project/Plan.md")!;
  check(planMd.includes("](../files/photo.png)") && planMd.includes("](../files/notes.txt)"), "…from nested folders too, absolute app URLs included", planMd);
  check(planMd.includes("[Project](../Project.md)"), "links back up the tree are relative", planMd);
  check(Buffer.from(own.entries["files/photo.png"]).equals(await storedBytes(photo.id)), "files are copied byte for byte");
  check(own.text("files/notes.txt") === "plain notes\n".repeat(50), "…text files too (deflated)");

  const csv = own.text("Project/Tasks.csv")!;
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  check(lines[0] === "Name,Status,Tags,Attachments", "the database CSV has a column per property", lines);
  check(lines.includes("Write docs,Done,,spec.pdf (../files/spec.pdf)") && lines.includes("Ship,In progress,,"), "rows as CSV, their files as paths in the archive", lines);
  check(!csv.includes("Bug report"), "row templates aren't rows");
  const docsMd = own.text("Project/Tasks/Write docs.md")!;
  check(
    docsMd.startsWith("# Write docs\n\n- Status: Done\n- Attachments: [spec.pdf](../../files/spec.pdf)\n"),
    "a row page lists its properties under its title",
    docsMd,
  );
  check(own.text("Project/Tasks/Write docs/Draft.md")!.includes("[Write docs](../Write%20docs.md)"), "links are URL-safe", own.text("Project/Tasks/Write docs/Draft.md"));

  // What the member sees
  const mine = await exportOf(ids.member, { pageId: project.id });
  check(!mine.names.some((n) => n.startsWith("Project/Secret")), "a subpage the user can't see stays out, with what's under it", mine.names);
  check(mine.names.includes("Shared bit.md"), "a page shared on its own (under one they can't see) goes to the top, like the sidebar", mine.names);
  const memberProject = mine.text("Project.md")!;
  check(!memberProject.includes("Secret") && memberProject.includes(`[No access](${env.appUrl}/w/${workspaceId}/p/${secret.id})`), "links to hidden pages say No access and name nothing", memberProject);
  check((await failure(() => exporter.planExport(ids.member, { workspaceId }))) === "access", "only owners export the whole workspace");
  check((await failure(() => exporter.planExport(ids.outsider, { pageId: project.id }))) === "access", "people outside the workspace can't export its pages");

  // A guest with one page
  await setPagePermission(ids.owner, plan.id, ids.guest, "view");
  check((await failure(() => exporter.planExport(ids.guest, { pageId: project.id }))) === "access", "guests can't export pages they can't see");
  const guest = await exportOf(ids.guest, { pageId: plan.id });
  check(JSON.stringify(guest.names) === JSON.stringify(["Plan.md", "files/notes.txt", "files/photo.png"]), "…and export what is shared with them", guest.names);
  check(guest.text("Plan.md")!.includes(`[No access](${env.appUrl}/w/${workspaceId}/p/${project.id})`), "…with links to the rest labelled No access", guest.text("Plan.md"));

  // A database exported on its own
  const table = await exportOf(ids.owner, { pageId: tasks.id });
  check(table.names.includes("Tasks.csv") && table.names.includes("Tasks/Ship.md") && table.names.includes("files/spec.pdf"), "a database exports with its row pages and files", table.names);

  // From the trash
  const trashed = await exportOf(ids.owner, { pageId: oldStuff.id });
  check(JSON.stringify(trashed.names) === JSON.stringify(["Old stuff.md", "Old stuff/Old child.md"]), "a page in the trash exports with what went to the trash with it", trashed.names);
  void oldChild;

  // The whole workspace
  const all = await exportOf(ids.owner, { workspaceId });
  check(all.plan.title === "Acme: Docs", "the workspace export is named after the workspace", all.plan.title);
  check(
    all.names.includes("Project.md") && all.names.includes("Elsewhere.md") && all.names.includes("Templates/Meeting.md") && all.names.includes("Project/Tasks/Templates/Bug report.md"),
    "the workspace export holds every page, with templates kept apart",
    all.names,
  );
  check(all.text("Project.md")!.includes("[Elsewhere](Elsewhere.md)"), "…and links between its pages point into the archive");
  check(!all.names.some((n) => n.includes("Old")), "…without the trash");
  void meeting;
  void bugTemplate;
  void notes1;
  void notes2;
  void shipRow;

  // Limits
  process.env.EXPORT_MAX_PAGES = "5";
  check((await failure(() => exporter.planExport(ids.owner, { pageId: project.id }))) === "tooManyPages", "too many pages is refused before anything is sent");
  delete process.env.EXPORT_MAX_PAGES;
  process.env.EXPORT_MAX_FILES_MB = String(1000 / 1024 / 1024);
  const tooLarge = await exporter.planExport(ids.owner, { pageId: project.id }).catch((e: unknown) => e);
  check(tooLarge instanceof exporter.ExportError && tooLarge.code === "tooLarge" && tooLarge.limit === 1000, "so are files adding up to more than the limit", String(tooLarge));
  delete process.env.EXPORT_MAX_FILES_MB;

  // One export at a time per person; streaming
  const release = exporter.startExport(ids.owner);
  check((await failure(async () => exporter.startExport(ids.owner))) === "busy", "a second export by the same person waits for the first");
  check(exporter.exportRunning(ids.owner), "…which a dry run can tell");
  const other = exporter.startExport(ids.member);
  other();
  release();
  release();
  check(!exporter.exportRunning(ids.owner), "the slot comes back when the export is done");

  let done = 0;
  const stream = exporter.exportArchive(ids.owner, await exporter.planExport(ids.owner, { workspaceId }), { onDone: () => done++ });
  const reader = stream.getReader();
  const first = await reader.read();
  check(!first.done && first.value.length > 0 && first.value[0] === 0x50 && first.value[1] === 0x4b, "the archive starts streaming before it is complete");
  await reader.cancel();
  check(done === 1, "a download the client stops frees its slot");

  // Over HTTP, when a server is running
  const base = (process.env.EXPORT_E2E_URL ?? "").replace(/\/$/, "");
  const up = base ? await fetch(`${base}/api/auth/ok`).then(() => true, () => false) : false;
  if (!up) {
    console.log("\n(skipped the HTTP checks: set EXPORT_E2E_URL to a running server)");
  } else {
    const cookieFor = async (userId: string) => {
      const token = randomBytes(24).toString("hex");
      await db.insert(session).values({ id: `${RUN}-session-${userId}`, token, userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
      return `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;
    };
    const ownerCookie = await cookieFor(ids.owner);
    const memberCookie = await cookieFor(ids.member);
    const outsiderCookie = await cookieFor(ids.outsider);
    const get = (path: string, cookie?: string) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
    const pageExport = `/w/${workspaceId}/p/${project.id}/export`;

    check((await get(`${pageExport}?subpages=1`)).status === 401, "HTTP: exporting needs a session");
    check((await get(`${pageExport}?subpages=1`, outsiderCookie)).status === 404, "HTTP: pages the user can't see are 404");
    const dry = await get(`${pageExport}?subpages=1&check=1`, ownerCookie);
    const summary = (await dry.json()) as { ok: boolean; pages: number; files: number };
    check(dry.status === 200 && summary.ok && summary.pages === 11 && summary.files === 3, "HTTP: a dry run says what the archive would hold", summary);
    const zip = await get(`${pageExport}?subpages=1`, ownerCookie);
    check(
      zip.status === 200 && zip.headers.get("content-type") === "application/zip" && /filename="Project\.zip"/.test(zip.headers.get("content-disposition") ?? ""),
      "HTTP: the archive downloads as Project.zip",
      Object.fromEntries(zip.headers),
    );
    const fetched = await unpack(zip.body!);
    check(fetched.names.includes("Project/Tasks.csv") && fetched.names.includes("files/photo.png"), "HTTP: …with the same contents", fetched.names);
    const markdown = await get(pageExport, ownerCookie);
    check(markdown.headers.get("content-type")?.startsWith("text/markdown") && (await markdown.text()).startsWith("# Project\n"), "HTTP: a single page still exports as Markdown");
    const csvRes = await fetch(`${base}/w/${workspaceId}/p/${tasks.id}/export`, {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({ rows: [shipRow.id] }),
    });
    const csvText = await csvRes.text();
    check(csvRes.headers.get("content-type")?.startsWith("text/csv") && csvText.includes("Ship") && !csvText.includes("Write docs"), "HTTP: selected rows still export as CSV", csvText);

    const wsExport = `/w/${workspaceId}/settings/export.zip`;
    check((await get(wsExport, memberCookie)).status === 404, "HTTP: the workspace export is 404 for members");
    check((await get(`${wsExport}?check=1`, memberCookie)).status === 404, "HTTP: …dry run included");
    const wsZip = await get(wsExport, ownerCookie);
    const wsFiles = await unpack(wsZip.body!);
    check(wsZip.status === 200 && wsFiles.names.includes("Templates/Meeting.md") && wsFiles.names.includes("Elsewhere.md"), "HTTP: owners download the whole workspace", wsFiles.names);
    check(/filename\*=UTF-8''Acme%20Docs%20\d{4}-\d{2}-\d{2}\.zip$/.test(wsZip.headers.get("content-disposition") ?? ""), "HTTP: …named after it and the date", wsZip.headers.get("content-disposition"));
  }

  console.log(`\n${passed} checks passed`);
} finally {
  // Stored bytes first: deleting the workspace removes the rows that name them.
  const stored = await db.select({ key: file.storageKey }).from(file).where(inArray(file.workspaceId, [workspaceId, otherWorkspace]));
  for (const { key } of stored) await instanceStorage().delete(key).catch(() => {});
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

async function storedBytes(fileId: string) {
  const [row] = await db.select().from(file).where(eq(file.id, fileId));
  const body = await instanceStorage().get(row.storageKey);
  return Buffer.from(await new Response(body).arrayBuffer());
}
