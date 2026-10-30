import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { connection, databaseSync, sheetsWrite } from "@/db/schema";
import { gcalWriteAccess } from "@/lib/gcal-sync";
import type { SyncWriteStatus } from "@/lib/jira-sync";
import { sheetsWriteAccess } from "@/lib/sheets-sync";
import { AccessError, requireMembership, requirePageAccess } from "@/server/access";
import { mayWriteBack } from "./sync-writes";

/**
 * What the database's page shows of its sync while it writes back (null otherwise): the changes
 * waiting, a failed write, and whether `userId` may write them now, which Sync now (sheets-sync and
 * gcal-sync manage.ts) asks for: full access to the database and leave to write through the
 * connection. Asked on every load of the database, so it reads little unless something waits.
 */
export async function syncWriteStatus(userId: string, databaseId: string): Promise<SyncWriteStatus | null> {
  if (!(await mayWriteBack(databaseId))) return null;
  const [sync] = await db
    .select({ id: databaseSync.id, source: databaseSync.source, query: databaseSync.query, workspaceId: databaseSync.workspaceId })
    .from(databaseSync)
    .where(eq(databaseSync.databaseId, databaseId));
  const query = sync?.query as { connectionId: string; direction?: string; writeError?: string | null } | undefined;
  if (!sync || (sync.source !== "sheets" && sync.source !== "gcal") || query?.direction !== "both") return null;
  const [waiting] = await db.select({ n: count() }).from(sheetsWrite).where(eq(sheetsWrite.syncId, sync.id));
  const status = { source: sync.source, pending: waiting?.n ?? 0, failed: Boolean(query.writeError), canWriteNow: false };
  if (!status.pending) return status;
  try {
    await requirePageAccess(userId, databaseId, "full");
    const { role } = await requireMembership(userId, sync.workspaceId);
    const [through] = await db.select().from(connection).where(eq(connection.id, query.connectionId)).limit(1);
    const mayWrite = sync.source === "gcal" ? gcalWriteAccess : sheetsWriteAccess;
    status.canWriteNow = Boolean(through && through.status === "ready" && mayWrite(through, role));
  } catch (error) {
    if (!(error instanceof AccessError)) throw error;
  }
  return status;
}
