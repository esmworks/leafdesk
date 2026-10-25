import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { pageSnapshot } from "@/db/schema";
import { assertNotInTrash } from "@/lib/page-lock";
import { MAX_VERSION_NAME, unchangedSince, versionName, type VersionSaveState } from "@/lib/page-versions";
import { AccessError, requirePageAccess } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";

/**
 * Versions someone saves and names in the page history (lib/page-versions). Saving and naming take
 * edit access and a page outside the trash; a locked page can be saved and named too, since neither
 * changes the page. Like the rest of the history, neither is in the audit log.
 */

/** A name as given, or a refusal with `invalidVersionName`. */
function checkedName(value: unknown): string | null {
  const name = versionName(value);
  if (name === undefined) throw Object.assign(new Error(`A version's name is text of at most ${MAX_VERSION_NAME} characters`), { code: "invalidVersionName" as const });
  return name;
}

async function requireEditable(userId: string, pageId: string) {
  assertNotInTrash(await requirePageAccess(userId, pageId, "edit"));
}

async function newestVersion(pageId: string) {
  const [latest] = await db
    .select({
      id: pageSnapshot.id,
      name: pageSnapshot.name,
      title: pageSnapshot.title,
      contentMarkdown: pageSnapshot.contentMarkdown,
      createdAt: pageSnapshot.createdAt,
    })
    .from(pageSnapshot)
    .where(eq(pageSnapshot.pageId, pageId))
    .orderBy(desc(pageSnapshot.createdAt), desc(pageSnapshot.id))
    .limit(1);
  return latest ?? null;
}

/** Whether the page changed since its newest version (the live document when it is open). */
async function saveState(pageId: string) {
  const latest = await newestVersion(pageId);
  const changed = !unchangedSince(latest, await getCollab().readPage(pageId));
  return { latest, changed };
}

/** What Save version would do now: save a new version, or offer to name the newest one. */
export async function versionSaveState(userId: string, pageId: string): Promise<VersionSaveState> {
  await requireEditable(userId, pageId);
  const { latest, changed } = await saveState(pageId);
  return { latest: latest && { id: latest.id, name: latest.name, createdAt: latest.createdAt }, changed };
}

/**
 * Saves the page as it is now as a version named `name` (none when empty). When nothing changed
 * since the newest version, that one is named instead of saving a copy of it (`renamed`).
 */
export async function saveVersion(
  actor: WriteActor,
  pageId: string,
  name: unknown,
): Promise<{ id: string; renamed: boolean; name: string | null }> {
  const checked = checkedName(name);
  await requireEditable(actor.userId, pageId);
  const { latest, changed } = await saveState(pageId);
  if (latest && !changed) {
    await db.update(pageSnapshot).set({ name: checked }).where(eq(pageSnapshot.id, latest.id));
    return { id: latest.id, renamed: true, name: checked };
  }
  return { id: await getCollab().snapshot(pageId, "manual", actor, checked), renamed: false, name: checked };
}

/** Names a saved version, or clears its name when `name` is empty. Returns the name as stored. */
export async function renameVersion(userId: string, snapshotId: string, name: unknown): Promise<{ pageId: string; name: string | null }> {
  const checked = checkedName(name);
  const [snap] = await db.select({ pageId: pageSnapshot.pageId }).from(pageSnapshot).where(eq(pageSnapshot.id, snapshotId)).limit(1);
  if (!snap) throw new AccessError();
  await requireEditable(userId, snap.pageId);
  await db.update(pageSnapshot).set({ name: checked }).where(eq(pageSnapshot.id, snapshotId));
  return { pageId: snap.pageId, name: checked };
}
