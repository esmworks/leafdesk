/**
 * Instance administrators: whoever runs the server names them in `ADMIN_EMAILS` (comma-separated,
 * case-insensitive). There is no role to hand out in the database, so a self-hoster can't lock
 * themselves out by demoting the last admin, and changing who is one takes an edit of the
 * environment and a restart, like any other server setting. The one exception is the first account
 * of a new server, which is an administrator too, for good (server/first-admin.ts).
 *
 * Only a verified address counts. Email and password sign-up never verifies one, so anyone could
 * register an account with the admin's address before its owner does; it becomes an admin only
 * once the address is proven (a reset link that reached it, a provider or single sign-on that
 * vouches for it, a confirmed email change, or `pnpm auth:verify-email` on the server).
 */

/** `ADMIN_EMAILS` as a set of lowercased addresses; blank entries are dropped. */
export function adminEmailsFrom(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export type AdminCandidate = { id?: string | null; email?: string | null; emailVerified?: boolean | null } | null | undefined;

/**
 * Whether this account is an instance administrator (see the file comment): a verified address in
 * ADMIN_EMAILS, or the first account's id (server/first-admin.ts finds it; on the server, ask
 * `instanceAdmin` there rather than this).
 */
export function isInstanceAdmin(
  user: AdminCandidate,
  adminEmails: ReadonlySet<string> = adminEmailsFrom(process.env.ADMIN_EMAILS),
  firstAdminId: string | null = null,
): boolean {
  if (!user) return false;
  if (firstAdminId && typeof user.id === "string" && user.id === firstAdminId) return true;
  if (user.emailVerified !== true || typeof user.email !== "string") return false;
  return adminEmails.has(user.email.trim().toLowerCase());
}

export const WORKSPACE_CREATION = ["everyone", "admins"] as const;
export type WorkspaceCreation = (typeof WORKSPACE_CREATION)[number];

/**
 * `WORKSPACE_CREATION`: `everyone` (the default, also when unset or blank) or `admins`. Any other
 * value restricts creation too: a typo shouldn't quietly leave it open.
 */
export function workspaceCreationFrom(value: string | undefined): WorkspaceCreation {
  const clean = (value ?? "").trim().toLowerCase();
  return clean === "" || clean === "everyone" ? "everyone" : "admins";
}

/**
 * Whether this account may create another workspace. The personal workspace made at sign-up
 * doesn't ask: everyone gets one.
 */
export function canCreateWorkspace(
  user: AdminCandidate,
  policy: WorkspaceCreation = workspaceCreationFrom(process.env.WORKSPACE_CREATION),
  adminEmails?: ReadonlySet<string>,
  firstAdminId: string | null = null,
): boolean {
  return policy === "everyone" || isInstanceAdmin(user, adminEmails, firstAdminId);
}
