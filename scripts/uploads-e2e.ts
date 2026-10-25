/**
 * End-to-end check of file uploads: storing with per-file and workspace limits enforced while the
 * bytes arrive, who may read a file (its page, pages showing it, copies from Duplicate and
 * templates, published pages), the file route's headers and ranges, the upload route, MCP's
 * attach_file (files:write, base64, blocked private URLs), and the cleanups.
 * Creates its own users and workspaces, stores files in a temporary directory, and deletes all of
 * it afterwards.
 *
 *   pnpm tsx scripts/uploads-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { mkdtemp, readdir, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Readable } = await import("node:stream");
const { randomBytes } = await import("node:crypto");

// Small limits, so they can be hit with small files; a scratch directory for the bytes.
const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-uploads-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;
process.env.UPLOAD_MAX_FILE_MB = String(10_000 / 1024 / 1024); // 10,000 bytes
process.env.UPLOAD_WORKSPACE_QUOTA_MB = String(30_000 / 1024 / 1024); // 30,000 bytes

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, fileReference, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { env } = await import("@/lib/env");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, deletePagePermanently } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { createFromTemplate, deleteTemplate, saveAsTemplate } = await import("@/server/templates");
const { setPagePermission } = await import("@/server/permissions");
const { publishPage, unpublishPage } = await import("@/server/publication");
const { AccessError } = await import("@/server/access");
const files = await import("@/server/files");
const { instanceStorage } = await import("@/server/storage");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { FILES_SCOPE, READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const uploadRoute = await import("@/app/api/files/route");
const fileRoute = await import("@/app/api/files/[id]/route");

const RUN = `uploads-e2e-${Date.now().toString(36)}`;

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
    if (error instanceof files.FileError) return error.code;
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

const bytes = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const upload = (userId: string, pageId: string, name: string, body: Buffer, contentType?: string, declare = true) =>
  files.uploadFile(userId, pageId, { name, contentType, body: Readable.from([body]), declaredSize: declare ? body.length : null });
const canRead = async (userId: string | null, fileId: string) => (await files.fileForViewer(userId, fileId)) !== null;
const refsOf = async (fileId: string) =>
  (await db.select({ pageId: fileReference.pageId }).from(fileReference).where(eq(fileReference.fileId, fileId))).map((r) => r.pageId);
const stored = async (key: string) => {
  const body = await instanceStorage().get(key);
  return body ? Buffer.from(await new Response(body).arrayBuffer()) : null;
};
const fileRow = async (id: string) => (await db.select().from(file).where(eq(file.id, id)))[0] ?? null;

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>, scopes: string[]) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "uploads-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const BASE = "http://localhost:3000";
const getFile = (id: string, headers: Record<string, string> = {}) =>
  fileRoute.GET(new Request(`${BASE}/api/files/${id}`, { headers }), { params: Promise.resolve({ id }) });

const ids = {
  owner: `${RUN}-owner`,
  member: `${RUN}-member`,
  guest: `${RUN}-guest`,
  guest2: `${RUN}-guest2`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId, userId: ids.guest2, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  // A signed-in browser for the member: a session and its signed cookie, as Better Auth sets it.
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${RUN}-session`, token, userId: ids.member, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  const memberCookie = `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;

  const doc = await createPage({ userId: ids.owner }, { workspaceId, title: "Doc" });

  // Storing
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), bytes(3992)]);
  const image = await upload(ids.owner, doc.id, "../../photo.png", png, "image/png");
  check(/^[A-Za-z0-9_-]{24}$/.test(image.id) && image.url === `/api/files/${image.id}`, "an upload gets an unguessable id and a same-origin URL", image);
  check(image.name === "photo.png" && image.contentType === "image/png" && image.size === png.length, "…its name loses any path, and keeps its type and size", image);
  const row = await fileRow(image.id);
  check(row?.workspaceId === workspaceId && row.pageId === doc.id && row.uploadedBy === ids.owner, "the file row records its workspace, page and uploader", row);
  check((await stored(row.storageKey))?.equals(png), "the bytes are stored under the workspace", row.storageKey);
  const noType = await upload(ids.owner, doc.id, "notes.txt", Buffer.from("hello"), undefined);
  check(noType.contentType === "text/plain", "a missing type is guessed from the name", noType);

  // Limits
  const before = (await db.select({ id: file.id }).from(file).where(eq(file.workspaceId, workspaceId))).length;
  check((await failure(() => upload(ids.owner, doc.id, "big.bin", bytes(10_001)))) === "tooLarge", "a file over the per-file limit is refused up front");
  check(
    (await failure(() => upload(ids.owner, doc.id, "big.bin", bytes(10_001), undefined, false))) === "tooLarge",
    "…and while streaming when its size wasn't declared",
  );
  const filler1 = await upload(ids.owner, doc.id, "filler1.bin", bytes(9_000));
  const filler2 = await upload(ids.owner, doc.id, "filler2.bin", bytes(9_000));
  // Used: 4,000 + 5 + 9,000 + 9,000 = 22,005 of 30,000.
  check((await failure(() => upload(ids.owner, doc.id, "more.bin", bytes(9_000)))) === "quotaExceeded", "the workspace quota refuses a declared upload");
  check(
    (await failure(() => upload(ids.owner, doc.id, "more.bin", bytes(9_000), undefined, false))) === "quotaExceeded",
    "…and stops an undeclared one while streaming",
  );
  check((await files.workspaceUsage(workspaceId)) === 22_005, "refused uploads take no space", await files.workspaceUsage(workspaceId));
  check((await db.select({ id: file.id }).from(file).where(eq(file.workspaceId, workspaceId))).length === before + 2, "…and leave no rows");
  const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("leafdesk-upload-"));
  check(leftovers.length === 0, "…and no temporary files", leftovers);
  const parallel = await Promise.allSettled([
    upload(ids.owner, doc.id, "p1.bin", bytes(5_000)),
    upload(ids.owner, doc.id, "p2.bin", bytes(5_000)),
  ]);
  check(
    parallel.filter((r) => r.status === "fulfilled").length === 1 && (await files.workspaceUsage(workspaceId)) <= 30_000,
    "two uploads racing for the last room can't overshoot the quota",
    parallel.map((r) => r.status),
  );
  for (const r of parallel) if (r.status === "fulfilled") await db.delete(file).where(eq(file.id, r.value.id));
  await db.delete(file).where(inArray(file.id, [filler1.id, filler2.id]));

  // Who may upload
  const guestDoc = doc.id;
  await setPagePermission(ids.owner, guestDoc, ids.guest, "view");
  check((await failure(() => upload(ids.guest, guestDoc, "x.png", bytes(10)))) === "access", "viewing a page isn't enough to upload to it");
  check((await failure(() => upload(ids.outsider, doc.id, "x.png", bytes(10)))) === "access", "people outside the workspace can't upload to it");

  // Who may read: the page it was uploaded to
  check(await canRead(ids.owner, image.id), "the uploader reads the file");
  check(await canRead(ids.member, image.id), "members who can see the page read it");
  check(await canRead(ids.guest, image.id), "a guest the page is shared with reads it");
  check(!(await canRead(ids.guest2, image.id)), "a guest the page isn't shared with can't");
  check(!(await canRead(ids.outsider, image.id)), "people outside the workspace can't");
  check(!(await canRead(null, image.id)), "visitors who aren't signed in can't, while nothing is published");
  check(!(await canRead(ids.owner, "AAAAAAAAAAAAAAAAAAAAAAAA")) && !(await canRead(ids.owner, "../etc/passwd")), "unknown and malformed ids read as missing");

  // Pages showing the file
  const other = await createPage({ userId: ids.owner }, { workspaceId, title: "Other" });
  await setPagePermission(ids.owner, other.id, ids.guest2, "view");
  check(!(await canRead(ids.guest2, image.id)), "sharing an unrelated page grants nothing");
  await getCollab().replaceContent(other.id, `Look:\n\n![photo](${image.url})`, { userId: ids.owner });
  await eventually(async () => (await refsOf(image.id)).includes(other.id), "the reference");
  check(await canRead(ids.guest2, image.id), "a page showing the file lets its viewers read it");
  check((await fileRow(image.id))?.referencedAt instanceof Date, "the file is marked as used");
  await getCollab().replaceContent(other.id, "Nothing here now.", { userId: ids.owner });
  await eventually(async () => !(await refsOf(image.id)).includes(other.id), "the reference to go");
  check(!(await canRead(ids.guest2, image.id)), "taking it out of the page takes that away again");
  await getCollab().replaceContent(other.id, `Back:\n\n![photo](${image.url})`, { userId: ids.owner });
  await eventually(async () => (await refsOf(image.id)).includes(other.id), "the reference to return");

  const foreign = await createPage({ userId: ids.outsider }, { workspaceId: otherWorkspace, title: "Foreign" });
  await getCollab().replaceContent(foreign.id, `![stolen](https://example.test${image.url})`, { userId: ids.outsider });
  await new Promise((r) => setTimeout(r, 500));
  check(!(await refsOf(image.id)).includes(foreign.id), "a page of another workspace showing the URL doesn't count");
  check(!(await canRead(ids.outsider, image.id)), "…so pasting a URL there grants nothing");

  // Copies share the stored file
  const copy = await duplicatePage({ userId: ids.owner }, other.id);
  check((await refsOf(image.id)).includes(copy.id), "a duplicate shows the same file right away");
  await setPagePermission(ids.owner, other.id, ids.guest2, "none");
  await setPagePermission(ids.owner, copy.id, ids.guest2, "view");
  check(await canRead(ids.guest2, image.id), "someone who sees only the copy reads the file");
  const template = await saveAsTemplate({ userId: ids.owner }, other.id);
  const fromTemplate = await createFromTemplate({ userId: ids.owner }, template.id, { title: "From template" });
  check(
    (await refsOf(image.id)).includes(template.id) && (await refsOf(image.id)).includes(fromTemplate.id),
    "templates and pages made from them show it too",
  );
  check((await db.select({ id: file.id }).from(file).where(eq(file.workspaceId, workspaceId))).length === before, "copies don't store the file again");

  // Published pages
  const sub = await createPage({ userId: ids.owner }, { workspaceId, parentId: doc.id, title: "Sub" });
  const subFile = await upload(ids.owner, sub.id, "sub.png", bytes(100), "image/png");
  check(!(await canRead(null, subFile.id)), "a subpage's file is private while nothing above it is published");
  await publishPage(ids.owner, doc.id);
  check(await canRead(null, image.id), "visitors of a published page read its files");
  check(await canRead(null, subFile.id), "…and those of its subpages");
  check(await canRead(ids.outsider, image.id), "…signed in to another workspace or not");
  const unrelated = await upload(ids.owner, other.id, "unrelated.png", bytes(50), "image/png");
  check(!(await canRead(null, unrelated.id)), "files of unpublished pages stay private");
  await setPagePermission(ids.owner, sub.id, ids.member, "full");
  await setPagePermission(ids.member, sub.id, null, "none");
  check(!(await canRead(null, subFile.id)), "a subpage the publisher can't see isn't published, nor are its files");
  await setPagePermission(ids.member, sub.id, null, "full");

  // The file route
  const res = await getFile(image.id);
  check(res.status === 200, "the route serves a published file without a session", res.status);
  check(res.headers.get("content-type") === "image/png" && res.headers.get("content-length") === String(png.length), "…with its type and length");
  check(res.headers.get("x-content-type-options") === "nosniff", "…never sniffed");
  check(res.headers.get("content-disposition")?.startsWith("inline;"), "…shown inline, being a raster image", res.headers.get("content-disposition"));
  check(res.headers.get("content-security-policy")?.includes("sandbox"), "…and sandboxed");
  check(Buffer.from(await res.arrayBuffer()).equals(png), "…with the right bytes");
  const partial = await getFile(image.id, { range: "bytes=0-7" });
  check(
    partial.status === 206 && partial.headers.get("content-range") === `bytes 0-7/${png.length}` && (await partial.text()).startsWith("�PNG"),
    "ranges come back as 206 for seeking",
    partial.status,
  );
  check((await getFile(image.id, { range: `bytes=${png.length}-` })).status === 416, "a range past the end is 416");
  check((await getFile(image.id, { "if-none-match": `"${image.id}"` })).status === 304, "a cached copy is revalidated with 304");
  const svg = await upload(ids.owner, doc.id, "logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml");
  const svgRes = await getFile(svg.id);
  check(
    svgRes.status === 200 && svgRes.headers.get("content-disposition")?.startsWith("attachment;") && svgRes.headers.get("content-security-policy") === "default-src 'none'; sandbox",
    "SVG is always a sandboxed download",
    Object.fromEntries(svgRes.headers),
  );
  const html = await upload(ids.owner, doc.id, "page.html", Buffer.from("<script>alert(1)</script>"), "text/html");
  check((await getFile(html.id)).headers.get("content-disposition")?.startsWith("attachment;"), "HTML is a download too");
  const pdf = await upload(ids.owner, doc.id, "doc.pdf", Buffer.from("%PDF-1.4"), "application/pdf");
  const pdfRes = await getFile(pdf.id);
  check(
    pdfRes.headers.get("content-disposition")?.startsWith("inline;") &&
      pdfRes.headers.get("content-security-policy") === "frame-ancestors 'self'" &&
      pdfRes.headers.get("x-frame-options") === "SAMEORIGIN",
    "PDFs open inline, framed by this site only (the inline viewer)",
    Object.fromEntries(pdfRes.headers),
  );
  const missing = await getFile("AAAAAAAAAAAAAAAAAAAAAAAA");
  check(missing.status === 404 && missing.headers.get("x-content-type-options") === "nosniff", "an unknown id is a plain 404");
  await unpublishPage(ids.owner, doc.id);
  check((await getFile(image.id)).status === 404, "unpublishing takes files offline for visitors");
  check((await getFile(image.id, { cookie: memberCookie })).status === 200, "…while signed-in members still load them");
  check((await getFile(image.id, { cookie: "better-auth.session_token=forged.value" })).status === 404, "a forged session counts as none");

  // The upload route
  const post = (headers: Record<string, string>, body: BodyInit, pageId = doc.id) =>
    uploadRoute.POST(new Request(`${BASE}/api/files?pageId=${pageId}`, { method: "POST", headers, body, duplex: "half" } as RequestInit));
  check((await post({ "x-file-name": "a.png" }, "x")).status === 401, "uploading needs a session");
  const posted = await post({ cookie: memberCookie, "x-file-name": encodeURIComponent("çizim 1.png"), "content-type": "image/png" }, bytes(64));
  const postedBody = (await posted.json()) as { id: string; url: string; name: string };
  check(posted.status === 201 && postedBody.name === "çizim 1.png" && postedBody.url === `/api/files/${postedBody.id}`, "the route stores an upload", postedBody);
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 11; i++) controller.enqueue(bytes(1_000, i));
      controller.close();
    },
  });
  const tooBig = await post({ cookie: memberCookie, "x-file-name": "big.bin" }, streamed);
  check(tooBig.status === 413 && ((await tooBig.json()) as { code: string }).code === "tooLarge", "a streamed body over the limit is cut off with 413");
  check((await post({ cookie: memberCookie, "x-file-name": "a.png", origin: "https://evil.example" }, "x")).status === 403, "a foreign Origin is refused");
  check((await post({ cookie: memberCookie }, "x")).status === 400, "the file name header is required");
  check((await post({ cookie: memberCookie, "x-file-name": "a.png" }, "x", foreign.id)).status === 404, "pages the user can't edit read as missing");

  // MCP
  const pngBase64 = png.toString("base64");
  const noScope = await callTool(ids.owner, "attach_file", { page_id: other.id, base64: pngBase64, name: "mcp.png" }, [READ_SCOPE, WRITE_SCOPE]);
  check(noScope.isError && noScope.text.includes("files:write"), "attach_file needs files:write", noScope.text);
  const scopes = [READ_SCOPE, WRITE_SCOPE, FILES_SCOPE];
  const attached = await callTool(ids.owner, "attach_file", { page_id: other.id, base64: `data:image/png;base64,${pngBase64}`, name: "mcp.png", caption: "From MCP" }, scopes);
  check(!attached.isError && attached.data.block === "image" && attached.data.appended, "attach_file stores base64 data and appends an image block", attached.text);
  await eventually(async () => (await refsOf(attached.data.id)).includes(other.id), "the MCP file's reference");
  check((await getCollab().readPage(other.id)).markdown.includes(attached.data.path), "the page body shows the new file");
  const blocked = await callTool(ids.owner, "attach_file", { page_id: other.id, url: "http://127.0.0.1:3000/api/files/x" }, scopes);
  check(blocked.isError && /isn't public/.test(blocked.text), "attach_file won't fetch loopback addresses", blocked.text);
  const metadata = await callTool(ids.owner, "attach_file", { page_id: other.id, url: "http://169.254.169.254/latest/meta-data/" }, scopes);
  check(metadata.isError && /isn't public/.test(metadata.text), "…nor cloud metadata", metadata.text);
  const viewerAttach = await callTool(ids.guest, "attach_file", { page_id: doc.id, base64: pngBase64, name: "x.png" }, scopes);
  check(viewerAttach.isError, "attach_file needs edit access to the page", viewerAttach.text);

  // Cleanup: deleting pages for good
  const imageKey = (await fileRow(image.id))!.storageKey;
  const subKey = (await fileRow(subFile.id))!.storageKey;
  await archivePage(ids.owner, doc.id);
  await deletePagePermanently(ids.owner, doc.id);
  check((await fileRow(subFile.id)) === null && (await stored(subKey)) === null, "deleting a page for good removes files only it had");
  check((await fileRow(svg.id)) === null, "…every one of them");
  const kept = await fileRow(image.id);
  check(kept !== null && kept.pageId === null && (await stored(imageKey)) !== null, "a file other pages still show stays", kept);
  check(await canRead(ids.member, image.id), "…readable through those pages");
  for (const id of [other.id, copy.id, fromTemplate.id]) {
    await archivePage(ids.owner, id);
    await deletePagePermanently(ids.owner, id);
  }
  check((await fileRow(image.id)) !== null, "…until the last page showing it is gone");
  await deleteTemplate(ids.owner, template.id);
  check((await fileRow(image.id)) === null && (await stored(imageKey)) === null, "then it goes, bytes and all");

  // Cleanup: uploads nothing used
  const page2 = await createPage({ userId: ids.owner }, { workspaceId, title: "Later" });
  const unused = await upload(ids.owner, page2.id, "unused.png", bytes(10), "image/png");
  const used = await upload(ids.owner, page2.id, "used.png", bytes(10), "image/png");
  await getCollab().replaceContent(page2.id, `![used](${used.url})`, { userId: ids.owner });
  await eventually(async () => (await refsOf(used.id)).length > 0, "the used file's reference");
  await files.purgeUnusedUploads({ workspaceId });
  check((await fileRow(unused.id)) !== null, "fresh unused uploads are kept for a while");
  await db
    .update(file)
    .set({ createdAt: sql`now() - interval '2 days'` })
    .where(and(eq(file.workspaceId, workspaceId), inArray(file.id, [unused.id, used.id])));
  await files.purgeUnusedUploads({ workspaceId });
  check((await fileRow(unused.id)) === null, "an upload no page showed for a day is removed");
  check((await fileRow(used.id)) !== null, "a used one stays");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
