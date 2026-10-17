import type { PageKind } from "@/db/schema/app";

/**
 * `page.lockedAt` means something by kind. A locked database keeps its properties and views (see
 * server/databases.ts). A locked page, database rows included, keeps its title, icon, background
 * and body: nobody can change them until someone who can edit the page unlocks it. It guards
 * against accidental edits and is no permission: the page can still be moved, trashed, shared,
 * commented on and given sub-pages, and a row's property values stay editable.
 */
export function isPageLocked(p: { kind: PageKind; lockedAt?: Date | string | null }): boolean {
  return p.kind === "page" && Boolean(p.lockedAt);
}

/** What the page's write paths throw for a locked page; `code` is translated like the database errors. */
export function pageLockedError() {
  return Object.assign(new Error("The page is locked"), { code: "pageLocked" as const });
}

export function assertPageUnlocked(p: { kind: PageKind; lockedAt?: Date | string | null }) {
  if (isPageLocked(p)) throw pageLockedError();
}

/**
 * A page in the trash keeps its title, icon, background, body and (a row) property values until it
 * is restored: its open editors are read-only too (see collab/authorize.ts). Moving, restoring and
 * deleting it still work.
 */
export function assertNotInTrash(p: { archivedAt?: Date | string | null }) {
  if (p.archivedAt) throw Object.assign(new Error("The page is in the trash. Restore it first."), { code: "pageInTrash" as const });
}

/** How MCP tools, the REST API and AI tools explain a refused write. */
export const PAGE_LOCKED_MESSAGE =
  "This page is locked, so its title, icon, background and body can't change. Comments, sharing and moving it still work, and so do a database row's properties. Someone who can edit the page can unlock it in Leafdesk, from the page's ... menu.";
