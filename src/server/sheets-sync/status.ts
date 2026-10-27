import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { connection, databaseSync, sheetsWrite } from "@/db/schema";
import { sheetsWriteAccess, type SheetsQuery, type SheetsWriteStatus } from "@/lib/sheets-sync";
import { AccessError, requireMembership, requirePageAccess } from "@/server/access";
import { mayWriteBack } from "./outbox";

/**
 * What the database's page shows of its Google Sheets sync while it writes back (null otherwise):
 * the changes waiting, a failed write, and whether `userId` may write them now, which Sync now
 * (manage.ts syncSheetsNow) asks for: full access to the database and leave to write through the
 * connection. Asked on every load of the database, so it reads little unless something waits.
 */
export async function sheetsWriteStatus(userId: string, databaseId: string): Promise<SheetsWriteStatus | null> {
  if (!(await mayWriteBack(databaseId))) return null;
  const [sync] = await db
    .select({ id: databaseSync.id, query: databaseSync.query, workspaceId: databaseSync.workspaceId })
    .from(databaseSync)
    .where(eq(databaseSync.databaseId, databaseId));
  const query = sync?.query as SheetsQuery | undefined;
  if (!sync || query?.direction !== "both") return null;
  const [waiting] = await db.select({ n: count() }).from(sheetsWrite).where(eq(sheetsWrite.syncId, sync.id));
  const status = { pending: waiting?.n ?? 0, failed: Boolean(query.writeError), canWriteNow: false };
  if (!status.pending) return status;
  try {
    await requirePageAccess(userId, databaseId, "full");
    const { role } = await requireMembership(userId, sync.workspaceId);
    const [through] = await db.select().from(connection).where(eq(connection.id, query.connectionId)).limit(1);
    status.canWriteNow = Boolean(through && through.status === "ready" && sheetsWriteAccess(through, role));
  } catch (error) {
    if (!(error instanceof AccessError)) throw error;
  }
  return status;
}
