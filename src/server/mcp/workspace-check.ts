import { pageLabel } from "@/lib/labels";
import type { CheckPage, DeadTarget, WorkspaceCheck } from "@/lib/workspace-check";
import { pageUrl } from "./format";

/** What check_workspace answers: the report (server/workspace-check.ts) with links, and how to act on it. */
export function describeWorkspaceCheck(check: WorkspaceCheck) {
  const ws = check.workspaceId;
  const ref = (p: { id: string; title: string }) => ({ id: p.id, title: pageLabel(p.title), url: pageUrl(ws, p.id) });
  const pageOut = (p: CheckPage) => ({ ...ref(p), kind: p.kind, can_edit: p.canEdit });
  const target = (t: DeadTarget) =>
    t.status === "trash"
      ? { id: t.id, state: "in_trash", title: pageLabel(t.title), can_restore: t.canRestore }
      : { id: t.id, state: "deleted" };
  const more = (shown: number, total: number) => (total > shown ? { more: total - shown } : {});

  return {
    workspace_id: ws,
    checked_at: check.checkedAt,
    pages_checked: check.pages,
    ...(check.truncated
      ? { note: `Only the ${check.pages} most recently edited pages were checked: the workspace has more than one check looks at.` }
      : {}),
    summary: {
      broken_links: check.brokenLinks.total,
      orphan_pages: check.orphans.total,
      empty_pages: check.empty.total,
      stale_pages: check.stale.total,
      expired_verifications: check.expiredVerifications.total,
      possible_duplicates: check.duplicates.status === "done" ? check.duplicates.total : "not checked",
      broken_relations: check.brokenRelations.total,
    },
    broken_links: {
      description: "Links and mentions in a page's body to a page in the trash or deleted for good.",
      items: check.brokenLinks.items.map((f) => ({ page: pageOut(f.source), links_to: target(f.target) })),
      ...more(check.brokenLinks.items.length, check.brokenLinks.total),
    },
    orphan_pages: {
      description: "Top-level pages with no pages inside them that no page the user can open links to.",
      items: check.orphans.items.map((p) => ({
        ...pageOut(p),
        ...(p.linkFrom ? { title_written_in: ref(p.linkFrom) } : {}),
      })),
      ...more(check.orphans.items.length, check.orphans.total),
    },
    empty_pages: {
      description: "Pages with a title and no body or pages inside.",
      items: check.empty.items.map(pageOut),
      ...more(check.empty.items.length, check.empty.total),
    },
    stale_pages: {
      description: `Pages nobody edited in the last ${check.staleMonths} months, longest untouched first.`,
      items: check.stale.items.map((p) => ({ ...pageOut(p), last_edited: p.updatedAt })),
      ...more(check.stale.items.length, check.stale.total),
    },
    expired_verifications: {
      description: "Pages whose verification ended: someone vouched for them until then. Check them again.",
      items: check.expiredVerifications.items.map((p) => ({ ...pageOut(p), verified_by: p.by, ended: p.until })),
      ...more(check.expiredVerifications.items.length, check.expiredVerifications.total),
    },
    possible_duplicates:
      check.duplicates.status === "done"
        ? {
            description: `Pairs of pages whose meaning is at least ${check.duplicates.minSimilarity} alike (cosine similarity of their embeddings, 1 = the same), of ${check.duplicates.compared} pages compared. Read both before merging: alike isn't always the same.`,
            items: check.duplicates.items.map((d) => ({ a: pageOut(d.a), b: pageOut(d.b), similarity: d.similarity })),
            ...more(check.duplicates.items.length, check.duplicates.total),
          }
        : {
            description:
              check.duplicates.reason === "aiOff"
                ? "Not checked: AI is turned off in this workspace, so its pages have no embeddings to compare."
                : "Not checked: this Leafdesk server has no embeddings model set up (AI_EMBEDDINGS_MODEL), so pages can't be compared by meaning.",
            items: [],
          },
    broken_relations: {
      description: "Relation values of database rows that hold a row in the trash or deleted for good.",
      items: check.brokenRelations.items.map((f) => ({
        row: pageOut(f.row),
        database: ref(f.database),
        property: f.property.name,
        links_to: target(f.target),
        can_fix: f.canFix,
      })),
      ...more(check.brokenRelations.items.length, check.brokenRelations.total),
    },
    how_to_fix:
      "Ask the user before changing anything. A page in the trash comes back with restore_page (when can_restore). " +
      "A link to a deleted page goes by editing the page's body with update_page. An orphan page can be linked from title_written_in or moved under a page with move_page. " +
      "An empty page goes to the trash with archive_page. A stale page may be out of date: read it with get_page. " +
      "A page whose verification ended is verified again with update_page verified, after reading it. " +
      "A relation to a row in the trash or deleted is cleared with update_database_row, setting the property to its other rows.",
  };
}
