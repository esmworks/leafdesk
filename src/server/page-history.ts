import { asc, eq, inArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import { db } from "@/db";
import { oauthClient, page, pageSnapshot, user, workspaceAgent } from "@/db/schema";
import {
  changeActors,
  diffBlocks,
  diffWords,
  flattenBlocks,
  type BlockChange,
  type BlockInput,
  type ChangeActor,
  type VersionActor,
  type WordSegment,
} from "@/lib/page-diff";
import { AccessError, requirePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { bodyBlocks } from "@/server/synced-body";

/** What a saved version is compared with: the page as it is now, or the version saved before it. */
export type DiffAgainst = "current" | "previous";

export type VersionDiff = {
  against: DiffAgainst;
  /** The older side's saved version. */
  fromId: string;
  /** The newer side's saved version; null for the current page. */
  toId: string | null;
  /** Word changes of the title, or null when it stayed the same. */
  title: WordSegment[] | null;
  changes: BlockChange[];
  /** Who made the changes, as far as the history records it (see changeActors). */
  actors: ChangeActor[];
};

/**
 * A saved version's body as blocks. With `pageId`, each synced block the page is the source of
 * holds its blocks as children (server/synced-body.ts): restoring a version brings them back too,
 * so the history shows their changes. Without, the main fragment alone, as writes take it.
 */
export function snapshotBlocks(state: Uint8Array, pageId?: string) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return bodyBlocks(doc, pageId) as BlockInput[];
  } finally {
    doc.destroy();
  }
}

/**
 * Changes between a saved version and the current page (version → now) or the version saved just
 * before it (previous → version). Null when there is no earlier version to compare with. Anyone
 * who can view the page can read its history.
 */
export async function diffSnapshot(userId: string, snapshotId: string, against: DiffAgainst): Promise<VersionDiff | null> {
  const [snap] = await db
    .select({ pageId: pageSnapshot.pageId })
    .from(pageSnapshot)
    .where(eq(pageSnapshot.id, snapshotId))
    .limit(1);
  if (!snap) throw new AccessError();
  await requirePageAccess(userId, snap.pageId, "view");

  // The page's versions, oldest first. Found by position rather than by timestamp: Postgres keeps
  // microseconds that a JavaScript Date drops.
  const versions = await db
    .select({
      id: pageSnapshot.id,
      reason: pageSnapshot.reason,
      userName: user.name,
      clientName: oauthClient.name,
      isAgent: sql<boolean>`${workspaceAgent.id} is not null`,
    })
    .from(pageSnapshot)
    .leftJoin(user, eq(user.id, pageSnapshot.createdBy))
    .leftJoin(workspaceAgent, eq(workspaceAgent.userId, pageSnapshot.createdBy))
    .leftJoin(oauthClient, eq(oauthClient.clientId, pageSnapshot.oauthClientId))
    .where(eq(pageSnapshot.pageId, snap.pageId))
    .orderBy(asc(pageSnapshot.createdAt), asc(pageSnapshot.id));
  const at = versions.findIndex((v) => v.id === snapshotId);
  const from = against === "previous" ? at - 1 : at;
  if (from < 0) return null;
  const fromId = versions[from].id;
  const stored = await db
    .select({ id: pageSnapshot.id, title: pageSnapshot.title, ydoc: pageSnapshot.ydoc })
    .from(pageSnapshot)
    .where(inArray(pageSnapshot.id, [fromId, snapshotId]));
  const older = stored.find((s) => s.id === fromId)!;

  let newer: { title: string; blocks: BlockInput[] };
  const involved: VersionActor[] = versions.slice(from, against === "previous" ? at + 1 : undefined);
  if (against === "previous") {
    const version = stored.find((s) => s.id === snapshotId)!;
    newer = { title: version.title, blocks: snapshotBlocks(version.ydoc, snap.pageId) };
  } else {
    const current = await getCollab().readBlocks(snap.pageId, { synced: true });
    newer = { title: current.title, blocks: current.blocks as BlockInput[] };
    const [row] = await db
      .select({ userName: user.name, isAgent: sql<boolean>`${workspaceAgent.id} is not null` })
      .from(page)
      .leftJoin(user, eq(user.id, page.updatedBy))
      .leftJoin(workspaceAgent, eq(workspaceAgent.userId, page.updatedBy))
      .where(eq(page.id, snap.pageId))
      .limit(1);
    involved.push({ reason: "current", userName: row?.userName ?? null, clientName: null, isAgent: row?.isAgent === true });
  }

  return {
    against,
    fromId,
    toId: against === "previous" ? snapshotId : null,
    title: older.title === newer.title ? null : diffWords(older.title, newer.title),
    changes: diffBlocks(flattenBlocks(snapshotBlocks(older.ydoc, snap.pageId)), flattenBlocks(newer.blocks)),
    actors: changeActors(involved),
  };
}
