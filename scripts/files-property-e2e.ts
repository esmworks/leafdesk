/**
 * End-to-end check of files & media properties: attaching uploads to rows, which files a value may
 * hold, who may read them (reference tracking of property values), removing and cleaning up,
 * filters and sorts, gallery covers from a files property, published databases, forms that take
 * uploads (in the app and on public links, through the upload route), the MCP tools, and the
 * inline PDF viewer's file route guard.
 * Creates its own users and workspaces, stores files in a temporary directory, and deletes all of
 * it afterwards.
 *
 *   pnpm tsx scripts/files-property-e2e.ts
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

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-files-property-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseView, file, fileReference, page, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { makeSignature } = await import("better-auth/crypto");
const { CLIENT_IP_HEADER } = await import("@/lib/client-ip");
const { env } = await import("@/lib/env");
const { FORM_TITLE } = await import("@/lib/forms");
const { PropertyValueError } = await import("@/lib/properties");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage, deletePagePermanently } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { setPagePermission } = await import("@/server/permissions");
const { getPublishedPage, publishPage, setWebViews } = await import("@/server/publication");
const databases = await import("@/server/databases");
const forms = await import("@/server/forms");
const files = await import("@/server/files");
const { AccessError } = await import("@/server/access");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { FILES_SCOPE, READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const uploadRoute = await import("@/app/api/files/route");
const fileRoute = await import("@/app/api/files/[id]/route");

const RUN = `files-prop-e2e-${Date.now().toString(36)}`;

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
    if (error instanceof PropertyValueError) return error.code ?? "property";
    if (error instanceof forms.FormError) {
      return error.code === "invalidAnswers" ? `invalidAnswers:${error.answers.map((a) => a.code).join(",")}` : error.code;
    }
    if (error instanceof files.FileError) return error.code;
    throw error;
  }
}

const bytes = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), bytes(200)]);
const input = (name: string, body: Buffer, contentType?: string) => ({
  name,
  contentType,
  body: Readable.from([body]),
  declaredSize: body.length,
});
const upload = (userId: string, pageId: string, name: string, body: Buffer, contentType?: string) =>
  files.uploadFile(userId, pageId, input(name, body, contentType));
const canRead = async (userId: string | null, fileId: string) => (await files.fileForViewer(userId, fileId)) !== null;
const refsOf = async (fileId: string) =>
  (await db.select({ pageId: fileReference.pageId }).from(fileReference).where(eq(fileReference.fileId, fileId))).map((r) => r.pageId);
const fileRow = async (id: string) => (await db.select().from(file).where(eq(file.id, id)))[0] ?? null;
const valueOf = async (rowId: string, propertyId: string) =>
  ((await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0]?.properties ?? {})[propertyId] as
    | { url: string; name: string; type: string }[]
    | undefined;

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>, scopes = [READ_SCOPE, WRITE_SCOPE, FILES_SCOPE]) {
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "files-property-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

// Requests are handed to the route handlers directly; no server listens on this address.
const BASE = "http://files-e2e.localhost";
const getFile = (id: string, query = "", headers: Record<string, string> = {}) =>
  fileRoute.GET(new Request(`${BASE}/api/files/${id}${query}`, { headers }), { params: Promise.resolve({ id }) });
const postFile = (query: string, headers: Record<string, string>, body: BodyInit) =>
  uploadRoute.POST(new Request(`${BASE}/api/files?${query}`, { method: "POST", headers, body, duplex: "half" } as RequestInit));

const ids = {
  owner: `${RUN}-owner`,
  member: `${RUN}-member`,
  guest: `${RUN}-guest`,
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
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  const token = randomBytes(24).toString("hex");
  await db.insert(session).values({ id: `${RUN}-session`, token, userId: ids.member, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });
  const memberCookie = `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.authSecret)}`)}`;

  const actor = { userId: ids.owner };
  const assets = await createPage(actor, { workspaceId, kind: "database", title: "Assets" });
  await setPagePermission(ids.owner, assets.id, ids.owner, "full");
  await setPagePermission(ids.owner, assets.id, null, "edit");
  const attachments = await databases.addProperty(ids.owner, assets.id, { name: "Attachments", type: "files" });
  const notes = await databases.addProperty(ids.owner, assets.id, { name: "Notes", type: "text" });
  check(attachments.type === "files", "a database gets a files & media property", attachments);
  const [row1, row2, row3] = await databases.createRows(ids.owner, assets.id, [{ title: "One" }, { title: "Two" }, { title: "Three" }]);

  // Attaching files
  const image = await upload(ids.owner, row1.id, "photo.png", PNG, "image/png");
  const pdf = await upload(ids.owner, row1.id, "report.pdf", Buffer.from("%PDF-1.4\n%fake"), "application/pdf");
  await databases.updateRowProperties(ids.owner, row1.id, {
    [attachments.id]: [image.url, { url: `${env.appUrl}${pdf.url}`, name: "evil.exe" }],
  });
  const stored = await valueOf(row1.id, attachments.id);
  check(
    stored?.length === 2 &&
      stored[0].url === image.url &&
      stored[0].name === "photo.png" &&
      stored[0].type === "image/png" &&
      stored[1].url === pdf.url &&
      stored[1].name === "report.pdf" &&
      stored[1].type === "application/pdf",
    "a row holds several files, as paths with the names and types the server stored",
    stored,
  );
  check((await refsOf(image.id)).includes(row1.id) && (await refsOf(pdf.id)).includes(row1.id), "the reference trigger records files in property values");
  check((await fileRow(image.id))?.referencedAt instanceof Date, "…and marks them as used");
  check(
    (await failure(() => databases.updateRowProperties(ids.owner, row2.id, { [attachments.id]: ["https://example.com/cat.png"] }))) === "invalidFile",
    "outside URLs are refused",
  );
  check(
    (await failure(() => databases.updateRowProperties(ids.owner, row2.id, { [attachments.id]: ["AAAAAAAAAAAAAAAAAAAAAAAA"] }))) === "invalidFile",
    "unknown file ids are refused",
  );
  const foreignPage = await createPage({ userId: ids.outsider }, { workspaceId: otherWorkspace, title: "Foreign" });
  const foreign = await upload(ids.outsider, foreignPage.id, "foreign.png", PNG, "image/png");
  check(
    (await failure(() => databases.updateRowProperties(ids.owner, row2.id, { [attachments.id]: [foreign.url] }))) === "invalidFile",
    "files of another workspace are refused",
  );
  const secret = await createPage(actor, { workspaceId, title: "Secret" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  const secretFile = await upload(ids.owner, secret.id, "secret.png", PNG, "image/png");
  check(!(await canRead(ids.member, secretFile.id)), "a member can't read a file of a page they can't see");
  check(
    (await failure(() => databases.updateRowProperties(ids.member, row2.id, { [attachments.id]: [secretFile.url] }))) === "invalidFile",
    "…nor attach it to a row to get at it",
  );
  await databases.updateRowProperties(ids.member, row2.id, { [notes.id]: `see ${secretFile.url}` });
  check(!(await refsOf(secretFile.id)).includes(row2.id), "a file path in a text property is no reference");
  check(!(await canRead(ids.member, secretFile.id)), "…and grants nothing");

  // Who may read: anyone who can see a row holding the file
  check(!(await canRead(ids.guest, image.id)), "a guest who sees none of the rows can't read the file");
  await setPagePermission(ids.owner, row2.id, ids.guest, "view");
  await databases.updateRowProperties(ids.owner, row2.id, { [attachments.id]: [image.url] });
  check((await refsOf(image.id)).includes(row2.id), "another row of the workspace can hold the same file");
  check(await canRead(ids.guest, image.id), "a guest who sees that row reads it");
  await databases.updateRowProperties(ids.owner, row2.id, { [attachments.id]: [] });
  check(!(await refsOf(image.id)).includes(row2.id) && (await valueOf(row2.id, attachments.id)) === undefined, "removing it clears the reference");
  check(!(await canRead(ids.guest, image.id)), "…and the guest's access with it");

  // Removing a file never deletes it
  await databases.updateRowProperties(ids.owner, row1.id, { [attachments.id]: [pdf.url] });
  check((await fileRow(image.id)) !== null, "a file taken out of a value stays stored");
  await db.update(file).set({ createdAt: sql`now() - interval '2 days'` }).where(eq(file.id, image.id));
  await files.purgeUnusedUploads({ workspaceId });
  check((await fileRow(image.id)) !== null && (await canRead(ids.member, image.id)), "…still readable through its row, and not purged as unused");
  await databases.updateRowProperties(ids.owner, row1.id, { [attachments.id]: [image.url, pdf.url] });

  // Files other rows hold, and files that went away meanwhile
  await databases.updateRowProperties(ids.owner, row3.id, { [attachments.id]: [pdf.url] });
  check((await valueOf(row3.id, attachments.id))?.[0]?.url === pdf.url, "a row can hold a file uploaded to another row");
  const doomed = await upload(ids.owner, row2.id, "doomed.png", PNG, "image/png");
  await databases.updateRowProperties(ids.owner, row2.id, { [attachments.id]: [doomed.url] });
  await db.delete(file).where(eq(file.id, doomed.id));
  await databases.updateRowProperties(ids.member, row2.id, { [attachments.id]: [doomed.url], [notes.id]: "edited" });
  check((await valueOf(row2.id, attachments.id)) === undefined, "a file that no longer exists drops out when the row is saved again, without blocking the edit");

  // Filters and sorts
  const byCount = await databases.listRows(ids.owner, assets.id, { sorts: [{ propertyId: attachments.id, direction: "desc" }] });
  check(byCount.map((r) => r.id).slice(0, 2).join() === [row1.id, row3.id].join(), "rows sort by how many files they hold", byCount.map((r) => r.title));
  const withFiles = await databases.listRows(ids.owner, assets.id, { filters: [{ propertyId: attachments.id, op: "is_not_empty" }] });
  check(withFiles.map((r) => r.id).sort().join() === [row1.id, row3.id].sort().join(), "is not empty finds the rows with files");

  // Copies of a row show the same files
  const copy = await duplicatePage({ userId: ids.owner }, row1.id, " (copy)");
  check((await refsOf(image.id)).includes(copy.id), "a duplicated row references the same files");

  // Gallery covers and published databases
  const gallery = await databases.addView(ids.owner, assets.id, { name: "Cards", type: "gallery" });
  await databases.updateView(ids.owner, gallery.id, { config: { cover: { source: "property", propertyId: attachments.id } } });
  check(
    (await failure(() => databases.updateView(ids.owner, gallery.id, { config: { cover: { source: "property" } as never } }))) !== null,
    "a property cover must name the property",
  );
  const { token: published } = await publishPage(ids.owner, assets.id);
  await setWebViews(ids.owner, assets.id, [gallery.id]);
  const data = (await getPublishedPage(published, undefined, gallery.id))!.database!;
  const card = data.rows.find((r) => r.id === row1.id);
  check(data.layout === "gallery" && card?.cover === image.url, "a gallery shows the first image of its files property as the cover", card);
  check(data.rows.find((r) => r.id === row3.id)?.cover === null, "…and none for rows without an image (a PDF isn't one)");
  check(Array.isArray(card?.properties[attachments.id]), "published rows carry the files value");
  check(await canRead(null, image.id), "visitors of the published database read the files in its rows");
  check(!(await canRead(null, secretFile.id)), "…but no other files");
  const publicPdf = await getFile(pdf.id, "?view=pdf");
  check(
    publicPdf.status === 200 &&
      publicPdf.headers.get("content-type") === "application/pdf" &&
      publicPdf.headers.get("content-security-policy") === "frame-ancestors 'self'" &&
      publicPdf.headers.get("x-frame-options") === "SAMEORIGIN",
    "the inline PDF viewer's URL serves PDFs, framable by this site only",
    Object.fromEntries(publicPdf.headers),
  );
  check((await getFile(image.id, "?view=pdf")).status === 404, "…and nothing that isn't a PDF");
  check((await getFile(pdf.id, "?view=other")).status === 404, "unknown views are 404");
  check((await getFile(image.id)).headers.get("content-security-policy")?.includes("sandbox"), "other files keep their sandbox");
  await databases.deleteProperty(ids.owner, (await databases.addProperty(ids.owner, assets.id, { name: "Spare", type: "files" })).id);
  const [spareless] = await db.select({ config: databaseView.config }).from(databaseView).where(eq(databaseView.id, gallery.id));
  check(spareless.config.cover?.source === "property", "deleting another files property leaves the cover alone");

  // Forms
  const form = await databases.addView(ids.owner, assets.id, { name: "Submit", type: "form" });
  await databases.updateView(ids.owner, form.id, {
    config: { form: { questions: [{ propertyId: FORM_TITLE, required: true }, { propertyId: attachments.id, required: true }] } },
  });
  const plainForm = await databases.addView(ids.owner, assets.id, { name: "Plain", type: "form" });
  await databases.updateView(ids.owner, plainForm.id, { config: { form: { questions: [{ propertyId: FORM_TITLE }] } } });
  check(
    (await failure(() => forms.uploadFormFile(ids.member, plainForm.id, input("x.png", PNG, "image/png")))) === "notAllowed",
    "a form that asks for no files takes no uploads",
  );
  check(
    (await failure(() => forms.uploadFormFile(ids.guest, form.id, input("x.png", PNG, "image/png")))) === "access",
    "people who can't add rows can't upload to a form",
  );
  const answerFile = await forms.uploadFormFile(ids.member, form.id, input("answer.png", PNG, "image/png"));
  check((await fileRow(answerFile.id))?.pageId === assets.id, "a form upload waits with the database");
  check(
    (await failure(() => forms.submitForm(ids.member, form.id, { [FORM_TITLE]: "Stolen", [attachments.id]: [pdf.url] }))) ===
      "invalidAnswers:invalidFile",
    "an answer can only name uploads to the form, not files of other rows",
  );
  check(
    (await failure(() => forms.submitForm(ids.member, form.id, { [FORM_TITLE]: "Nothing" }))) === "invalidAnswers:required",
    "a required files question needs a file",
  );
  const submitted = await forms.submitForm(ids.member, form.id, {
    [FORM_TITLE]: "From the form",
    [attachments.id]: [{ url: answerFile.url, name: "renamed.exe" }],
  });
  const answered = await valueOf(submitted.id, attachments.id);
  check(answered?.[0]?.url === answerFile.url && answered[0].name === "answer.png", "the new row holds the upload, under its stored name", answered);
  check((await fileRow(answerFile.id))?.pageId === submitted.id, "…and takes it over from the database");
  check((await refsOf(answerFile.id)).includes(submitted.id), "…referenced like any other value");
  check(
    (await failure(() => forms.submitForm(ids.member, form.id, { [FORM_TITLE]: "Again", [attachments.id]: [answerFile.url] }))) ===
      "invalidAnswers:invalidFile",
    "an upload can't be sent twice",
  );

  // The upload route, in the app
  const routed = await postFile(`form=${form.id}`, { cookie: memberCookie, "x-file-name": "routed.png", "content-type": "image/png" }, PNG);
  const routedBody = (await routed.json()) as { id: string; url: string };
  check(routed.status === 201 && (await fileRow(routedBody.id))?.pageId === assets.id, "the upload route takes form uploads", routedBody);
  check(
    (await postFile(`form=${form.id}`, { "x-file-name": "x.png" }, PNG)).status === 401,
    "…only signed in, without a public link",
  );

  // Public forms
  const { token: formToken } = await forms.publishForm(ids.owner, form.id, { anonymous: true });
  const now = Date.now();
  const ticket = forms.issueFormTicket(formToken, now - 5_000);
  const who = { userId: null, ip: "10.9.8.7", ticket, now };
  check(
    (await failure(() => forms.uploadPublicFormFile(formToken, { ...who, ticket: "forged" }, input("x.png", PNG)))) === "expired",
    "public uploads need the form's ticket",
  );
  const publicFile = await forms.uploadPublicFormFile(formToken, who, input("public.png", PNG, "image/png"));
  const publicRow = await fileRow(publicFile.id);
  check(publicRow?.pageId === assets.id && publicRow.uploadedBy === null, "an anonymous public upload waits with the database, uploaded by nobody");
  const viaRoute = await postFile(`formToken=${formToken}`, { "x-file-name": "route.png", "content-type": "image/png", "x-form-ticket": ticket }, PNG);
  const viaRouteBody = (await viaRoute.json()) as Record<string, unknown>;
  check(viaRoute.status === 201 && typeof viaRouteBody.url === "string" && !("pageId" in viaRouteBody), "the route takes public uploads without a session", viaRouteBody);
  const publicAnswer = await forms.submitPublicForm(
    formToken,
    { answers: { [FORM_TITLE]: "Public", [attachments.id]: [publicFile.url, viaRouteBody.url as string] }, ticket },
    { userId: null, ip: "10.9.8.7", now },
  );
  check((await valueOf(publicAnswer.id!, attachments.id))?.length === 2, "a public answer attaches its uploads");
  check((await fileRow(publicFile.id))?.pageId === publicAnswer.id, "…to its new row");
  let limited: string | null = null;
  for (let i = 0; i < forms.FORM_FILE_RATE_LIMITS.perIp.limit + 1 && !limited; i++) {
    limited = await failure(() => forms.uploadPublicFormFile(formToken, { ...who, ip: "10.1.1.1" }, input(`n${i}.bin`, bytes(8))));
  }
  check(limited === "rateLimited", "public uploads are rate limited per address");
  const limitedRoute = await postFile(`formToken=${formToken}`, { "x-file-name": "x.bin", "x-form-ticket": ticket, [CLIENT_IP_HEADER]: "10.1.1.1" }, bytes(8));
  const limitedBody = (await limitedRoute.json()) as { code?: string };
  check(limitedRoute.status === 429 && limitedBody.code === "rateLimited", "…and the route answers 429", limitedRoute.status);
  forms.resetFormRateLimits();
  await forms.unpublishForm(ids.owner, form.id);
  check(
    (await failure(() => forms.uploadPublicFormFile(formToken, who, input("late.png", PNG)))) === "closed",
    "a closed link takes no uploads",
  );

  // MCP
  const queried = await callTool(ids.owner, "query_database", {
    database_id: assets.id,
    filters: [{ property: "Attachments", op: "is_not_empty" }],
    sorts: [{ property: "Attachments", direction: "desc" }],
  });
  const firstRow = queried.data?.rows?.[0];
  check(
    !queried.isError &&
      Array.isArray(firstRow?.properties?.Attachments) &&
      firstRow.properties.Attachments.some((f: { name: string; url: string }) => f.name === "photo.png" && f.url === `${env.appUrl}${image.url}`),
    "query_database returns files as [{name, url}] with absolute URLs",
    queried.text,
  );
  const badFilter = await callTool(ids.owner, "query_database", { database_id: assets.id, filters: [{ property: "Attachments", op: "contains", value: "x" }] });
  check(badFilter.isError && /is_empty and is_not_empty/.test(badFilter.text), "…and filters on empty only", badFilter.text);
  const setByMcp = await callTool(ids.owner, "update_database_row", {
    row_id: row2.id,
    properties: { Attachments: [{ name: "whatever", url: `${env.appUrl}${image.url}` }] },
  });
  check(!setByMcp.isError && setByMcp.data.properties.Attachments?.[0]?.name === "photo.png", "update_database_row sets files by URL", setByMcp.text);
  const outside = await callTool(ids.owner, "update_database_row", { row_id: row2.id, properties: { Attachments: ["https://example.com/a.png"] } });
  check(outside.isError && /uploaded/.test(outside.text), "…but not outside URLs", outside.text);
  const attached = await callTool(ids.owner, "attach_file", {
    page_id: row2.id,
    base64: PNG.toString("base64"),
    name: "mcp.png",
    property: "Attachments",
  });
  check(
    !attached.isError && attached.data.property === "Attachments" && attached.data.row.properties.Attachments.length === 2,
    "attach_file adds an upload to a row's files property",
    attached.text,
  );
  check((await refsOf(attached.data.id)).includes(row2.id), "…referenced by the row");
  const wrongProp = await callTool(ids.owner, "attach_file", { page_id: row2.id, base64: PNG.toString("base64"), name: "x.png", property: "Notes" });
  check(wrongProp.isError && /not a files property/.test(wrongProp.text), "…and only to files properties", wrongProp.text);
  const notRow = await callTool(ids.owner, "attach_file", { page_id: secret.id, base64: PNG.toString("base64"), name: "x.png", property: "Attachments" });
  check(notRow.isError && /database rows/.test(notRow.text), "…of database rows", notRow.text);
  const coverView = await callTool(ids.owner, "create_database_view", { database_id: assets.id, name: "Covers", type: "gallery", cover: "attachments" });
  check(!coverView.isError && JSON.stringify(coverView.data).includes('"cover":"Attachments"'), "create_database_view takes a files property as the cover", coverView.text);
  const badCover = await callTool(ids.owner, "create_database_view", { database_id: assets.id, name: "Bad", type: "gallery", cover: "Notes" });
  check(badCover.isError && /files property/.test(badCover.text), "…and nothing else", badCover.text);

  const coverId = gallery.id;
  // Cleanup: deleting a row for good removes the files only it had
  const lone = await upload(ids.owner, row3.id, "lone.png", PNG, "image/png");
  await databases.updateRowProperties(ids.owner, row3.id, { [attachments.id]: [lone.url] });
  await archivePage(ids.owner, row3.id);
  await deletePagePermanently(ids.owner, row3.id);
  check((await fileRow(lone.id)) === null, "deleting a row for good removes files only it held");
  check((await fileRow(pdf.id)) !== null, "…and keeps files other rows hold");

  await databases.deleteProperty(ids.owner, attachments.id);
  const shown = (await databases.getDatabase(ids.owner, assets.id)).views.find((v) => v.id === coverId)!;
  check(shown.config.cover === undefined, "deleting the cover property resets the gallery's cover", shown.config);
  check((await refsOf(image.id)).length > 0, "a deleted property keeps its files for a restore");
  await databases.purgeProperty(ids.owner, attachments.id);
  const [after] = await db.select({ config: databaseView.config }).from(databaseView).where(eq(databaseView.id, coverId));
  check(after.config.cover === undefined, "deleting the property for good drops the gallery's cover", after.config);
  check(!(await refsOf(image.id)).length && (await fileRow(image.id)) !== null, "deleting the property for good drops its references, not the files");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

