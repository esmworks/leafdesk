"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { TeamspaceAccess, TeamspaceMemberLevel, TeamspaceRole } from "@/db/schema";
import { AccessError } from "@/server/access";
import { listGroups } from "@/server/groups";
import { setWatchingTeamspace } from "@/server/page-watch";
import { requireUserId } from "@/server/session";
import { previewTeamspaceFromPage, turnPageIntoTeamspace } from "@/server/teamspace-from-page";
import { WorkspaceError } from "@/server/workspaces";
import {
  addTeamspaceGroups,
  addTeamspaceMembers,
  inviteToTeamspace,
  canCreateTeamspace,
  createTeamspace,
  isTeamspaceAccess,
  isTeamspaceMemberLevel,
  joinTeamspace,
  leaveTeamspace,
  listTeamspaceGroups,
  listTeamspaceMembers,
  listTeamspaces,
  removeTeamspaceGroup,
  removeTeamspaceMember,
  setTeamspaceArchived,
  setTeamspaceRole,
  TeamspaceError,
  teamspacesByMember,
  type TeamspaceErrorCode,
  updateTeamspace,
} from "@/server/teamspaces";

export type TeamspaceActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

// Expected failures come back translated: Next.js hides thrown messages in production.
async function run<T>(fn: (userId: string) => Promise<T>): Promise<TeamspaceActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    if (error instanceof TeamspaceError) return fail(error.code);
    if (error instanceof AccessError) return fail("accessDenied");
    throw error;
  }
}

async function fail(code: TeamspaceErrorCode | "accessDenied"): Promise<{ ok: false; error: string }> {
  const t = await getTranslations("teamspaces.errors");
  return { ok: false, error: t(code) };
}

const refresh = (workspaceId: string) => revalidatePath(`/w/${workspaceId}`, "layout");

export async function listTeamspacesAction(workspaceId: string, archived: "active" | "archived" | "all" = "all") {
  return run(async (userId) => {
    const [teamspaces, canCreate] = await Promise.all([
      listTeamspaces(userId, workspaceId, { archived }),
      canCreateTeamspace(userId, workspaceId),
    ]);
    return { teamspaces, canCreate };
  });
}

export async function createTeamspaceAction(
  workspaceId: string,
  input: { name: string; icon?: string | null; description?: string; access: TeamspaceAccess; memberLevel?: TeamspaceMemberLevel },
) {
  if (!isTeamspaceAccess(input.access)) return fail("invalidAccess");
  if (input.memberLevel !== undefined && !isTeamspaceMemberLevel(input.memberLevel)) return fail("invalidMemberLevel");
  const result = await run(async (userId) => {
    const created = await createTeamspace(userId, workspaceId, input);
    return { id: created.id };
  });
  refresh(workspaceId);
  return result;
}

/** What turning a page into a teamspace would do (server/teamspace-from-page.ts), for the dialog asking first. */
export async function previewTeamspaceFromPageAction(pageId: string) {
  if (typeof pageId !== "string") return fail("accessDenied");
  return run((userId) => previewTeamspaceFromPage(userId, pageId));
}

/** Turns a page into a teamspace named `name`: the page and the pages under it become its pages. */
export async function turnPageIntoTeamspaceAction(workspaceId: string, pageId: string, name: string) {
  if (typeof pageId !== "string" || typeof name !== "string") return fail("accessDenied");
  const result = await run(async (userId) => {
    const created = await turnPageIntoTeamspace(userId, pageId, name);
    return { id: created.id };
  });
  refresh(workspaceId);
  return result;
}

export async function updateTeamspaceAction(
  workspaceId: string,
  teamspaceId: string,
  patch: {
    name?: string;
    icon?: string | null;
    description?: string;
    access?: TeamspaceAccess;
    memberLevel?: TeamspaceMemberLevel;
    topLevelLocked?: boolean;
  },
) {
  if (patch.access !== undefined && !isTeamspaceAccess(patch.access)) return fail("invalidAccess");
  if (patch.topLevelLocked !== undefined && typeof patch.topLevelLocked !== "boolean") return fail("invalidAccess");
  if (patch.memberLevel !== undefined && !isTeamspaceMemberLevel(patch.memberLevel)) return fail("invalidMemberLevel");
  const result = await run((userId) => updateTeamspace(userId, teamspaceId, patch));
  refresh(workspaceId);
  return result;
}

export async function setTeamspaceArchivedAction(workspaceId: string, teamspaceId: string, archived: boolean) {
  const result = await run((userId) => setTeamspaceArchived(userId, teamspaceId, archived === true));
  refresh(workspaceId);
  return result;
}

export async function joinTeamspaceAction(workspaceId: string, teamspaceId: string) {
  const result = await run((userId) => joinTeamspace(userId, teamspaceId));
  refresh(workspaceId);
  return result;
}

export async function leaveTeamspaceAction(workspaceId: string, teamspaceId: string) {
  const result = await run((userId) => leaveTeamspace(userId, teamspaceId));
  refresh(workspaceId);
  return result;
}

/** Watches every page of the teamspace, or stops (server/page-watch). */
export async function setTeamspaceWatchingAction(workspaceId: string, teamspaceId: string, watching: boolean) {
  const result = await run((userId) => setWatchingTeamspace(userId, teamspaceId, watching).then(() => watching));
  refresh(workspaceId);
  return result;
}

export async function listTeamspaceMembersAction(teamspaceId: string) {
  return run((userId) => listTeamspaceMembers(userId, teamspaceId));
}

export async function addTeamspaceMembersAction(
  workspaceId: string,
  teamspaceId: string,
  userIds: string[],
  role: TeamspaceRole = "member",
) {
  if (!Array.isArray(userIds) || !userIds.every((id) => typeof id === "string")) return fail("notMember");
  const result = await run((userId) => addTeamspaceMembers(userId, teamspaceId, userIds, role === "owner" ? "owner" : "member"));
  refresh(workspaceId);
  return result;
}

/**
 * Brings someone into the teamspace by email (see inviteToTeamspace): added when they are in the
 * workspace already, else invited to it with the teamspace, or asked for when members' invitations
 * wait for an owner's approval. The result says which, with the invitation's link to share.
 */
export async function inviteToTeamspaceAction(workspaceId: string, teamspaceId: string, email: string, role: TeamspaceRole = "member") {
  if (typeof email !== "string" || email.length > 320) return fail("invalidEmail");
  const userId = await requireUserId();
  try {
    const data = await inviteToTeamspace(userId, teamspaceId, email, role === "owner" ? "owner" : "member");
    refresh(workspaceId);
    return { ok: true as const, data };
  } catch (error) {
    if (error instanceof TeamspaceError) return fail(error.code);
    // Inviting to the workspace is refused as adding a member there is (settings' texts).
    if (error instanceof WorkspaceError) {
      const t = await getTranslations("settings.errors");
      return { ok: false as const, error: t.has(error.code) ? t(error.code as "invalidEmail") : (await getTranslations("teamspaces.errors"))("cantInvite") };
    }
    if (error instanceof AccessError) return { ok: false as const, error: (await getTranslations("teamspaces.errors"))("cantInvite") };
    throw error;
  }
}

export async function removeTeamspaceMemberAction(workspaceId: string, teamspaceId: string, targetId: string) {
  const result = await run((userId) => removeTeamspaceMember(userId, teamspaceId, targetId));
  refresh(workspaceId);
  return result;
}

export async function setTeamspaceRoleAction(workspaceId: string, teamspaceId: string, targetId: string, role: TeamspaceRole) {
  const result = await run((userId) => setTeamspaceRole(userId, teamspaceId, targetId, role === "owner" ? "owner" : "member"));
  refresh(workspaceId);
  return result;
}

/** The groups in a teamspace, and the workspace's groups (owners and members see them). */
export async function listTeamspaceGroupsAction(workspaceId: string, teamspaceId: string) {
  return run(async (userId) => {
    const [groups, all] = await Promise.all([
      listTeamspaceGroups(userId, teamspaceId),
      listGroups(userId, workspaceId).catch((error) => {
        if (error instanceof AccessError) return [];
        throw error;
      }),
    ]);
    return { groups, options: all.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount })) };
  });
}

export async function addTeamspaceGroupsAction(workspaceId: string, teamspaceId: string, groupIds: string[]) {
  if (!Array.isArray(groupIds) || !groupIds.every((id) => typeof id === "string")) return fail("accessDenied");
  const result = await run((userId) => addTeamspaceGroups(userId, teamspaceId, groupIds));
  refresh(workspaceId);
  return result;
}

export async function removeTeamspaceGroupAction(workspaceId: string, teamspaceId: string, groupId: string) {
  const result = await run((userId) => removeTeamspaceGroup(userId, teamspaceId, groupId));
  refresh(workspaceId);
  return result;
}

/** Which teamspaces each person is in, for the members list (only teamspaces the viewer can see). */
export async function teamspacesByMemberAction(workspaceId: string) {
  return run(async (userId) => Object.fromEntries(await teamspacesByMember(userId, workspaceId)));
}
