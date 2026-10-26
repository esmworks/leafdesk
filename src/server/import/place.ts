import { ImportError } from "@/lib/import/result";
import { requirePageAccess } from "@/server/access";
import { placeTopLevel } from "@/server/teamspaces";
import { requireTopLevel } from "@/server/workspaces";

/**
 * Where an import goes, checked before any of its files is read: reading a crafted file can take
 * the server a while, so only someone who could import it there gets that far. createPage checks
 * again as each page is created.
 */

export type ImportPlace = {
  workspaceId: string;
  /** The page the import goes under; null for the workspace's top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for private pages, undefined for the default teamspace (see createPage). */
  teamspaceId?: string | null;
};

/** Refuses (AccessError, TeamspaceError) a user who can't add pages at the workspace's top level (in `teamspaceId`). */
export async function requireTopLevelPlace(userId: string, workspaceId: string, teamspaceId: string | null | undefined) {
  await placeTopLevel(userId, workspaceId, await requireTopLevel(userId, workspaceId), teamspaceId);
}

/**
 * Refuses a user who can't add pages where the import goes: edit access to the page it goes under
 * (one in the trash refused too), or a place at the top level. Returns the workspace the pages go to.
 */
export async function requireImportPlace(userId: string, place: ImportPlace): Promise<string> {
  if (place.parentId) {
    const parent = await requirePageAccess(userId, place.parentId, "edit");
    if (parent.archivedAt) throw new ImportError("The page is in the trash", "noAccess");
    return parent.workspaceId;
  }
  await requireTopLevelPlace(userId, place.workspaceId, place.teamspaceId);
  return place.workspaceId;
}

/** Imports reading files at once: one per person, a few per server. */
const running = new Set<string>();
export const MAX_IMPORTS = 3;

/**
 * Takes a slot for an import by `userId` (ImportError `busy` when they have one running or the
 * server has MAX_IMPORTS). Returns the function that gives it back (safe to call more than once).
 */
export function startImport(userId: string): () => void {
  if (running.has(userId) || running.size >= MAX_IMPORTS) throw new ImportError("Another import is still running", "busy");
  running.add(userId);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    running.delete(userId);
  };
}
