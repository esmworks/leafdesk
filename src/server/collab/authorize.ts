import { isPageLocked } from "@/lib/page-lock";
import { AccessError, findMembership, hasLevel, pageAccessOf, policyError, policyHoldFor, type SessionFacts } from "@/server/access";

export type DocTarget = { kind: "page" | "ws" | "db"; id: string };

/** `page:<id>` is a page's live document; `ws:<id>` and `db:<id>` only carry change signals. */
export function parseDocName(name: string): DocTarget | null {
  const match = /^(page|ws|db):([\w-]+)$/.exec(name);
  return match ? { kind: match[1] as DocTarget["kind"], id: match[2] } : null;
}

/**
 * Whether the user may open a collab document: a workspace's signals need membership, a page or
 * database needs view access, and without edit access, while the page is locked (lib/page-lock)
 * or while it is in the trash, a page's connection is read-only. Signal
 * documents (`ws:`, `db:`) are always read-only: the server only broadcasts on them, and nobody
 * writes into them. The
 * workspace's sign-in policies apply to the session the token was issued to (`facts`, see
 * collabSessionFacts) and the address the websocket comes from (`facts.ip`). Throws AccessError otherwise (a WorkspacePolicyError for the policies).
 * Checked when the connection opens; turning a policy on closes the others (disconnectHeldBack).
 *
 * People who may comment on a page, but not edit it, get a connection that takes only their own
 * suggested edits (`suggestOnly`, see suggest-guard.ts) while the page could be edited at all.
 */
export async function authorizeCollab(
  userId: string,
  target: DocTarget,
  facts: SessionFacts = { strong: false, ssoProviderId: null, ip: null },
): Promise<{ readOnly: boolean; suggestOnly: boolean }> {
  if (target.kind === "ws") {
    if (!(await findMembership(userId, target.id))) throw new AccessError();
    await holdBack(userId, target.id, facts);
    return { readOnly: true, suggestOnly: false };
  }
  const { page, level } = await pageAccessOf(userId, target.id);
  if (!page || !hasLevel(level, "view")) throw new AccessError();
  await holdBack(userId, page.workspaceId, facts);
  const writable = target.kind === "page" && !isPageLocked(page) && !page.archivedAt;
  // The body is content: content access writes it as edit access does.
  if (writable && hasLevel(level, "content")) return { readOnly: false, suggestOnly: false };
  const suggestOnly = writable && page.kind === "page" && hasLevel(level, "comment");
  return { readOnly: !suggestOnly, suggestOnly };
}

async function holdBack(userId: string, workspaceId: string, facts: SessionFacts) {
  const hold = await policyHoldFor(userId, workspaceId, facts);
  if (hold) throw policyError(workspaceId, hold);
}
