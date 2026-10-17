import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  memberGroup,
  memberGroupMember,
  scimGroup,
  teamspaceGroup,
  user,
  workspaceMember,
} from "@/db/schema";
import { cleanGroupName, GroupError } from "@/lib/groups";
import { AccessError, isGuest, requireMember, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { listTeamspaces } from "@/server/teamspaces";
import { handOverOrphanedPages } from "@/server/workspaces";

/**
 * Member groups: named sets of a workspace's owners and members that pages are shared with and
 * teamspaces joined by, all at once (`page_group_permission`, `teamspace_group`; what they give is
 * worked out by `page_access_level`, drizzle/*_groups.sql).
 *
 * - Workspace owners create, rename and delete groups and choose who is in them. Owners and members
 *   see the groups and who is in them (like the members list); guests don't.
 * - Only owners and members can be in a group. Someone who becomes a guest leaves their groups
 *   (setMemberRole), and leaving or being removed from the workspace takes them out of its groups
 *   in the same statement (the membership row points at `workspace_member`).
 * - Taking access away (removing someone from a group, deleting a group) hands pages nobody could
 *   manage any more to the owner who did it, as removing someone from the workspace does, and
 *   drops open editors that lost access.
 * - The workspace's identity provider can manage groups over SCIM (server/scim.ts) through the same
 *   functions, with the workspace's oldest owner acting for it; `scim_group` marks those groups.
 */

export { GroupError, type GroupErrorCode } from "@/lib/groups";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type GroupPerson = { userId: string; name: string; email: string; image: string | null };

export type GroupSummary = {
  id: string;
  name: string;
  memberCount: number;
  members: GroupPerson[];
  /** Teamspaces the group joined, among those the viewer can see. */
  teamspaces: { id: string; name: string; icon: string | null }[];
  /** Created or changed by the workspace's identity provider over SCIM. */
  provisioned: boolean;
  createdAt: Date;
};

/** People's names (or addresses) for the audit log. */
async function namesOf(reader: Pick<typeof db, "select">, userIds: string[]) {
  if (!userIds.length) return [];
  const rows = await reader.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, userIds));
  const byId = new Map(rows.map((r) => [r.id, r.name || r.email]));
  return userIds.map((id) => byId.get(id) ?? "");
}

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505";

/** The group, when it belongs to a workspace the user is an owner of. AccessError otherwise, missing or not. */
async function ownedGroup(actorId: string, groupId: string) {
  const [found] = await db.select().from(memberGroup).where(eq(memberGroup.id, groupId)).limit(1);
  if (!found) throw new AccessError();
  await requireMembership(actorId, found.workspaceId, "owner");
  return found;
}

/**
 * The workspace's groups, by name, with who is in them. Owners and members only. `teamspaces`
 * leaves out private teamspaces the viewer isn't in, as everywhere else.
 */
export async function listGroups(userId: string, workspaceId: string): Promise<GroupSummary[]> {
  await requireMember(userId, workspaceId);
  const groups = await db
    .select({
      id: memberGroup.id,
      name: memberGroup.name,
      createdAt: memberGroup.createdAt,
      provisioned: sql<boolean>`exists (select 1 from ${scimGroup} s where s.group_id = ${memberGroup.id})`,
    })
    .from(memberGroup)
    .where(eq(memberGroup.workspaceId, workspaceId))
    .orderBy(sql`lower(${memberGroup.name})`, asc(memberGroup.createdAt));
  if (!groups.length) return [];
  const ids = groups.map((g) => g.id);
  const [people, spaces] = await Promise.all([
    db
      .select({
        groupId: memberGroupMember.groupId,
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(memberGroupMember)
      .innerJoin(user, eq(user.id, memberGroupMember.userId))
      .where(inArray(memberGroupMember.groupId, ids))
      .orderBy(asc(user.name)),
    db
      .select({ groupId: teamspaceGroup.groupId, teamspaceId: teamspaceGroup.teamspaceId })
      .from(teamspaceGroup)
      .where(eq(teamspaceGroup.workspaceId, workspaceId)),
  ]);
  // Who sees which teamspace is teamspaces.ts's business (private ones stay hidden).
  const visible = spaces.length ? await listTeamspaces(userId, workspaceId) : [];
  return groups.map((g) => {
    const members = people.filter((p) => p.groupId === g.id).map(({ groupId: _, ...person }) => person);
    return {
      ...g,
      memberCount: members.length,
      members,
      teamspaces: visible
        .filter((t) => spaces.some((s) => s.groupId === g.id && s.teamspaceId === t.id))
        .map(({ id, name, icon }) => ({ id, name, icon })),
    };
  });
}

/** For the members list: the groups each person is in, by user id. Owners and members only. */
export async function groupsByMember(userId: string, workspaceId: string) {
  await requireMember(userId, workspaceId);
  const rows = await db
    .select({ userId: memberGroupMember.userId, id: memberGroup.id, name: memberGroup.name })
    .from(memberGroupMember)
    .innerJoin(memberGroup, eq(memberGroup.id, memberGroupMember.groupId))
    .where(eq(memberGroupMember.workspaceId, workspaceId))
    .orderBy(sql`lower(${memberGroup.name})`);
  const byUser = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), { id: r.id, name: r.name }]);
  return byUser;
}

/** Throws unless every one of `userIds` is an owner or member of the workspace (guests can't be in groups). */
async function requireGroupable(workspaceId: string, userIds: string[]) {
  if (!userIds.length) return;
  const people = await db
    .select({ userId: workspaceMember.userId, role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), inArray(workspaceMember.userId, userIds)));
  const allowed = new Set(people.filter((p) => !isGuest(p.role)).map((p) => p.userId));
  if (userIds.some((id) => !allowed.has(id))) {
    throw new GroupError("notMember", "Only owners and members of the workspace can be in its groups.");
  }
}

/** A new group, with these people in it. Workspace owners only. */
export async function createGroup(actorId: string, workspaceId: string, name: string, userIds: string[] = []) {
  await requireMembership(actorId, workspaceId, "owner");
  const clean = cleanGroupName(name);
  const wanted = [...new Set(userIds)];
  await requireGroupable(workspaceId, wanted);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(memberGroup)
        .values({ workspaceId, name: clean, createdBy: actorId })
        .returning({ id: memberGroup.id, name: memberGroup.name });
      if (wanted.length) {
        await tx.insert(memberGroupMember).values(wanted.map((id) => ({ groupId: row.id, workspaceId, userId: id })));
      }
      await recordAudit(
        {
          workspaceId,
          actorId,
          action: "group.created",
          target: { type: "group", id: row.id, label: row.name },
          details: { names: await namesOf(tx, wanted) },
        },
        tx,
      );
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new GroupError("nameTaken", "Another group already has this name.");
    throw error;
  }
}

/** What changeGroup does: a new name, people to add, people to take out (ids in both stay in). */
export type GroupChanges = { name?: string; add?: string[]; remove?: string[] };

/**
 * Renames a group and changes who is in it, in one transaction. Workspace owners only. The people
 * added must be owners or members of the workspace. Taking people out hands pages nobody could
 * manage without them to the owner who did it. The open editors of everyone added or taken out
 * are checked again (see afterAccessChange).
 * Settings > Groups and SCIM (/scim/v2/Groups, see server/scim.ts) both go through here.
 */
export async function changeGroup(actorId: string, groupId: string, changes: GroupChanges) {
  const found = await ownedGroup(actorId, groupId);
  const name = changes.name === undefined ? undefined : cleanGroupName(changes.name);
  const add = [...new Set(changes.add ?? [])];
  const remove = [...new Set(changes.remove ?? [])].filter((id) => !add.includes(id));
  if (name === undefined && !add.length && !remove.length) return;
  await requireGroupable(found.workspaceId, add);
  let changed: string[];
  try {
    changed = await db.transaction(async (tx) => {
      await tx
        .update(memberGroup)
        .set({ ...(name !== undefined ? { name } : {}), updatedAt: new Date() })
        .where(eq(memberGroup.id, groupId));
      const label = name ?? found.name;
      const event = { workspaceId: found.workspaceId, actorId, target: { type: "group" as const, id: groupId, label } };
      if (name !== undefined && name !== found.name) {
        await recordAudit({ ...event, action: "group.renamed", details: { from: found.name, to: name } }, tx);
      }
      let added: { userId: string }[] = [];
      if (add.length) {
        added = await tx
          .insert(memberGroupMember)
          .values(add.map((id) => ({ groupId, workspaceId: found.workspaceId, userId: id })))
          .onConflictDoNothing()
          .returning({ userId: memberGroupMember.userId });
        if (added.length) {
          await recordAudit({ ...event, action: "group.members_added", details: { names: await namesOf(tx, added.map((a) => a.userId)) } }, tx);
        }
      }
      if (!remove.length) return added.map((a) => a.userId);
      const gone = await tx
        .delete(memberGroupMember)
        .where(and(eq(memberGroupMember.groupId, groupId), inArray(memberGroupMember.userId, remove)))
        .returning({ userId: memberGroupMember.userId });
      if (gone.length) {
        await handOverOrphanedPages(tx, found.workspaceId, actorId);
        await recordAudit({ ...event, action: "group.members_removed", details: { names: await namesOf(tx, gone.map((g) => g.userId)) } }, tx);
      }
      return [...added, ...gone].map((g) => g.userId);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new GroupError("nameTaken", "Another group already has this name.");
    throw error;
  }
  // Pages and teamspaces the group has may now show up in (or leave) their sidebars.
  await afterAccessChange(found.workspaceId, changed);
}

/** Renames a group. Workspace owners only. */
export async function renameGroup(actorId: string, groupId: string, name: string) {
  await changeGroup(actorId, groupId, { name });
}

/** Adds owners or members of the workspace to a group; people already in it stay. Workspace owners only. */
export async function addGroupMembers(actorId: string, groupId: string, userIds: string[]) {
  await changeGroup(actorId, groupId, { add: userIds });
}

/**
 * Takes someone out of a group. Workspace owners only. Pages nobody could manage without them go to
 * the owner who did it, and their open editors that lost access are dropped (see changeGroup).
 */
export async function removeGroupMember(actorId: string, groupId: string, targetId: string) {
  await changeGroup(actorId, groupId, { remove: [targetId] });
}

/**
 * Deletes a group with its page entries and teamspace memberships. Workspace owners only. People
 * keep what they have on their own; pages nobody could manage any more go to the owner who did it.
 */
export async function deleteGroup(actorId: string, groupId: string) {
  const found = await ownedGroup(actorId, groupId);
  const members = await groupMemberIds(groupId);
  await db.transaction(async (tx) => {
    await tx.delete(memberGroup).where(eq(memberGroup.id, groupId));
    await handOverOrphanedPages(tx, found.workspaceId, actorId);
    await recordAudit(
      { workspaceId: found.workspaceId, actorId, action: "group.deleted", target: { type: "group", id: groupId, label: found.name } },
      tx,
    );
  });

  await afterAccessChange(found.workspaceId, members);
}

/** Who is in the group (for dropping their open editors after the group lost something). */
export async function groupMemberIds(groupId: string, reader: Pick<typeof db, "select"> = db) {
  const rows = await reader
    .select({ userId: memberGroupMember.userId })
    .from(memberGroupMember)
    .where(eq(memberGroupMember.groupId, groupId));
  return rows.map((r) => r.userId);
}

/**
 * The group, when it belongs to `workspaceId`: for sharing a page with it or adding it to a
 * teamspace. AccessError otherwise, the same whether it is missing or another workspace's.
 */
export async function requireGroupIn(workspaceId: string, groupId: string) {
  const [found] = await db
    .select({ id: memberGroup.id, name: memberGroup.name })
    .from(memberGroup)
    .where(and(eq(memberGroup.id, groupId), eq(memberGroup.workspaceId, workspaceId)))
    .limit(1);
  if (!found) throw new AccessError();
  return found;
}

/**
 * Refreshes sidebars, and checks the open editors of these people again: those they lost access
 * to are dropped, and read-only ones of pages they may edit now take their edits (see
 * disconnectLostAccess).
 */
export async function afterAccessChange(workspaceId: string, userIds: string[]) {
  getCollab().broadcast(`ws:${workspaceId}`, "tree");
  if (userIds.length) await getCollab().disconnectLostAccess(workspaceId, userIds);
}

/**
 * Removes the person from every group of the workspace (they became a guest). Their group access
 * goes with it; setMemberRole drops their open editors.
 */
export async function dropFromGroups(tx: Tx, workspaceId: string, userId: string) {
  await tx
    .delete(memberGroupMember)
    .where(and(eq(memberGroupMember.workspaceId, workspaceId), eq(memberGroupMember.userId, userId)));
}
