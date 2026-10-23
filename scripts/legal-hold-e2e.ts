/**
 * End-to-end check of legal holds against the database: owners put a hold on people (members, and
 * people who have left), and while it stands nothing those people created or edited can be deleted
 * for good, by any path: Delete forever (also for a page above a held one, and for pages held
 * through a version, a file or a comment), the trash's and history's retention, the file cleanups,
 * templates, deleted properties, comments, the workspace and the held people's accounts (and the
 * foreign keys refuse what a missed path would try). Removing a held person keeps their private
 * page. Once the hold is released, each works again. Creates its own users and workspace and
 * deletes them afterwards.
 *
 *   pnpm tsx scripts/legal-hold-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. No server needed.
 */
import { Readable } from "node:stream";

export {};

try {
  process.loadEnvFile();
} catch {}

const { and, eq, inArray } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { auditEvent, databaseProperty, file, legalHold, page, pageSnapshot, user, workspace, workspaceMember } = await import("@/db/schema");
const { LegalHoldError } = await import("@/lib/legal-hold");
const { THREADS_MAP } = await import("@/lib/comments");
const { AccessError, requirePageAccess } = await import("@/server/access");
const { AccountError, deleteAccount } = await import("@/server/account");
const { registerCollab } = await import("@/server/collab/bridge");
const { changeComments } = await import("@/server/comments");
const { purgeProperty } = await import("@/server/databases");
const { purgeOrphanFiles, purgeUnusedUploads, storeFile } = await import("@/server/files");
const { heldPageIds, legalHoldCandidates, listLegalHolds, releaseLegalHold, setLegalHold } = await import("@/server/legal-hold");
const { createPage, deletePagePermanently } = await import("@/server/pages");
const { runRetention } = await import("@/server/retention");
const { instanceStorage } = await import("@/server/storage");
const { deleteTemplate } = await import("@/server/templates");
const { deleteWorkspace } = await import("@/server/workspace-deletion");
const { accountDeletionPlan, removeMember, removeMemberByProvider } = await import("@/server/workspaces");

const RUN = `hold-e2e-${Date.now().toString(36)}`;
const DAY = 24 * 60 * 60 * 1000;

// The comment threads collab would read from the page's live document, by page.
const threads = new Map<string, unknown>();
// Every other collab call does nothing: the collab service only runs inside the app server.
registerCollab(
  new Proxy(
    {},
    {
      get: (_, name) =>
        name === "readThreads" ? async (pageId: string) => threads.get(pageId) ?? [] : name === "openPageIds" ? () => [] : async () => ({}),
    },
  ) as Parameters<typeof registerCollab>[0],
);

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

async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
}
const held = (code: string) => (error: unknown) => error instanceof LegalHoldError && error.code === code;

const ids = { owner: `${RUN}-owner`, ann: `${RUN}-ann`, cy: `${RUN}-cy`, gone: `${RUN}-gone`, bob: `${RUN}-bob` };
const userIds = Object.values(ids);
const ws = `${RUN}-ws`;
const id = (name: string) => `${RUN}-${name}`;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const later = new Date(now.getTime() + 400 * DAY);
const session = (userId: string) => ({ user: { id: userId, name: userId, email: `${userId}@example.test` }, session: { id: `${userId}-s`, createdAt: now } });

async function exists(...pageIds: string[]) {
  const rows = await db.select({ id: page.id }).from(page).where(inArray(page.id, pageIds));
  return pageIds.map((p) => rows.some((r) => r.id === p));
}

/** A page document with one comment thread, written by `userId`. */
function docWithComment(userId: string) {
  const doc = new Y.Doc();
  const thread = new Y.Map<unknown>();
  const comments = new Y.Array<Y.Map<unknown>>();
  const comment = new Y.Map<unknown>();
  comment.set("id", "c1");
  comment.set("userId", userId);
  comments.push([comment]);
  thread.set("id", "t1");
  thread.set("comments", comments);
  doc.getMap(THREADS_MAP).set("t1", thread);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

try {
  await db.insert(user).values(userIds.map((u) => ({ id: u, name: u, email: `${u}@example.test` })));
  await db.insert(workspace).values({ id: ws, name: ws });
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.owner, role: "owner" as const },
    { workspaceId: ws, userId: ids.ann, role: "member" as const },
    { workspaceId: ws, userId: ids.cy, role: "member" as const },
    { workspaceId: ws, userId: ids.bob, role: "member" as const },
  ]);
  const { owner, ann, cy, gone, bob } = ids;
  const trashed = ago(500);
  const P = (name: string, createdBy: string, extra: Partial<typeof page.$inferInsert> = {}) => ({
    id: id(name),
    workspaceId: ws,
    title: name,
    createdBy,
    updatedBy: createdBy,
    archivedAt: trashed,
    ...extra,
  });
  await db.insert(page).values([
    P("annPage", ann),
    P("parent", owner),
    P("byVersion", owner),
    P("byFile", owner),
    P("byComment", owner, { ydoc: docWithComment(ann) }),
    P("goneEdit", owner, { updatedBy: gone }),
    P("free", owner),
    P("freeLater", owner),
    P("template", ann, { archivedAt: null, isTemplate: true, inTemplate: true }),
    P("database", owner, { archivedAt: null, kind: "database" }),
    P("live", owner, { archivedAt: null }),
  ]);
  await db.insert(page).values([
    P("annChild", ann, { parentId: id("parent") }),
    P("row", ann, { archivedAt: null, parentId: id("database") }),
  ]);
  const emptyDoc = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
  await db.insert(pageSnapshot).values([
    { pageId: id("byVersion"), title: "v", ydoc: emptyDoc, reason: "auto", createdBy: owner, createdAt: ago(450) },
    { pageId: id("byVersion"), title: "v", ydoc: emptyDoc, reason: "auto", createdBy: ann, createdAt: ago(400) },
    // "live": an old version by the owner and a newer one, so that history would prune the old one.
    { pageId: id("live"), title: "v", ydoc: emptyDoc, reason: "auto", createdBy: owner, createdAt: ago(400) },
    { pageId: id("live"), title: "v", ydoc: emptyDoc, reason: "auto", createdBy: owner, createdAt: ago(1) },
  ]);
  const upload = (pageId: string | null, by: string) =>
    storeFile({ workspaceId: ws, pageId, uploadedBy: by }, { name: "note.txt", contentType: "text/plain", body: Readable.from([Buffer.from("hold")]), declaredSize: 4 });
  await upload(id("byFile"), ann);
  const annOrphan = await upload(null, ann);
  const ownerOrphan = await upload(null, owner);
  const [deletedProp] = await db
    .insert(databaseProperty)
    .values({ databaseId: id("database"), name: "Old", type: "text", deletedAt: ago(400) })
    .returning({ id: databaseProperty.id });
  const commentOnLive = id("live");
  threads.set(commentOnLive, [{ id: "t1", comments: [{ id: "c1", userId: ann }] }]);

  // ── Setting a hold ───────────────────────────────────────────────────────────────────────────
  check((await failure(() => setLegalHold(bob, ws, { name: "x", reason: "", userIds: [ann] }))) instanceof AccessError, "members can't set a hold");
  check(held("noPeople")(await failure(() => setLegalHold(owner, ws, { name: "Matter", reason: "", userIds: [] }))), "a hold is on someone");
  check(held("unknownPerson")(await failure(() => setLegalHold(owner, ws, { name: "Matter", reason: "", userIds: [`${RUN}-nobody`] }))), "…of this workspace");
  const candidates = await legalHoldCandidates(owner, ws);
  check(
    candidates.some((c) => c.id === gone && c.role === null) && candidates.some((c) => c.id === ann && c.role === "member"),
    "people who left but edited something are offered, beside the members",
    candidates,
  );
  const hold = await setLegalHold(owner, ws, { name: "Matter 1", reason: "Litigation", userIds: [ann, cy, gone] });
  const holds = await listLegalHolds(owner, ws);
  check(holds.length === 1 && holds[0].people.length === 3 && holds[0].createdBy === owner && holds[0].reason === "Litigation", "the hold is listed with its people", holds);
  check((await failure(() => listLegalHolds(bob, ws))) instanceof AccessError, "…to owners only");
  // Read now: the retention run below, months ahead, prunes the audit log too.
  const audited = async () =>
    db.select({ action: auditEvent.action, label: auditEvent.targetLabel }).from(auditEvent).where(eq(auditEvent.workspaceId, ws));
  check((await audited()).some((a) => a.action === "legal_hold.set" && a.label === "Matter 1"), "setting the hold is in the audit log");

  // ── Delete forever ───────────────────────────────────────────────────────────────────────────
  for (const name of ["annPage", "parent", "byVersion", "byFile", "byComment", "goneEdit"]) {
    check(held("pageHeld")(await failure(() => deletePagePermanently(owner, id(name)))), `Delete forever is refused: ${name}`);
  }
  await deletePagePermanently(owner, id("free"));
  check((await exists(id("free"))).join() === "false", "…but works for a page nobody held touched");

  // ── Retention ────────────────────────────────────────────────────────────────────────────────
  const result = await runRetention({ now: later, workspaceIds: [ws] });
  check(result?.heldPages === 6, "the trash's retention keeps held pages", result);
  check(
    (await exists(id("annPage"), id("parent"), id("annChild"), id("byVersion"), id("byFile"), id("byComment"), id("goneEdit"))).every(Boolean),
    "…they are all still there, subpages included",
  );
  check((await exists(id("freeLater"))).join() === "false", "…and deletes the rest");
  check((await db.select().from(pageSnapshot).where(eq(pageSnapshot.pageId, id("byVersion")))).length === 2, "history keeps the versions of held pages");
  check(result.deletedProperties === 0 && (await db.select().from(databaseProperty).where(eq(databaseProperty.id, deletedProp.id))).length === 1, "a deleted property with held values stays");
  check((await db.select().from(pageSnapshot).where(eq(pageSnapshot.pageId, id("live")))).length === 1, "history of pages not held is pruned as usual");

  // ── Files ────────────────────────────────────────────────────────────────────────────────────
  await purgeOrphanFiles(ws);
  await purgeUnusedUploads({ workspaceId: ws, olderThanMs: 0 });
  const files = (await db.select({ id: file.id }).from(file).where(eq(file.workspaceId, ws))).map((f) => f.id);
  check(files.includes(annOrphan.id) && !files.includes(ownerOrphan.id), "the file cleanups keep held people's uploads", files);

  // ── Templates, properties, comments ──────────────────────────────────────────────────────────
  check(held("templateHeld")(await failure(() => deleteTemplate(owner, id("template")))), "deleting a held template is refused");
  check(held("propertyHeld")(await failure(() => purgeProperty(owner, deletedProp.id))), "deleting a property with held values for good is refused");
  check(held("commentHeld")(await failure(() => changeComments(owner, commentOnLive, { type: "deleteComment", threadId: "t1", commentId: "c1" }))), "deleting a held comment is refused");
  check(held("commentHeld")(await failure(() => changeComments(owner, commentOnLive, { type: "deleteThread", threadId: "t1" }))), "…and its thread");

  // ── The workspace and the accounts ───────────────────────────────────────────────────────────
  check(
    held("workspaceHeld")(await failure(() => deleteWorkspace(session(owner), ws, { confirmation: ws, proof: { password: "x" } }))),
    "deleting the workspace is refused",
  );
  check((await failure(() => db.delete(workspace).where(eq(workspace.id, ws)))) !== null, "…and so is a delete that skips the check");
  const annPlan = await accountDeletionPlan(ann);
  check(annPlan.legalHolds?.some((w) => w.id === ws), "deleting a held person's account is refused…", annPlan);
  const accountError = await failure(() => deleteAccount(session(ann), { confirmation: `${ann}@example.test`, proof: { password: "x" } }));
  check(accountError instanceof AccountError && accountError.code === "legalHold", "…with the workspace named", String(accountError));
  check((await accountDeletionPlan(gone)).legalHolds?.length === 1, "…also for someone who left");
  check((await failure(() => db.delete(user).where(eq(user.id, ann)))) !== null, "…and a delete that skips the check");

  // ── Removing held people ─────────────────────────────────────────────────────────────────────
  const privatePage = await createPage({ userId: ann }, { workspaceId: ws, teamspaceId: null, title: "ann's own" });
  const scimPage = await createPage({ userId: cy }, { workspaceId: ws, teamspaceId: null, title: "cy's own" });
  await removeMember(owner, ws, ann);
  await removeMemberByProvider(ws, cy);
  check((await exists(privatePage.id, scimPage.id)).every(Boolean), "removing held people (by an owner, over SCIM) keeps their private pages");
  check(Boolean(await requirePageAccess(owner, privatePage.id, "full")), "…which the owner takes over");
  check((await heldPageIds(ws, [privatePage.id, scimPage.id])).size === 2, "…and the hold still keeps them");

  // ── Released ─────────────────────────────────────────────────────────────────────────────────
  check((await failure(() => releaseLegalHold(bob, ws, hold.id))) instanceof AccessError, "members can't release a hold");
  await releaseLegalHold(owner, ws, hold.id);
  check(held("notFound")(await failure(() => releaseLegalHold(owner, ws, hold.id))), "a released hold is gone");
  check((await audited()).some((a) => a.action === "legal_hold.released" && a.label === "Matter 1"), "…and so is releasing it");
  await deletePagePermanently(owner, id("annPage"));
  check((await exists(id("annPage"))).join() === "false", "Delete forever works again");
  const after = await runRetention({ now: later, workspaceIds: [ws] });
  check(after?.heldPages === 0 && (await exists(id("parent"), id("byVersion"), id("byFile"), id("byComment"), id("goneEdit"))).every((e) => !e), "…and so does retention", after);
  check((await db.select().from(databaseProperty).where(eq(databaseProperty.id, deletedProp.id))).length === 0, "…for deleted properties too");
  await purgeOrphanFiles(ws);
  check((await db.select().from(file).where(and(eq(file.workspaceId, ws), eq(file.id, annOrphan.id)))).length === 0, "the file cleanups remove the upload");
  await deleteTemplate(owner, id("template"));
  check((await exists(id("template"))).join() === "false", "the template can be deleted");
  check((await failure(() => changeComments(owner, commentOnLive, { type: "deleteComment", threadId: "t1", commentId: "c1" }))) === null, "the comment can be deleted");
  check(!(await accountDeletionPlan(gone)).legalHolds, "the account isn't kept any more");
  // Last: the session just made counts as a fresh sign-in, so the workspace really goes.
  const wsError = await failure(() => deleteWorkspace(session(owner), ws, { confirmation: ws, proof: { password: "x" } }));
  check(wsError === null && !(await db.select().from(workspace).where(eq(workspace.id, ws))).length, "the workspace can be deleted", String(wsError));

  console.log(`\n${passed} checks passed`);
} finally {
  const left = await db.select({ key: file.storageKey }).from(file).where(eq(file.workspaceId, ws));
  for (const { key } of left) await instanceStorage().delete(key).catch(() => {});
  await db.delete(legalHold).where(eq(legalHold.workspaceId, ws));
  await db.delete(workspace).where(eq(workspace.id, ws));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
