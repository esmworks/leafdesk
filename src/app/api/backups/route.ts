import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { auth } from "@/lib/auth";
import { isCrossSite } from "@/server/cross-site";
import { BackupError, backupErrorResponse, startBackupWork } from "@/server/backup/export";
import { restoreBackup } from "@/server/backup/restore";

/** A backup is at most 4 GiB (a ZIP without ZIP64). */
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

/**
 * Restores a workspace backup: `POST /api/backups` with the backup's ZIP as the raw body. Answers
 * 201 with the RestoreResult (server/backup/restore): the new workspace and what to set up again.
 * The upload is written to a temporary file first, which the restore reads by its directory.
 *
 * Requests need the `X-Leafdesk-Restore` header: a cross-site form can't send it, and a cross-site
 * fetch with it needs a CORS preflight this route doesn't answer. A foreign Origin is refused too.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return Response.json({ error: "noAccess", message: "Sign in to restore a backup" }, { status: 401 });
  if (isCrossSite(request, "x-leafdesk-restore")) {
    return Response.json({ error: "notAllowed", message: "Cross-site restores aren't allowed" }, { status: 403 });
  }
  const length = Number(request.headers.get("content-length") ?? NaN);
  if (!request.body || (Number.isFinite(length) && length > MAX_UPLOAD)) return backupErrorResponse(new BackupError("tooLarge"));

  let release: (() => void) | null = null;
  let dir: string | null = null;
  try {
    release = startBackupWork(session.user.id);
    dir = await mkdtemp(join(tmpdir(), "leafdesk-restore-"));
    const archive = join(dir, "backup.zip");
    let received = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > MAX_UPLOAD) return done(new BackupError("tooLarge"));
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(request.body as import("node:stream/web").ReadableStream), cap, createWriteStream(archive));
    const result = await restoreBackup(session.user.id, archive);
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BackupError) return backupErrorResponse(error);
    throw error;
  } finally {
    release?.();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
