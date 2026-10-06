import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { file, fileReference, page } from "@/db/schema";
import { cleanFileName, contentTypeFor, fileUrl, formatBytes, isFileId } from "@/lib/files";
import { AccessError, accessRank, requireMembership, requirePageAccess, sessionHeldBack } from "@/server/access";
import { anyPagePublished } from "@/server/publication";
import { fetchRemoteFile, RemoteFetchError, type RemoteFetchOptions } from "@/server/remote-fetch";
import { getStorage, uploadLimits } from "@/server/storage";

/**
 * Uploaded files (images, video, audio and attachments in page bodies, and the values of files
 * properties of database rows).
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
 *    files property holds it (`file_reference`, kept by a trigger for both).
 * Copies of a page (Duplicate, templates, pasting blocks) share the stored file rather than copying
 * it; the second rule is what lets people who see only the copy load it. Knowing a file's URL alone
 * never grants anything: ids are unguessable, and a page's body only shows a URL someone who could
 * already read the file put there.
 * Visitors of a published page (signed in or not) may read files of pages that the publication
 * serves (see publication.anyPagePublished), by the same two rules.
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
    readonly code: "tooLarge" | "quotaExceeded" | "notAllowed" | "badRequest" | "fetchFailed",
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

/** Bytes the workspace's files take up. */
export async function workspaceUsage(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ used: sql<string>`coalesce(sum(${file.size}), 0)` })
    .from(file)
    .where(eq(file.workspaceId, workspaceId));
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
  const target = await requirePageAccess(userId, pageId, "edit");
  if (target.archivedAt) throw new FileError("The page is in the trash", "notAllowed");
  if (target.kind === "database") throw new FileError("Databases have no body to put files in; add them to a row", "badRequest");
  return storeFile({ workspaceId: target.workspaceId, pageId, uploadedBy: userId }, input);
}

/**
 * Stores a file on `pageId` of `workspaceId` within the upload limits. No access check: callers
 * decide who may put files where (uploadFile for pages and rows, forms.uploadFormFile for form
 * answers). `uploadedBy` is null for anonymous form answers.
 */
export async function storeFile(
  { workspaceId, pageId, uploadedBy }: { workspaceId: string; pageId: string; uploadedBy: string | null },
  input: UploadInput,
): Promise<StoredFile> {
  const name = cleanFileName(input.name);
  const contentType = contentTypeFor(input.contentType, name);

  const { maxFileBytes, workspaceQuotaBytes } = uploadLimits();
  const tooLarge = () => new FileError(`Files can be at most ${formatBytes(maxFileBytes)}`, "tooLarge", maxFileBytes);
  const overQuota = () =>
    new FileError(`This workspace has used its ${formatBytes(workspaceQuotaBytes)} of file storage`, "quotaExceeded", workspaceQuotaBytes);
  const room = workspaceQuotaBytes - (await workspaceUsage(workspaceId));
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
    await db.transaction(async (tx) => {
      // One upload at a time per workspace gets past this point, so the sum below is current.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:file-quota:${workspaceId}`}))`);
      const [row] = await tx
        .select({ used: sql<string>`coalesce(sum(${file.size}), 0)` })
        .from(file)
        .where(eq(file.workspaceId, workspaceId));
      if (Number(row?.used ?? 0) + spooled.size > workspaceQuotaBytes) throw overQuota();
      await tx.insert(file).values({ id, workspaceId, pageId, storageKey, name, contentType, size: spooled.size, uploadedBy });
    });
    try {
      await getStorage().put(storageKey, createReadStream(spooled.path), { size: spooled.size, contentType });
    } catch (error) {
      await db.delete(file).where(eq(file.id, id));
      throw error;
    }
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
  await requirePageAccess(userId, pageId, "edit");
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
    const [visible] = await db
      .select({ id: page.id })
      .from(page)
      .where(and(inArray(page.id, pages), sql`${accessRank(userId, sql`${page.id}`)} > 0`))
      .limit(1);
    if (visible) return found;
  }
  return (await anyPagePublished(pages)) ? found : null;
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
export async function readStored(found: FileRow): Promise<Buffer | null> {
  const body = await getStorage().get(found.storageKey);
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

/** The page the file was uploaded to (while it exists) and the pages of its workspace showing it. */
async function pagesShowing(found: FileRow): Promise<string[]> {
  const refs = await db
    .select({ pageId: fileReference.pageId })
    .from(fileReference)
    .innerJoin(page, eq(page.id, fileReference.pageId))
    .where(and(eq(fileReference.fileId, found.id), eq(page.workspaceId, found.workspaceId)));
  return [...new Set([...(found.pageId ? [found.pageId] : []), ...refs.map((r) => r.pageId)])];
}

export async function removeStored(keys: string[]) {
  const storage = getStorage();
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch (error) {
      // The row is gone already; a leftover object only takes space.
      console.error(`[files] couldn't delete ${key} from storage`, error);
    }
  }
}

/**
 * Removes files whose page was deleted for good and that no page shows anymore (in `workspaceId`,
 * or everywhere). Returns how many went.
 */
export async function purgeOrphanFiles(workspaceId?: string): Promise<number> {
  const gone = await db
    .delete(file)
    .where(
      and(
        isNull(file.pageId),
        sql`not exists (select 1 from ${fileReference} r where r.file_id = ${file.id})`,
        workspaceId ? eq(file.workspaceId, workspaceId) : undefined,
      ),
    )
    .returning({ key: file.storageKey });
  await removeStored(gone.map((g) => g.key));
  return gone.length;
}

/**
 * Removes uploads no page ever showed, `olderThanMs` (a day by default) after they were uploaded
 * (in `workspaceId`, or everywhere).
 */
export async function purgeUnusedUploads({ olderThanMs = 24 * 60 * 60 * 1000, workspaceId }: { olderThanMs?: number; workspaceId?: string } = {}): Promise<number> {
  const gone = await db
    .delete(file)
    .where(
      and(
        workspaceId ? eq(file.workspaceId, workspaceId) : undefined,
        isNull(file.referencedAt),
        sql`${file.createdAt} < now() - make_interval(secs => ${olderThanMs / 1000})`,
        sql`not exists (select 1 from ${fileReference} r where r.file_id = ${file.id})`,
      ),
    )
    .returning({ key: file.storageKey });
  await removeStored(gone.map((g) => g.key));
  return gone.length;
}

let sweeper: NodeJS.Timeout | null = null;

/** Runs both cleanups a minute after start and hourly after that (server.ts). */
export function startFileCleanup() {
  if (sweeper) return;
  const sweep = async () => {
    try {
      const orphans = await purgeOrphanFiles();
      const unused = await purgeUnusedUploads();
      if (orphans || unused) console.log(`[files] removed ${orphans} orphaned and ${unused} unused uploads`);
    } catch (error) {
      console.error("[files] cleanup failed", error);
    }
  };
  setTimeout(sweep, 60_000).unref();
  sweeper = setInterval(sweep, 60 * 60 * 1000);
  sweeper.unref();
}
