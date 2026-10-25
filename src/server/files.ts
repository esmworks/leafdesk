import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiChatFile, file, fileReference, page, propertyPermission, storageDeletion, workspaceStorage } from "@/db/schema";
import { cleanFileName, contentTypeFor, fileIdsIn, fileIdsInProperties, fileUrl, formatBytes, isFileId } from "@/lib/files";
import { COMMENT_IMAGE_TYPES } from "@/lib/comments";
import { sameLocation } from "@/lib/workspace-storage";
import { AccessError, accessRank, requireMembership, requirePageAccess, sessionHeldBack } from "@/server/access";
import { queueDocument } from "@/server/file-text";
import { uploadUnderHold } from "@/server/legal-hold";
import { propertyAccessFor } from "@/server/property-access";
import { anyPagePublished } from "@/server/publication";
import { fetchRemoteFile, RemoteFetchError, type RemoteFetchOptions } from "@/server/remote-fetch";
import { StorageError, uploadLimits } from "@/server/storage";
import { loadTargets, refOf, removeRetiredStorage, storageFor, storageOf, storageResolver, targetLocation, type StoredObject } from "@/server/storage/workspace";

/**
 * Uploaded files (images, video, audio and attachments in page bodies, and the values of files
 * properties of database rows).
 *
 * Where: in the workspace's own storage while it has one connected, the instance's otherwise (see
 * storage/workspace.ts); a file stays where it was stored. Only the instance's storage has a quota.
 *
 * Storing: uploading needs edit access to the page the file goes on. Files for a row's files
 * property are uploaded to the row itself; files attached to a form answer are held by the form's
 * database until the answer creates its row, which then takes them over (see forms.ts). The bytes are counted while
 * they arrive and the upload stops as soon as it passes the per-file limit or the workspace's
 * remaining quota; the quota is checked again, under a per-workspace lock, before the file is
 * recorded, so concurrent uploads can't overshoot it.
 *
 * Reading (see `fileForViewer`): a file is readable by someone who can view
 *  - the page it was uploaded to, or
 *  - any page of the same workspace whose body shows it, or any row of the same workspace whose
 *    files property holds it (`file_reference`, kept by a trigger for both), once that reference is
 *    authorized.
 * The trigger records every file URL a page shows, whoever wrote it there; a reference is
 * authorized by the write that made it, when the writer could read the file already (see
 * authorizeFileReferences): the editor's saves and the server's own body writes (collab store
 * hook), row values (databases.afterRowWrites), and copies of pages the writer could read
 * (inheritFileReferences). So knowing a file's URL alone never grants anything: ids are
 * unguessable, and writing one into a page lets nobody read a file the writer couldn't read.
 * Copies of a page (Duplicate, templates, pasting blocks) share the stored file rather than copying
 * it; the second rule is what lets people who see only the copy load it.
 * In a row of a database with property access rules, a file its files values hold counts only for
 * people who may see one of those values (or for whom its body shows the file too), as in exports.
 * Visitors of a published page (signed in or not) may read files of pages that the publication
 * serves (see publication.anyPagePublished), by the same rules, with the property access of
 * visitors.
 *
 * Cleanup: deleting a page for good clears `file.page_id`; once no page shows such a file anymore
 * it is removed (right away, and by the hourly sweep). Uploads that no page ever showed are removed
 * after a day. A file that was shown once and then taken out of the body (or removed from a files
 * property) stays while its page exists, so restoring an older version of the page, or putting the
 * file back, brings it back.
 */

export class FileError extends Error {
  constructor(
    message: string,
    readonly code: "tooLarge" | "quotaExceeded" | "notAllowed" | "badRequest" | "fetchFailed" | "storageFailed",
    /** The limit that was hit, in bytes, for tooLarge and quotaExceeded. */
    readonly limit?: number,
  ) {
    super(message);
    this.name = "FileError";
  }
}

export type StoredFile = {
  id: string;
  url: string;
  name: string;
  contentType: string;
  size: number;
  pageId: string;
  workspaceId: string;
};

export type FileRow = typeof file.$inferSelect;

/** Bytes the workspace's files take up in the instance's storage (what its quota counts). */
export async function workspaceUsage(workspaceId: string, tx: Tx | typeof db = db): Promise<number> {
  const [row] = await tx
    .select({ used: sql<string>`coalesce(sum(${file.size}), 0)` })
    .from(file)
    .where(and(eq(file.workspaceId, workspaceId), isNull(file.storageId)));
  return Number(row?.used ?? 0);
}

class LimitExceeded extends Error {}

/** Writes `body` to a temporary file, failing as soon as it passes `limit` bytes. */
async function spool(body: Readable, limit: number): Promise<{ path: string; size: number; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "leafdesk-upload-"));
  const path = join(dir, "body");
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) callback(new LimitExceeded());
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, createWriteStream(path));
    return { path, size, dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export type UploadInput = {
  name: unknown;
  contentType?: unknown;
  body: Readable | ReadableStream<Uint8Array>;
  /** Content-Length or similar, when known: a larger upload is refused before reading it. */
  declaredSize?: number | null;
};

/** Stores a file on a page; needs edit access to it. */
export async function uploadFile(userId: string, pageId: string, input: UploadInput): Promise<StoredFile> {
  const target = await requirePageAccess(userId, pageId, "content");
  if (target.archivedAt) throw new FileError("The page is in the trash", "notAllowed");
  if (target.kind === "database") throw new FileError("Databases have no body to put files in; add them to a row", "badRequest");
  return storeFile({ workspaceId: target.workspaceId, pageId, uploadedBy: userId }, input);
}

/**
 * Stores an image to attach to a comment on a page (lib/comments CommentImages): needs only
 * comment access, and takes only the kinds of image in COMMENT_IMAGE_TYPES.
 */
export async function uploadCommentImage(userId: string, pageId: string, input: UploadInput): Promise<StoredFile> {
  const target = await requirePageAccess(userId, pageId, "comment");
  if (target.archivedAt) throw new FileError("The page is in the trash", "notAllowed");
  if (!COMMENT_IMAGE_TYPES.includes(contentTypeFor(input.contentType, cleanFileName(input.name)))) {
    throw new FileError("Comments take PNG, JPEG, GIF, WebP or AVIF images", "badRequest");
  }
  return storeFile({ workspaceId: target.workspaceId, pageId, uploadedBy: userId }, input);
}

/**
 * Of the files `fileIds`, the images stored on `pageId` (those a comment there may show), marked
 * as used, so the cleanup of uploads nothing showed leaves them (they stay with the page).
 */
export async function commentImagesOn(pageId: string, fileIds: string[]): Promise<Set<string>> {
  if (!fileIds.length) return new Set();
  const found = await db
    .update(file)
    .set({ referencedAt: sql`coalesce(${file.referencedAt}, now())` })
    .where(and(eq(file.pageId, pageId), inArray(file.id, fileIds), inArray(file.contentType, COMMENT_IMAGE_TYPES)))
    .returning({ id: file.id });
  return new Set(found.map((f) => f.id));
}

/**
 * Stores a file on `pageId` of `workspaceId` within the upload limits. No access check: callers
 * decide who may put files where (uploadFile for pages and rows, forms.uploadFormFile for form
 * answers). `uploadedBy` is null for anonymous form answers. A file on no page (`pageId` null)
 * is held by what `record` writes in the same transaction as its row (ai-chat-files.ts), or the
 * cleanup takes it.
 */
export async function storeFile<P extends string | null = string>(
  {
    workspaceId,
    pageId,
    uploadedBy,
    record,
  }: { workspaceId: string; pageId: P; uploadedBy: string | null; record?: (tx: Tx, fileId: string) => Promise<void> },
  input: UploadInput,
  limits: { maxBytes?: number } = {},
): Promise<Omit<StoredFile, "pageId"> & { pageId: P }> {
  const name = cleanFileName(input.name);
  const contentType = contentTypeFor(input.contentType, name);

  const maxFileBytes = Math.min(uploadLimits().maxFileBytes, limits.maxBytes ?? Infinity);
  const target = await storageFor(workspaceId);
  const workspaceQuotaBytes = target.quotaBytes;
  const quota = workspaceQuotaBytes !== Infinity;
  const tooLarge = () => new FileError(`Files can be at most ${formatBytes(maxFileBytes)}`, "tooLarge", maxFileBytes);
  const overQuota = () =>
    new FileError(`This workspace has used its ${formatBytes(workspaceQuotaBytes)} of file storage`, "quotaExceeded", workspaceQuotaBytes);
  const room = quota ? workspaceQuotaBytes - (await workspaceUsage(workspaceId)) : Infinity;
  const declared = input.declaredSize ?? null;
  if (declared !== null && declared > maxFileBytes) throw tooLarge();
  if (room <= 0 || (declared !== null && declared > room)) throw overQuota();

  const body = input.body instanceof Readable ? input.body : Readable.fromWeb(input.body as import("node:stream/web").ReadableStream<Uint8Array>);
  let spooled: Awaited<ReturnType<typeof spool>>;
  try {
    spooled = await spool(body, Math.min(maxFileBytes, room));
  } catch (error) {
    if (error instanceof LimitExceeded) throw room < maxFileBytes ? overQuota() : tooLarge();
    throw error;
  }

  try {
    const id = randomBytes(18).toString("base64url");
    const storageKey = `${workspaceId}/${id}`;
    const storageId = target.storageId;
    await db.transaction(async (tx) => {
      if (quota) {
        // One upload at a time per workspace gets past this point, so the sum below is current.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:file-quota:${workspaceId}`}))`);
        if ((await workspaceUsage(workspaceId, tx)) + spooled.size > workspaceQuotaBytes) throw overQuota();
      }
      await tx.insert(file).values({ id, workspaceId, pageId, storageKey, storageId, name, contentType, size: spooled.size, uploadedBy });
      await record?.(tx, id);
    });
    let storageObjectId: string | null = null;
    try {
      const put = await target.driver.put(storageKey, createReadStream(/*turbopackIgnore: true*/ spooled.path), { size: spooled.size, contentType });
      if (put) {
        storageObjectId = put;
        await db.update(file).set({ storageObjectId }).where(eq(file.id, id));
      }
    } catch (error) {
      await db.delete(file).where(eq(file.id, id));
      // The workspace's own storage refused it: say so (Settings > Storage shows why).
      if (storageId && error instanceof StorageError) {
        console.warn(`[files] the storage of workspace ${workspaceId} refused an upload`, error.message);
        throw new FileError("The workspace's storage didn't take the file", "storageFailed");
      }
      throw error;
    }
    // A PDF, Word document or Excel workbook is read in the background, so search finds its words.
    queueDocument({ id, name, contentType, size: spooled.size, storageKey, storageId, storageObjectId });
    return { id, url: fileUrl(id), name, contentType, size: spooled.size, pageId, workspaceId };
  } finally {
    await rm(spooled.dir, { recursive: true, force: true });
  }
}

/**
 * Downloads a file from a URL someone gave (MCP) and stores it on the page. The download refuses
 * private and loopback addresses (see remote-fetch.ts) and stops at the upload limit.
 */
export async function uploadFromUrl(
  userId: string,
  pageId: string,
  url: string,
  { name, contentType, fetchOptions }: { name?: string; contentType?: string; fetchOptions?: Partial<RemoteFetchOptions> } = {},
): Promise<StoredFile> {
  // Check access before reaching out anywhere.
  await requirePageAccess(userId, pageId, "content");
  const { maxFileBytes } = uploadLimits();
  let remote;
  try {
    remote = await fetchRemoteFile(url, { maxBytes: maxFileBytes, timeoutMs: 30_000, ...fetchOptions });
  } catch (error) {
    if (error instanceof RemoteFetchError) {
      if (error.code === "tooLarge") throw new FileError(`Files can be at most ${formatBytes(maxFileBytes)}`, "tooLarge", maxFileBytes);
      throw new FileError(`Couldn't fetch the file: ${error.message}`, "fetchFailed");
    }
    throw error;
  }
  try {
    return await uploadFile(userId, pageId, {
      name: name ?? remote.name,
      contentType: contentType ?? remote.contentType,
      body: remote.body,
      declaredSize: remote.size,
    });
  } catch (error) {
    if (error instanceof RemoteFetchError) throw new FileError(`Couldn't fetch the file: ${error.message}`, "fetchFailed");
    throw error;
  } finally {
    remote.body.destroy();
  }
}

/**
 * The file, when `userId` (null for visitors who aren't signed in) may read it; null otherwise,
 * the same way whether it is missing or just not theirs. See the rules at the top of this module.
 */
export async function fileForViewer(userId: string | null, fileId: string): Promise<FileRow | null> {
  if (!isFileId(fileId)) return null;
  const [found] = await db.select().from(file).where(eq(file.id, fileId)).limit(1);
  if (!found) return null;
  const pages = await pagesShowing(found);
  // A workspace whose two-step policy holds back this session shows only what it published.
  if (userId && pages.length && !(await sessionHeldBack(userId, found.workspaceId))) {
    const visible = await db
      .select({ id: page.id })
      .from(page)
      .where(and(inArray(page.id, pages), sql`${accessRank(userId, sql`${page.id}`)} > 0`));
    if ((await showingTo(userId, found.id, visible.map((v) => v.id))).length) return found;
  }
  return (await anyPagePublished(await showingTo(null, found.id, pages))) ? found : null;
}

/**
 * Of `pageIds`, those that show the file to `viewer` (null: visitors of a published page) under
 * property access: a row of a database with rules shows a file its files values hold only when the
 * viewer may see one of those values, or its body shows the file too (see export.visibleFileIds).
 * Pages that hold the file in no value (its body shows it, or it was uploaded there and not
 * attached yet) show it as they are.
 */
async function showingTo(viewer: string | null, fileId: string, pageIds: string[]): Promise<string[]> {
  if (!pageIds.length) return [];
  const withRules = db.selectDistinct({ id: propertyPermission.databaseId }).from(propertyPermission);
  const rows = await db
    .select({ id: page.id, parentId: page.parentId, properties: page.properties, createdBy: page.createdBy, contentMarkdown: page.contentMarkdown })
    .from(page)
    .where(and(inArray(page.id, pageIds), inArray(page.parentId, withRules)));
  const hidden = new Set<string>();
  for (const row of rows) {
    if (!fileIdsInProperties(row.properties).includes(fileId) || fileIdsIn(row.contentMarkdown).includes(fileId)) continue;
    const access = await propertyAccessFor(viewer, row.parentId!);
    if (access.open) continue;
    const [shown] = access.strip([{ properties: row.properties ?? {}, createdBy: row.createdBy }]);
    if (!fileIdsInProperties(shown.properties).includes(fileId)) hidden.add(row.id);
  }
  return pageIds.filter((id) => !hidden.has(id));
}

/**
 * Authorizes the references of `pageId` (to `fileIds`, or all of them) that aren't yet, for the
 * files one of `userIds` may read already (fileForViewer, which doesn't count these references
 * while they aren't authorized). Called after a write that may have put a file's URL into the page,
 * with whoever made it; returns how many references it authorized.
 */
export async function authorizeFileReferences(
  userIds: Iterable<string | null | undefined>,
  pageId: string,
  fileIds?: string[],
): Promise<number> {
  const who = [...new Set([...userIds].filter((id): id is string => Boolean(id)))];
  if (!who.length || (fileIds && !fileIds.length)) return 0;
  const pending = await db
    .select({ fileId: fileReference.fileId })
    .from(fileReference)
    .where(
      and(
        eq(fileReference.pageId, pageId),
        eq(fileReference.authorized, false),
        fileIds ? inArray(fileReference.fileId, fileIds) : undefined,
      ),
    );
  const readable: string[] = [];
  for (const { fileId } of pending) {
    for (const userId of who) {
      if (await fileForViewer(userId, fileId)) {
        readable.push(fileId);
        break;
      }
    }
  }
  if (readable.length) {
    await db
      .update(fileReference)
      .set({ authorized: true })
      .where(and(eq(fileReference.pageId, pageId), inArray(fileReference.fileId, readable)));
  }
  return readable.length;
}

/** Files `pageId` references without authorization yet (see authorizeFileReferences). */
export async function unauthorizedFileIds(pageId: string): Promise<string[]> {
  const rows = await db
    .select({ fileId: fileReference.fileId })
    .from(fileReference)
    .where(and(eq(fileReference.pageId, pageId), eq(fileReference.authorized, false)));
  return rows.map((r) => r.fileId);
}

/** Files `pageId` references, authorized or not. */
export async function referencedFileIds(pageId: string): Promise<string[]> {
  const rows = await db.select({ fileId: fileReference.fileId }).from(fileReference).where(eq(fileReference.pageId, pageId));
  return rows.map((r) => r.fileId);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Copies of pages (Duplicate, templates; `id` the copy, `sourceId` its source) show what their
 * source showed: a copy's reference is authorized where its source's was, or where the source is
 * the page the file was uploaded to. A URL its source showed without authorization stays so.
 */
export async function inheritFileReferences(tx: Tx, copies: { id: string; sourceId: string }[]): Promise<void> {
  if (!copies.length) return;
  await tx.execute(sql`
    update ${fileReference} r set authorized = true
    from jsonb_to_recordset(${JSON.stringify(copies)}::jsonb) as m(id text, "sourceId" text), ${file} f
    where r.page_id = m.id and not r.authorized and f.id = r.file_id
      and (f.page_id = m."sourceId" or exists (
        select 1 from ${fileReference} s where s.page_id = m."sourceId" and s.file_id = r.file_id and s.authorized
      ))
  `);
}

/**
 * Of these (page, file) pairs, the files each page shows with authorization (see fileReference),
 * or that were uploaded to it, keyed `pageId:fileId`.
 */
export async function authorizedPairs(pairs: { pageId: string; fileId: string }[]): Promise<Set<string>> {
  if (!pairs.length) return new Set();
  const rows = await db.execute<{ page_id: string; file_id: string }>(sql`
    select m.page_id, m.file_id
    from jsonb_to_recordset(${JSON.stringify(pairs.map((p) => ({ page_id: p.pageId, file_id: p.fileId })))}::jsonb)
      as m(page_id text, file_id text)
    join ${file} f on f.id = m.file_id
    where f.page_id = m.page_id or exists (
      select 1 from ${fileReference} r where r.page_id = m.page_id and r.file_id = m.file_id and r.authorized
    )
  `);
  return new Set([...rows].map((r) => `${r.page_id}:${r.file_id}`));
}

/**
 * `fileForViewer` for a connected app (an MCP client) acting for `userId`: only files of workspaces
 * the user is in, and none of a workspace whose settings hide it from connected apps (see
 * connected-app.ts); a file served only by someone else's publication reads as missing too.
 */
export async function fileForApp(userId: string, fileId: string): Promise<FileRow | null> {
  const found = await fileForViewer(userId, fileId);
  if (!found) return null;
  try {
    await requireMembership(userId, found.workspaceId);
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
  return found;
}

/** A stored file's bytes; null when the storage has nothing under its key. Read whole: callers bound `found.size` first. */
export async function readStored(found: Pick<FileRow, "storageKey" | "storageId" | "storageObjectId">): Promise<Buffer | null> {
  const body = await (await storageOf(found)).get(refOf(found));
  if (!body) return null;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Files of `workspaceId` among `ids` (any others are left out). */
export async function workspaceFiles(workspaceId: string, ids: string[]): Promise<FileRow[]> {
  const valid = ids.filter(isFileId);
  if (!valid.length) return [];
  return db
    .select()
    .from(file)
    .where(and(eq(file.workspaceId, workspaceId), inArray(file.id, valid)));
}

/**
 * The page the file was uploaded to (while it exists) and the pages of its workspace showing it with
 * authorization (see fileReference).
 */
async function pagesShowing(found: FileRow): Promise<string[]> {
  const refs = await db
    .select({ pageId: fileReference.pageId })
    .from(fileReference)
    .innerJoin(page, eq(page.id, fileReference.pageId))
    .where(and(eq(fileReference.fileId, found.id), eq(fileReference.authorized, true), eq(page.workspaceId, found.workspaceId)));
  return [...new Set([...(found.pageId ? [found.pageId] : []), ...refs.map((r) => r.pageId)])];
}

/**
 * An object to delete: a bare key is one of the instance's storage (avatars); a file's is where the
 * file was stored (`fileObject`).
 */
export type QueuedObject = string | StoredObject;

const asStored = (object: QueuedObject): StoredObject => (typeof object === "string" ? { storageId: null, key: object } : object);

/** Where a file's bytes are, for queueing their deletion. */
export const fileObject = (row: { storageKey: string; storageId: string | null; storageObjectId?: string | null }): StoredObject => ({
  storageId: row.storageId,
  key: row.storageKey,
  objectId: row.storageObjectId ?? null,
});

/** The columns `fileObject` needs, for `returning`. */
export const fileObjectColumns = { storageKey: file.storageKey, storageId: file.storageId, storageObjectId: file.storageObjectId };

/** The queue entry of one object: its key in its storage. */
const entryOf = ({ storageId, key }: StoredObject) =>
  and(eq(storageDeletion.storageKey, key), storageId ? eq(storageDeletion.storageId, storageId) : isNull(storageDeletion.storageId));

/**
 * Queues stored objects for deletion (see `storageDeletion`). Called in the transaction that removes
 * their rows, so no object is left behind unrecorded when deleting it fails or the server stops
 * first. `deleteQueued` or the cleanup (`drainStorageDeletions`) deletes them afterwards.
 */
export async function queueStorageDeletion(tx: Tx | typeof db, objects: QueuedObject[]) {
  for (let i = 0; i < objects.length; i += 1000) {
    await tx
      .insert(storageDeletion)
      .values(
        objects.slice(i, i + 1000).map((object) => {
          const { storageId, key, objectId } = asStored(object);
          return { storageId, storageKey: key, storageObjectId: objectId ?? null };
        }),
      )
      .onConflictDoNothing();
  }
}

/**
 * The queued objects a file is stored as now: a file with the same key in the same storage, or in
 * another place over the same location (the same bucket connected again as a new account). Their
 * entries are stale (the file came back to where an old copy was queued for deletion, or another
 * worker's copy is the one a file points at), and the objects must stay.
 */
async function stillStored(objects: StoredObject[]): Promise<Set<StoredObject>> {
  const live = new Set<StoredObject>();
  const keys = [...new Set(objects.map((o) => o.key))];
  const rows: { key: string; storageId: string | null }[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    rows.push(...(await db.select({ key: file.storageKey, storageId: file.storageId }).from(file).where(inArray(file.storageKey, keys.slice(i, i + 1000)))));
  }
  if (!rows.length) return live;
  const placeIds = [...new Set([...rows, ...objects].map((o) => o.storageId).filter((id): id is string => Boolean(id)))];
  const locations = new Map(placeIds.length ? (await loadTargets(inArray(workspaceStorage.id, placeIds))).map((t) => [t.id, targetLocation(t)]) : []);
  for (const object of objects) {
    const stored = rows.some((row) => {
      if (row.key !== object.key) return false;
      if (row.storageId === object.storageId) return true;
      const a = row.storageId ? locations.get(row.storageId) : undefined;
      const b = object.storageId ? locations.get(object.storageId) : undefined;
      return Boolean(a && b && sameLocation(a, b));
    });
    if (stored) live.add(object);
  }
  return live;
}

/**
 * Deletes the queued objects from their storage now, each with its queue entry. An object a file
 * is stored as now isn't deleted, only taken off the queue (see stillStored). An object the storage
 * refuses to delete (or whose storage can't be reached) stays queued and is tried again later
 * (`drainStorageDeletions`): a minute after the first failure, then twice as long after each one,
 * up to a day. Returns how many went.
 */
export async function deleteQueued(objects: QueuedObject[]): Promise<number> {
  const resolve = storageResolver();
  const done: StoredObject[] = [];
  const stored = objects.map(asStored);
  const live = await stillStored(stored);
  for (const object of stored) {
    if (live.has(object)) {
      done.push(object);
      continue;
    }
    try {
      const storage = await resolve(object);
      await storage.delete({ key: object.key, objectId: object.objectId ?? null });
      done.push(object);
    } catch (error) {
      console.error(`[files] couldn't delete ${object.key} from storage; will try again`, error);
      await db
        .update(storageDeletion)
        .set({
          attempts: sql`${storageDeletion.attempts} + 1`,
          nextAttemptAt: sql`now() + least(interval '1 minute' * power(2, ${storageDeletion.attempts}), interval '1 day')`,
          lastError: String(error).slice(0, 1000),
        })
        .where(entryOf(object));
    }
  }
  const byStorage = new Map<string | null, string[]>();
  for (const { storageId, key } of done) byStorage.set(storageId, [...(byStorage.get(storageId) ?? []), key]);
  for (const [storageId, keys] of byStorage) {
    for (let i = 0; i < keys.length; i += 1000) {
      await db
        .delete(storageDeletion)
        .where(
          and(
            inArray(storageDeletion.storageKey, keys.slice(i, i + 1000)),
            storageId ? eq(storageDeletion.storageId, storageId) : isNull(storageDeletion.storageId),
          ),
        );
    }
  }
  return done.length;
}

/**
 * Deletes stored objects that no row records (any more): queued first, so a failure is retried.
 * Never throws: the change that made them unneeded is done already.
 */
export async function removeStored(objects: QueuedObject[]) {
  if (!objects.length) return;
  try {
    await queueStorageDeletion(db, objects);
    await deleteQueued(objects);
  } catch (error) {
    console.error("[files] couldn't delete files from storage", error);
  }
}

const DELETION_LOCK = "leafdesk:storage-deletion";
const DELETION_BATCH = 100;

/**
 * Deletes every queued object that is due: those whose deletion failed before, and those queued by a
 * server that stopped before it got to them. Returns how many went and how many failed again, or
 * null when another server is at it right now (a session lock, released with the connection if the
 * process dies midway).
 */
export async function drainStorageDeletions(): Promise<{ deleted: number; failed: number } | null> {
  const connection = await db.$client.reserve();
  try {
    const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${DELETION_LOCK})) as locked`;
    if (!row?.locked) return null;
    try {
      let deleted = 0;
      let failed = 0;
      for (;;) {
        // A failure moves its entry past now(), so each round takes new ones and this ends.
        const due = await db
          .select({ key: storageDeletion.storageKey, storageId: storageDeletion.storageId, objectId: storageDeletion.storageObjectId })
          .from(storageDeletion)
          // Old copies a move left behind wait for it to have every file across.
          .where(and(lte(storageDeletion.nextAttemptAt, sql`now()`), isNull(storageDeletion.moveId)))
          .orderBy(asc(storageDeletion.nextAttemptAt))
          .limit(DELETION_BATCH);
        const went = await deleteQueued(due);
        deleted += went;
        failed += due.length - went;
        if (due.length < DELETION_BATCH) return { deleted, failed };
      }
    } finally {
      await connection`select pg_advisory_unlock(hashtext(${DELETION_LOCK}))`;
    }
  } finally {
    connection.release();
  }
}

/**
 * Removes files whose page was deleted for good and that no page shows anymore (in `workspaceId`,
 * or everywhere). A page showing the file without authorization doesn't count: nobody can read the
 * file through it. Uploads of people under a legal hold stay (server/legal-hold.ts). Files
 * attached to an AI chat have no page; they go with their conversation (ai-chat-files.ts), or as
 * uploads nothing used (purgeUnusedUploads). Returns how many went.
 */
export async function purgeOrphanFiles(workspaceId?: string): Promise<number> {
  const keys = await db.transaction(async (tx) => {
    const gone = await tx
      .delete(file)
      .where(
        and(
          isNull(file.pageId),
          sql`not exists (select 1 from ${fileReference} r where r.file_id = ${file.id} and r.authorized)`,
          sql`not ${uploadUnderHold()}`,
          sql`not exists (select 1 from ${aiChatFile} c where c.file_id = ${file.id})`,
          workspaceId ? eq(file.workspaceId, workspaceId) : undefined,
        ),
      )
      .returning(fileObjectColumns);
    const objects = gone.map(fileObject);
    await queueStorageDeletion(tx, objects);
    return objects;
  });
  await deleteQueued(keys);
  return keys.length;
}

/**
 * Removes uploads no page ever showed, `olderThanMs` (a day by default) after they were uploaded
 * (in `workspaceId`, or everywhere), but for those of people under a legal hold: files attached
 * to an AI chat's question that was never sent too, but not those of a question kept in a conversation.
 */
export async function purgeUnusedUploads({ olderThanMs = 24 * 60 * 60 * 1000, workspaceId }: { olderThanMs?: number; workspaceId?: string } = {}): Promise<number> {
  const keys = await db.transaction(async (tx) => {
    const gone = await tx
      .delete(file)
      .where(
        and(
          workspaceId ? eq(file.workspaceId, workspaceId) : undefined,
          isNull(file.referencedAt),
          sql`${file.createdAt} < now() - make_interval(secs => ${olderThanMs / 1000})`,
          sql`not exists (select 1 from ${fileReference} r where r.file_id = ${file.id})`,
          sql`not ${uploadUnderHold()}`,
          sql`not exists (select 1 from ${aiChatFile} c where c.file_id = ${file.id} and c.conversation_id is not null)`,
        ),
      )
      .returning(fileObjectColumns);
    const objects = gone.map(fileObject);
    await queueStorageDeletion(tx, objects);
    return objects;
  });
  await deleteQueued(keys);
  return keys.length;
}

let sweeper: NodeJS.Timeout | null = null;

/**
 * Runs both cleanups, then the deletions still queued (and forgets workspace storage left empty), a
 * minute after start and hourly after that
 * (server.ts).
 */
export function startFileCleanup() {
  if (sweeper) return;
  const sweep = async () => {
    try {
      const orphans = await purgeOrphanFiles();
      const unused = await purgeUnusedUploads();
      if (orphans || unused) console.log(`[files] removed ${orphans} orphaned and ${unused} unused uploads`);
      const queued = await drainStorageDeletions();
      if (queued?.deleted || queued?.failed) {
        console.log(`[files] deleted ${queued.deleted} queued objects from storage, ${queued.failed} to try again later`);
      }
      // Workspace storage that holds nothing any more (disconnected, or of a deleted workspace).
      const retired = await removeRetiredStorage();
      if (retired) console.log(`[files] forgot ${retired} workspace storage connections nothing is stored in any more`);
    } catch (error) {
      console.error("[files] cleanup failed", error);
    }
  };
  setTimeout(sweep, 60_000).unref();
  sweeper = setInterval(sweep, 60 * 60 * 1000);
  sweeper.unref();
}
