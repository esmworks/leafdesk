import { AccessError, findMembership, hasLevel, pageAccessOf, policyError, policyHoldFor, type SessionFacts } from "@/server/access";

export type DocTarget = { kind: "page" | "ws" | "db"; id: string };

/** `page:<id>` is a page's live document; `ws:<id>` and `db:<id>` only carry change signals. */
export function parseDocName(name: string): DocTarget | null {
  const match = /^(page|ws|db):([\w-]+)$/.exec(name);
  return match ? { kind: match[1] as DocTarget["kind"], id: match[2] } : null;
}

/**
 * Whether the user may open a collab document: a workspace's signals need membership, a page or
 * database needs view access, and without edit access a page's connection is read-only. Signal
 * documents (`ws:`, `db:`) are always read-only: the server only broadcasts on them, and nobody
 * writes into them. The
 * workspace's sign-in policies apply to the session the token was issued to (`facts`, see
 * collabSessionFacts). Throws AccessError otherwise (a WorkspacePolicyError for the policies).
 * Checked when the connection opens; turning a policy on closes the others (disconnectHeldBack).
 */
export async function authorizeCollab(
  userId: string,
  target: DocTarget,
  facts: SessionFacts = { strong: false, ssoProviderId: null },
): Promise<{ readOnly: boolean }> {
  if (target.kind === "ws") {
    if (!(await findMembership(userId, target.id))) throw new AccessError();
    await holdBack(userId, target.id, facts);
    return { readOnly: true };
  }
  const { page, level } = await pageAccessOf(userId, target.id);
  if (!page || !hasLevel(level, "view")) throw new AccessError();
  await holdBack(userId, page.workspaceId, facts);
  return { readOnly: target.kind === "db" || !hasLevel(level, "edit") };
}

async function holdBack(userId: string, workspaceId: string, facts: SessionFacts) {
  const hold = await policyHoldFor(userId, workspaceId, facts);
  if (hold) throw policyError(workspaceId, hold);
}
