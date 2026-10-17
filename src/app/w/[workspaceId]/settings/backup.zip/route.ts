import { AccessError } from "@/server/access";
import {
  BackupError,
  backupArchive,
  backupErrorResponse,
  backupRunning,
  planBackup,
  recordBackup,
  snapshotWorkspace,
  startBackupWork,
} from "@/server/backup/export";
import { attachment } from "@/server/export";
import { blockedByWorkspacePolicy, getSession, policyRefusal } from "@/server/session";

/**
 * A backup of the whole workspace (see server/backup), for owners, which restores on any Leafdesk;
 * anyone else gets 404 so the workspace's existence doesn't leak. `?check=1` only answers whether
 * it can be made (JSON), for the settings page.
 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;
  const { workspaceId } = await params;
  const hold = await blockedByWorkspacePolicy(session, workspaceId);
  if (hold) return new Response(policyRefusal(hold), { status: 403 });
  try {
    if (new URL(request.url).searchParams.get("check") === "1") {
      if (backupRunning(userId)) throw new BackupError("busy");
      const plan = await planBackup(userId, workspaceId);
      return Response.json({ ok: true, files: plan.files, fileBytes: plan.fileBytes }, { headers: { "Cache-Control": "no-store" } });
    }
    const release = startBackupWork(userId);
    try {
      const snapshot = await snapshotWorkspace(await planBackup(userId, workspaceId));
      await recordBackup(userId, snapshot);
      const name = `${snapshot.manifest.workspace.name} ${new Date().toISOString().slice(0, 10)}`;
      return new Response(backupArchive(snapshot, { onDone: release }), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": attachment(name, "leafdesk.zip"),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  } catch (error) {
    if (error instanceof AccessError) return new Response("Not found", { status: 404 });
    if (error instanceof BackupError) return backupErrorResponse(error);
    throw error;
  }
}
