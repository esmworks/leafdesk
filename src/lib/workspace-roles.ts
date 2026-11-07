import type { WorkspaceRole, WorkspaceSettings } from "@/db/schema/app";

/**
 * What each workspace role may do beyond content, for client and server alike. On content a
 * membership admin is a member (the SQL function `page_access_level` gives both the same); on
 * people, it manages them as owners do, short of owners themselves: it never makes, unmakes or
 * removes an owner. Everything else owners decide (security, sign-in policies, connections, the
 * audit log, exports, the join link …) stays with owners.
 */

export const WORKSPACE_ROLES = ["owner", "membership_admin", "member", "guest"] as const satisfies readonly WorkspaceRole[];

export const isWorkspaceRole = (value: unknown): value is WorkspaceRole =>
  typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);

/**
 * The role as content access and member-only features see it: a membership admin is a member.
 * Code that asks `role === "member"` about content asks this instead.
 */
export const contentRole = (role: WorkspaceRole): WorkspaceRole => (role === "membership_admin" ? "member" : role);

/** Owners and membership admins: who invites and removes people, changes roles, decides join requests and runs groups. */
export const managesPeople = (role: WorkspaceRole | null | undefined) => role === "owner" || role === "membership_admin";

/**
 * Whether someone with `actor`'s role may move a person from `from` to `to` (both workspace roles).
 * Owners make any change; membership admins any that doesn't touch an owner; nobody else any.
 */
export function mayChangeRole(actor: WorkspaceRole | null | undefined, from: WorkspaceRole, to: WorkspaceRole) {
  if (actor === "owner") return true;
  return actor === "membership_admin" && from !== "owner" && to !== "owner";
}

/** Whether `actor`'s role may take someone with role `target` out of the workspace (leaving is always allowed). */
export const mayRemove = (actor: WorkspaceRole | null | undefined, target: WorkspaceRole) =>
  actor === "owner" || (actor === "membership_admin" && target !== "owner");

/** Sort order for lists of people: owners, membership admins, members, guests. */
export const ROLE_ORDER: Record<WorkspaceRole, number> = { owner: 0, membership_admin: 1, member: 2, guest: 3 };

/**
 * Whether someone with `role` (null: not in the workspace) may take its pages out as files, or
 * send them out, under its settings: not while export is off, and only owners while owners keep it
 * to themselves (`exportBy`). Read by server/workspaces.ts `exportAllowed`.
 */
export function mayExport(settings: Pick<WorkspaceSettings, "export" | "exportBy">, role: WorkspaceRole | null) {
  if (settings.export === false || !role) return false;
  return settings.exportBy !== "owners" || role === "owner";
}

/** Whether someone with `role` may delete the trash's pages for good, beside the full access that takes (`deleteForever`). */
export function mayDeleteForever(settings: Pick<WorkspaceSettings, "deleteForever">, role: WorkspaceRole | null) {
  if (!role) return false;
  return settings.deleteForever !== "owners" || role === "owner";
}
