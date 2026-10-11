/**
 * How deep pages nest: a top-level page is at depth 0, its subpages at 1, and so on, database rows
 * and the pages inside them included. Kept below the 64 steps `page_access_level` walks up a page's
 * ancestors (drizzle/0053_security_hardening.sql): a page it can't follow to the top level gets no
 * access at all, so nobody can nest pages past an entry that restricts them.
 */
export const MAX_PAGE_DEPTH = 60;

/** What creating, moving or copying pages throws past MAX_PAGE_DEPTH; `code` is translated like the database errors. */
export function pageTooDeepError() {
  return Object.assign(new Error(`Pages can be nested at most ${MAX_PAGE_DEPTH} levels deep`), {
    code: "pageTooDeep" as const,
    params: { max: String(MAX_PAGE_DEPTH) },
  });
}

/**
 * How many levels a tree of pages goes down from `rootId`: 0 for the page alone. Pages whose parent
 * isn't in the list count from the root.
 */
export function treeHeight(pages: readonly { id: string; parentId: string | null }[], rootId: string): number {
  const parentOf = new Map(pages.map((p) => [p.id, p.parentId]));
  const depth = new Map<string, number>([[rootId, 0]]);
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // Guards against a loop in the data: what isn't settled yet counts as the root.
    depth.set(id, 0);
    const parentId = parentOf.get(id);
    const value = parentId && parentOf.has(parentId) ? depthOf(parentId) + 1 : 0;
    depth.set(id, value);
    return value;
  };
  let height = 0;
  for (const p of pages) height = Math.max(height, depthOf(p.id));
  return height;
}
