/**
 * End-to-end check of full-text search over the PDFs and Word documents pages show, without an
 * embeddings model: an uploaded PDF is read in the background and its page is found by a word only
 * the PDF has (naming the PDF, with a snippet from it), below a page that has the word itself; a
 * person who can't see the page doesn't find it, one it is shared with does; a page whose
 * reference to the file isn't authorized isn't found through it; `in:` and the trash apply; words
 * past a document's first 80,000 characters aren't found; documents uploaded before their text was
 * read are picked up by the sweep, those no page shows are not.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/file-search-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Runs with no
 * embeddings model (AI_EMBEDDINGS_* unset) like most servers; semantic search would add hits.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { randomBytes } = await import("node:crypto");
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Readable } = await import("node:stream");

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-file-search-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, fileReference, fileText, user, workspace, workspaceMember } = await import("@/db/schema");
const { fileUrl } = await import("@/lib/files");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { EXTRACTOR_VERSION, sweepDocuments, whenDocumentsRead } = await import("@/server/file-text");
const files = await import("@/server/files");
const ops = await import("@/server/operations");
const { archivePage, createPage, searchWithQuery } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");

const RUN = `file-search-e2e-${Date.now().toString(36)}`;

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

/** A one-page PDF showing `text` in Helvetica. */
function tinyPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const ids = { owner: `${RUN}-owner`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const owner = { userId: ids.owner };
  const ownerCtx = { userId: ids.owner, actor: owner };
  const search = (query: string, userId = ids.owner) => searchWithQuery(userId, workspaceId, query);
  const make = (title: string, parentId: string | null = null, markdown?: string) =>
    createPage(owner, { workspaceId, parentId, title, markdown });
  const upload = async (pageId: string, name: string, text: string) => {
    const pdf = tinyPdf(text);
    return files.uploadFile(ids.owner, pageId, { name, contentType: "application/pdf", body: Readable.from([pdf]), declaredSize: pdf.length });
  };
  const show = (pageId: string, stored: { name: string; url: string }, before = "See the attachment.") =>
    ops.updatePage(ownerCtx, { page_id: pageId, markdown: `${before}\n\n[${stored.name}](${stored.url})`, mode: "replace" });

  const projects = await make("Projects");
  const archive = await make("Archive");
  const offer = await make("Supplier offer", projects.id);
  const offerPdf = await upload(offer.id, "Offer.pdf", "Glycol pump zorbatron quote for the cold room");
  await show(offer.id, offerPdf);
  await whenDocumentsRead();
  const [read] = await db.select({ text: fileText.text, version: fileText.extractorVersion }).from(fileText).where(eq(fileText.fileId, offerPdf.id));
  check(read?.text.includes("zorbatron") && read.version === EXTRACTOR_VERSION, "an uploaded PDF is read in the background without an embeddings model", read);

  const hits = await search("zorbatron");
  const hit = hits.find((h) => h.id === offer.id);
  check(hit, "a page is found by a word only the PDF it shows has", hits);
  check(hit.file?.id === offerPdf.id && hit.file.name === "Offer.pdf", "…the hit names the PDF", hit);
  check(hit.snippet.includes("zorbatron"), "…and its snippet comes from the PDF", hit);
  check((await search("zorb")).some((h) => h.id === offer.id), "…also by the start of the word, as it is typed");
  check((await search("glycol zorbatron")).some((h) => h.id === offer.id), "…and by several words of the PDF");

  const manual = await make("Pump manual", null, "How to service the zorbatron.");
  const both = await search("zorbatron");
  check(both[0]?.id === manual.id && both.some((h) => h.id === offer.id), "a page with the word in its own text comes first", both.map((h) => h.title));
  check(!both[0].file, "…and names no document", both[0]);

  // A page that only links to the file, by a write whose author couldn't read it: the reference
  // isn't authorized, so the PDF's words don't find that page.
  const copied = await make("Copied link", archive.id);
  await show(copied.id, offerPdf, "Someone pasted this.");
  check((await search("zorbatron")).some((h) => h.id === copied.id), "a page showing the file by an authorized reference is found by its words");
  await db.update(fileReference).set({ authorized: false }).where(and(eq(fileReference.pageId, copied.id), eq(fileReference.fileId, offerPdf.id)));
  check(!(await search("zorbatron")).some((h) => h.id === copied.id), "a page whose reference to the file isn't authorized isn't found by its words");

  check((await search("zorbatron in:Projects")).some((h) => h.id === offer.id), "in: keeps document hits under the page");
  check(!(await search("zorbatron in:Archive")).some((h) => h.id === offer.id), "…and leaves out those elsewhere");
  check((await search("zorbatron type:row")).length === 0, "type: applies to document hits too");

  check((await search("zorbatron", ids.guest)).length === 0, "a guest who can't see the page doesn't find it by the PDF");
  await setPagePermission(ids.owner, offer.id, ids.guest, "view");
  const shared = await search("zorbatron", ids.guest);
  check(shared.length === 1 && shared[0].id === offer.id && shared[0].file?.name === "Offer.pdf", "…once it is shared with them, they do", shared);

  // Only the first 80,000 characters of a document are searched, as for a page's body.
  const longPage = await make("Long contract");
  const longId = randomBytes(18).toString("base64url");
  await db.insert(file).values({
    id: longId,
    workspaceId,
    pageId: longPage.id,
    storageKey: `${workspaceId}/${longId}`,
    name: "Contract.pdf",
    contentType: "application/pdf",
    size: 1000,
  });
  const filler = Array.from({ length: 9_000 }, (_, i) => `clause${i}`).join(" ");
  await db.insert(fileText).values({
    fileId: longId,
    contentHash: `${RUN}-long`,
    extractorVersion: EXTRACTOR_VERSION,
    text: `quibbleworth ${filler} farthingale`,
  });
  await show(longPage.id, { name: "Contract.pdf", url: fileUrl(longId) });
  check((await search("quibbleworth")).some((h) => h.id === longPage.id), "a word near a document's start is found");
  check(!(await search("farthingale")).some((h) => h.id === longPage.id), "…one past its first 80,000 characters isn't");

  // Documents uploaded before full-text search read them: the sweep picks up those a page shows.
  const older = await make("Older offer");
  const olderPdf = await upload(older.id, "Older.pdf", "Evaporator brackwater offer");
  await show(older.id, olderPdf);
  const unshown = await upload(older.id, "Unshown.pdf", "Evaporator brackwater draft");
  await whenDocumentsRead();
  await db.delete(fileText).where(inArray(fileText.fileId, [olderPdf.id, unshown.id]));
  check(!(await search("brackwater")).length, "a document not read yet finds nothing");
  const queued = await sweepDocuments(workspaceId, { force: true });
  await whenDocumentsRead();
  check(queued === 1, "the sweep queues the documents pages show that weren't read, not others", queued);
  const swept = await search("brackwater");
  check(swept.length === 1 && swept[0].id === older.id && swept[0].file?.name === "Older.pdf", "…and their pages are found by them afterwards", swept);
  check((await sweepDocuments(workspaceId, { force: true })) === 0, "…once, not again");

  await archivePage(ids.owner, offer.id);
  check(!(await search("zorbatron")).some((h) => h.id === offer.id), "a page in the trash isn't found by its documents");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
