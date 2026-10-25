/**
 * End-to-end check of who may read a file a page shows: a file's URL written into a page (through
 * the REST API, the operations MCP and the API share, or a direct document connection like the
 * editor's) lets the page's viewers read the file only when the writer could read it already
 * (authorized file references); copies (Duplicate, templates) keep what their source showed and
 * nothing more; exports and published pages follow the same references; and a file a row holds only
 * in a files property hidden by property access isn't served to those it is hidden from.
 * Creates its own users and workspace, stores files in a temporary directory, and deletes all of it
 * afterwards.
 *
 *   pnpm tsx scripts/files-body-e2e.ts
 *
 * Env: DATABASE_URL and BETTER_AUTH_SECRET (read from .env when present). Migrations must be applied.
 */
import { API_TOKEN_SCOPES as ALL_SCOPES } from "@/lib/api-scopes";

try {
  process.loadEnvFile();
} catch {}

const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Readable } = await import("node:stream");

const uploadDir = await mkdtemp(join(tmpdir(), "leafdesk-files-body-e2e-"));
process.env.STORAGE_DRIVER = "local";
process.env.UPLOAD_DIR = uploadDir;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { file, fileReference, user, workspace, workspaceMember } = await import("@/db/schema");
const { env } = await import("@/lib/env");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { markdownToBlocks, serverEditor } = await import("@/server/blocknote");
const { createPage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { createFromTemplate, saveAsTemplate } = await import("@/server/templates");
const { setPagePermission } = await import("@/server/permissions");
const { publishPage } = await import("@/server/publication");
const { setPropertyAccess } = await import("@/server/property-access");
const { planExport } = await import("@/server/export");
const { handleApiRequest } = await import("@/server/api");
const { createApiToken } = await import("@/server/api/tokens");
const ops = await import("@/server/operations");
const databases = await import("@/server/databases");
const files = await import("@/server/files");
const fileRoute = await import("@/app/api/files/[id]/route");

const RUN = `files-body-e2e-${Date.now().toString(36)}`;
console.log(`database: ${new URL(process.env.DATABASE_URL!).pathname.slice(1)}`);

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

const bytes = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const PNG = (seed: number) => Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), bytes(200, seed)]);
const upload = (userId: string, pageId: string, name: string, seed: number) =>
  files.uploadFile(userId, pageId, { name, contentType: "image/png", body: Readable.from([PNG(seed)]), declaredSize: PNG(seed).length });
const canRead = async (userId: string | null, fileId: string) => (await files.fileForViewer(userId, fileId)) !== null;
const servedAnonymously = async (fileId: string) =>
  (await fileRoute.GET(new Request(`http://files-body-e2e.localhost/api/files/${fileId}`), { params: Promise.resolve({ id: fileId }) })).status === 200;
const reference = async (pageId: string, fileId: string) =>
  (
    await db
      .select({ authorized: fileReference.authorized })
      .from(fileReference)
      .where(and(eq(fileReference.pageId, pageId), eq(fileReference.fileId, fileId)))
  )[0] ?? null;
const image = (url: string) => `![picture](${url})`;

/** Calls the REST API in this process, with a token of whoever made it. */
async function rest(token: string, method: string, path: string, body?: unknown) {
  const res = await handleApiRequest(
    new Request(`${env.appUrl}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return { status: res.status, body: (await res.json()) as { id?: string } };
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, guest: `${RUN}-guest` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const owner = { userId: ids.owner };
  const member = { userId: ids.member };
  const ownerCtx = { userId: ids.owner, actor: owner };
  const memberCtx = { userId: ids.member, actor: member };

  // A page only the owner sees, with an image on it.
  const secret = await createPage(owner, { workspaceId, title: "Secret" });
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");
  const secretFile = await upload(ids.owner, secret.id, "secret.png", 1);
  check(await canRead(ids.owner, secretFile.id), "the owner reads the file of their page");
  check(!(await canRead(ids.member, secretFile.id)), "a member who can't see the page can't");

  // The member writes its URL into a page of their own, every way a body is written.
  const mine = await createPage(member, { workspaceId, title: "Mine" });
  await ops.updatePage(memberCtx, { page_id: mine.id, markdown: image(secretFile.url), mode: "replace" });
  check((await reference(mine.id, secretFile.id))?.authorized === false, "the trigger records the URL the member wrote, unauthorized");
  check(!(await canRead(ids.member, secretFile.id)), "…so writing the URL through the operations grants the member nothing");
  await ops.updatePage(memberCtx, { page_id: mine.id, markdown: `Again\n\n${image(`${env.appUrl}${secretFile.url}`)}`, mode: "append" });
  check((await reference(mine.id, secretFile.id))?.authorized === false, "…an absolute URL just the same");
  check(!(await canRead(ids.member, secretFile.id)), "…nor appending its absolute URL");

  const { secret: memberToken } = await createApiToken(ids.member, { name: RUN, scopes: ALL_SCOPES });
  const viaRest = await rest(memberToken, "POST", "/pages", { workspace_id: workspaceId, title: "Via REST", markdown: image(secretFile.url) });
  check(viaRest.status === 201 && viaRest.body.id, "the REST API creates a page whose body holds the URL", viaRest);
  const patched = await rest(memberToken, "PATCH", `/pages/${mine.id}`, { markdown: `REST\n\n${image(secretFile.url)}` });
  check(patched.status === 200, "…and replaces a body with it", patched);
  check((await reference(viaRest.body.id!, secretFile.id))?.authorized === false, "…unauthorized either way");
  check(!(await canRead(ids.member, secretFile.id)), "…so the REST API grants the member nothing either");

  // A direct document connection, as the editor's saves take.
  const conn = await hocuspocus.openDirectConnection(`page:${mine.id}`, member);
  const pasted = await markdownToBlocks(image(secretFile.url));
  await conn.transact((doc) => {
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    serverEditor.blocksToYXmlFragment([...serverEditor.yXmlFragmentToBlocks(fragment), ...pasted] as never, fragment);
  });
  await conn.disconnect();
  check(!(await canRead(ids.member, secretFile.id)), "…nor does pasting it in a live document");

  // Publishing and exporting the page don't reach the file.
  await publishPage(ids.member, mine.id);
  check(!(await servedAnonymously(secretFile.id)), "visitors of the member's published page don't get the file");
  const exported = await planExport(ids.member, { pageId: mine.id });
  check(!exported.files.some((f) => f.id === secretFile.id), "an export of the page leaves the file out", exported.files);
  const memberCopy = await duplicatePage(member, mine.id);
  check((await reference(memberCopy.id, secretFile.id))?.authorized === false, "a duplicate of the page carries the URL unauthorized");
  check(!(await canRead(ids.member, secretFile.id)), "…so duplicating doesn't launder it");

  // Someone who can read the file writes it: the page's viewers read it.
  const shared = await createPage(owner, { workspaceId, title: "Shared" });
  await setPagePermission(ids.owner, shared.id, ids.owner, "full");
  await setPagePermission(ids.owner, shared.id, null, "none");
  await setPagePermission(ids.owner, shared.id, ids.guest, "view");
  check(!(await canRead(ids.guest, secretFile.id)), "a guest can't read the secret file");
  await ops.updatePage(ownerCtx, { page_id: shared.id, markdown: `Look\n\n${image(secretFile.url)}`, mode: "replace" });
  check((await reference(shared.id, secretFile.id))?.authorized === true, "the owner's write authorizes the reference");
  check(await canRead(ids.guest, secretFile.id), "…so the guest who sees that page reads the file");
  check(!(await canRead(ids.member, secretFile.id)), "…and the member, who doesn't see it, still can't");
  const guestExport = await planExport(ids.owner, { pageId: shared.id });
  check(guestExport.files.some((f) => f.id === secretFile.id), "an export of the owner's page has the file");

  // Copies keep what their source showed.
  const ownerCopy = await duplicatePage(owner, shared.id);
  await setPagePermission(ids.owner, shared.id, ids.guest, "none");
  check((await reference(ownerCopy.id, secretFile.id))?.authorized === true, "a duplicate of the owner's page authorizes the copy's reference");
  check(await canRead(ids.guest, secretFile.id), "…so the guest reads the file through the copy alone");
  await setPagePermission(ids.owner, ownerCopy.id, ids.guest, "none");
  check(!(await canRead(ids.guest, secretFile.id)), "…and not once they lose the copy too");

  const template = await saveAsTemplate(owner, shared.id);
  const fromTemplate = await createFromTemplate(owner, template.id, { title: "From template" });
  check((await reference(fromTemplate.id, secretFile.id))?.authorized === true, "a page made from a template shows the template's files");
  await setPagePermission(ids.owner, fromTemplate.id, ids.guest, "view");
  check(await canRead(ids.guest, secretFile.id), "…to whoever sees that page");
  await setPagePermission(ids.owner, fromTemplate.id, ids.guest, "none");

  // Several people in one save: the files count when one of them could read them.
  const together = await createPage(owner, { workspaceId, title: "Together" });
  await setPagePermission(ids.owner, together.id, ids.member, "edit");
  const second = await upload(ids.owner, secret.id, "second.png", 2);
  const ownerConn = await hocuspocus.openDirectConnection(`page:${together.id}`, owner);
  const ownerPaste = await markdownToBlocks(image(second.url));
  await ownerConn.transact((doc) => {
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    serverEditor.blocksToYXmlFragment([...serverEditor.yXmlFragmentToBlocks(fragment), ...ownerPaste] as never, fragment);
  });
  // The member's change comes last and saves the document at once, the owner's paste with it.
  await service.appendContent(together.id, "The member typed this.", member);
  await ownerConn.disconnect();
  check((await reference(together.id, second.id))?.authorized === true, "a save that holds a co-editor's paste counts the co-editor");
  check(await canRead(ids.member, second.id), "…so the member who edits that page reads the owner's file");

  // A file of the page itself always counts.
  const own = await upload(ids.member, mine.id, "own.png", 3);
  await ops.updatePage(memberCtx, { page_id: mine.id, markdown: image(own.url), mode: "append" });
  check(await canRead(ids.member, own.id), "a file uploaded to the page shows on it");
  check(await servedAnonymously(own.id), "…and to visitors of the published page");

  // Existing content keeps working: references made before authorization existed are authorized.
  const legacy = await upload(ids.owner, secret.id, "legacy.png", 4);
  const old = await createPage(owner, { workspaceId, title: "Old" });
  await setPagePermission(ids.owner, old.id, ids.guest, "view");
  await ops.updatePage(ownerCtx, { page_id: old.id, markdown: image(legacy.url), mode: "replace" });
  // Made before authorization existed: drizzle/0053 gives such references the column as true.
  await db.update(fileReference).set({ authorized: false }).where(eq(fileReference.pageId, old.id));
  check(!(await canRead(ids.guest, legacy.id)), "setup: an unauthorized reference serves nothing");
  await db.execute(sql`update ${fileReference} set authorized = true where page_id = ${old.id}`);
  check(await canRead(ids.guest, legacy.id), "a reference from before the migration keeps serving its file");
  await ops.updatePage(ownerCtx, { page_id: old.id, markdown: `Edited\n\n${image(legacy.url)}`, mode: "replace" });
  check((await reference(old.id, legacy.id))?.authorized === true && (await canRead(ids.guest, legacy.id)), "…and stays authorized through later edits");

  // Property access: a file held only in a hidden files value isn't served through that row.
  const vault = await createPage(owner, { workspaceId, kind: "database", title: "Vault" });
  await setPagePermission(ids.owner, vault.id, ids.owner, "full");
  await setPagePermission(ids.owner, vault.id, null, "none");
  await setPagePermission(ids.owner, vault.id, ids.member, "edit");
  const hiddenProp = await databases.addProperty(ids.owner, vault.id, { name: "Contract", type: "files" });
  const openProp = await databases.addProperty(ids.owner, vault.id, { name: "Photo", type: "files" });
  await setPropertyAccess(ids.owner, hiddenProp.id, { everyone: "none", exceptions: [] });
  const [vaultRow] = await databases.createRows(ids.owner, vault.id, [{ title: "Deal" }]);
  const contract = await upload(ids.owner, vaultRow.id, "contract.png", 5);
  const photo = await upload(ids.owner, vaultRow.id, "photo.png", 6);
  await databases.updateRowProperties(ids.owner, vaultRow.id, { [hiddenProp.id]: [contract.url], [openProp.id]: [photo.url] });
  check(await canRead(ids.owner, contract.id), "the owner reads a file of a restricted files property");
  check(await canRead(ids.member, photo.id), "a member reads a file of a files property they see");
  check(!(await canRead(ids.member, contract.id)), "…but not one held only in a property hidden from them");
  await publishPage(ids.owner, vault.id);
  check(await servedAnonymously(photo.id), "visitors of the published database get the files it shows");
  check(!(await servedAnonymously(contract.id)), "…but not those of a property hidden from everyone");
  await ops.updatePage(ownerCtx, { page_id: vaultRow.id, markdown: image(contract.url), mode: "replace" });
  check(await canRead(ids.member, contract.id), "a row whose body shows the file serves it to whoever sees the row");
  await setPropertyAccess(ids.owner, hiddenProp.id, { everyone: "inherit", exceptions: [] });
  await ops.updatePage(ownerCtx, { page_id: vaultRow.id, markdown: "No image", mode: "replace" });
  check(await canRead(ids.member, contract.id), "lifting the restriction serves the property's file again");

  // A member's body write into a row they edit grants nothing either.
  const unseen = await upload(ids.owner, secret.id, "unseen.png", 8);
  check(!(await canRead(ids.member, unseen.id)), "a member can't read another file of the secret page");
  await ops.updatePage(memberCtx, { page_id: vaultRow.id, markdown: image(unseen.url), mode: "replace" });
  check((await reference(vaultRow.id, unseen.id))?.authorized === false, "a member's write of its URL into a row stays unauthorized");
  check(!(await canRead(ids.member, unseen.id)), "…and the member still can't read it");

  // Orphans: a file nobody can read anymore goes, even when an unauthorized URL still names it.
  const doomed = await upload(ids.owner, secret.id, "doomed.png", 7);
  await ops.updatePage(memberCtx, { page_id: mine.id, markdown: image(doomed.url), mode: "append" });
  await db.update(file).set({ pageId: null }).where(eq(file.id, doomed.id));
  await files.purgeOrphanFiles(workspaceId);
  check(
    !(await db.select().from(file).where(inArray(file.id, [doomed.id]))).length,
    "a file shown only without authorization is cleaned up once its page is gone",
  );

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  await rm(uploadDir, { recursive: true, force: true });
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
