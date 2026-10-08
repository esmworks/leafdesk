import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  memberGroup,
  memberGroupMember,
  TEAMSPACE_ACCESS,
  TEAMSPACE_MEMBER_LEVELS,
  teamspace,
  teamspaceGroup,
  teamspaceMember,
  user,
  workspace,
  workspaceMember,
  type TeamspaceAccess,
  type TeamspaceMemberLevel,
  type TeamspaceRole,
  type WorkspaceRole,
} from "@/db/schema";
import { TeamspaceError } from "@/lib/teamspace-error";
import type { TeamspaceReach } from "@/lib/teamspace-reach";
import { AccessError, isGuest, requireMember } from "@/server/access";
import { changedValues, recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { afterAccessLoss, groupMemberIds, requireGroupIn } from "@/server/groups";
import { handOverOrphanedPages } from "@/server/workspaces";

/**
 * Teamspaces group a workspace's pages and the people working on them. Every page tree lives in
 * one teamspace (`page.teamspaceId`, on every page of the tree) or in nobody's (a private page).
 * What that means for access is decided in SQL, by `page_access_level` (drizzle/*_teamspaces.sql):
 * a teamspace's pages are open to its members, readable by everyone while it is open, and hidden
 * from everyone else. This module manages the teamspaces themselves: who is in them, who runs them
 * and where new top-level pages go.
 *
 * Guests are never in a teamspace. Owners and members are in every `default` teamspace without a
 * row in `teamspace_member`; rows there name its owners. People join `open` teamspaces themselves;
 * the owners of a `closed` or `private` one add them. A group that joined a teamspace
 * (`teamspace_group`) puts everyone in it into the teamspace as a member, as long as they are in
 * the group; they leave it by leaving the group. Owners are always people with a row.
 */

export { TeamspaceError, type TeamspaceErrorCode } from "@/lib/teamspace-error";

/** People's names (or addresses) for the audit log, in the order given. */
async function namesOf(reader: Pick<typeof db, "select">, userIds: string[]) {
  if (!userIds.length) return [];
  const rows = await reader.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, userIds));
  const byId = new Map(rows.map((r) => [r.id, r.name || r.email]));
  return userIds.map((id) => byId.get(id) ?? "");
}

export const isTeamspaceAccess = (value: unknown): value is TeamspaceAccess =>
  (TEAMSPACE_ACCESS as readonly unknown[]).includes(value);

export const isTeamspaceMemberLevel = (value: unknown): value is TeamspaceMemberLevel =>
  (TEAMSPACE_MEMBER_LEVELS as readonly unknown[]).includes(value);

/** Lower is less: what the members lose when a teamspace's member level goes down. */
const MEMBER_LEVEL_RANK: Record<TeamspaceMemberLevel, number> = { view: 1, comment: 2, edit: 3, full: 4 };

const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = typeof teamspace.$inferSelect;

/** Whether someone (an owner or member of the workspace) is in the teamspace. */
const joinedTeamspace = (t: { access: TeamspaceAccess }, row: { role: TeamspaceRole } | undefined) =>
  t.access === "default" || row !== undefined;

async function creationPolicy(workspaceId: string) {
  const [row] = await db.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId));
  return { ...DEFAULT_WORKSPACE_SETTINGS, ...row?.settings }.teamspaceCreation;
}

/** Whether the user may create teamspaces in the workspace: owners, and members unless restricted. */
export async function canCreateTeamspace(userId: string, workspaceId: string) {
  const membership = await requireMember(userId, workspaceId).catch(() => null);
  if (!membership) return false;
  return membership.role === "owner" || (await creationPolicy(workspaceId)) === "members";
}

/** SQL: the user is in the teamspace through a group that joined it. */
const viaGroupSql = (teamspaceId: SQL | string, userId: SQL | string) => sql`exists (
  select 1 from ${teamspaceGroup} tg join ${memberGroupMember} gm on gm.group_id = tg.group_id
  where tg.teamspace_id = ${teamspaceId} and gm.user_id = ${userId}
)`;

/**
 * The user's place in the teamspace: their own row (`direct`), or a member's place through a group
 * that joined it. Undefined when neither (they may still be in a default teamspace).
 */
async function ownRow(
  tx: Pick<typeof db, "select">,
  teamspaceId: string,
  userId: string,
): Promise<{ role: TeamspaceRole; direct: boolean } | undefined> {
  const [row] = await tx
    .select({ role: teamspaceMember.role })
    .from(teamspaceMember)
    .where(and(eq(teamspaceMember.teamspaceId, teamspaceId), eq(teamspaceMember.userId, userId)));
  if (row) return { role: row.role, direct: true };
  const [grouped] = await tx
    .select({ one: sql<number>`1` })
    .from(teamspaceGroup)
    .innerJoin(memberGroupMember, and(eq(memberGroupMember.groupId, teamspaceGroup.groupId), eq(memberGroupMember.userId, userId)))
    .where(eq(teamspaceGroup.teamspaceId, teamspaceId))
    .limit(1);
  return grouped ? { role: "member", direct: false } : undefined;
}

/**
 * The teamspace, when the user can see it: they are an owner or member of its workspace and it
 * isn't a private one they aren't in. Throws AccessError otherwise, the same way whether it exists
 * or not.
 */
async function visibleTeamspace(userId: string, teamspaceId: string) {
  const [found] = await db.select().from(teamspace).where(eq(teamspace.id, teamspaceId)).limit(1);
  if (!found) throw new AccessError();
  const membership = await requireMember(userId, found.workspaceId);
  const row = await ownRow(db, teamspaceId, userId);
  if (found.access === "private" && !row) throw new AccessError();
  return { teamspace: found, role: membership.role as WorkspaceRole, row };
}

/**
 * Teamspace owners manage a teamspace; so do workspace owners, except a private teamspace they
 * aren't an owner of: private stays private, from workspace owners too.
 */
const canManage = (t: Row, workspaceRole: WorkspaceRole, row: { role: TeamspaceRole } | undefined) =>
  row?.role === "owner" || (workspaceRole === "owner" && t.access !== "private");

async function manageableTeamspace(userId: string, teamspaceId: string) {
  const found = await visibleTeamspace(userId, teamspaceId);
  if (!canManage(found.teamspace, found.role, found.row)) throw new AccessError();
  return found;
}

export type TeamspaceSummary = {
  id: string;
  name: string;
  icon: string | null;
  description: string;
  access: TeamspaceAccess;
  /** What its members get on its pages where a page says nothing. */
  memberLevel: TeamspaceMemberLevel;
  archivedAt: Date | null;
  updatedAt: Date;
  memberCount: number;
  owners: { id: string; name: string; image?: string | null }[];
  /** The viewer is in it. */
  joined: boolean;
  /** The viewer's role in it, when they are in it. */
  role: TeamspaceRole | null;
  /** The viewer is in it only through a group (they leave it by leaving the group). */
  viaGroup: boolean;
  canManage: boolean;
  canJoin: boolean;
  canLeave: boolean;
};

/**
 * The teamspaces the user can see, oldest first: all but the private ones they aren't in.
 * Owners and members only; guests have no teamspaces.
 */
export async function listTeamspaces(
  userId: string,
  workspaceId: string,
  { archived = "active" }: { archived?: "active" | "archived" | "all" } = {},
): Promise<TeamspaceSummary[]> {
  const { role: workspaceRole } = await requireMember(userId, workspaceId);
  const rows = await db.execute<{
    id: string;
    name: string;
    icon: string | null;
    description: string;
    access: TeamspaceAccess;
    member_level: TeamspaceMemberLevel;
    archived_at: Date | null;
    updated_at: Date;
    created_at: Date;
    created_by: string | null;
    workspace_id: string;
    own_role: TeamspaceRole | null;
    via_group: boolean;
    member_count: number;
  }>(sql`
    select t.*,
      (select m.role from ${teamspaceMember} m where m.teamspace_id = t.id and m.user_id = ${userId}) as own_role,
      ${viaGroupSql(sql`t.id`, userId)} as via_group,
      case when t.access = 'default' then
        (select count(*) from ${workspaceMember} wm where wm.workspace_id = t.workspace_id and wm.role in ('owner', 'member'))
      else
        (select count(*) from ${workspaceMember} wm
          where wm.workspace_id = t.workspace_id and wm.role in ('owner', 'member')
            and (exists (select 1 from ${teamspaceMember} m where m.teamspace_id = t.id and m.user_id = wm.user_id)
              or ${viaGroupSql(sql`t.id`, sql`wm.user_id`)}))
      end::int as member_count
    from ${teamspace} t
    where t.workspace_id = ${workspaceId}
      and (t.access <> 'private' or exists (
        select 1 from ${teamspaceMember} m where m.teamspace_id = t.id and m.user_id = ${userId}
      ) or ${viaGroupSql(sql`t.id`, userId)})
      ${archived === "active" ? sql`and t.archived_at is null` : archived === "archived" ? sql`and t.archived_at is not null` : sql``}
    order by t.created_at, t.id
  `);
  const ids = rows.map((r) => r.id);
  const owners = ids.length
    ? await db
        .select({ teamspaceId: teamspaceMember.teamspaceId, id: user.id, name: user.name, image: user.image })
        .from(teamspaceMember)
        .innerJoin(user, eq(user.id, teamspaceMember.userId))
        .innerJoin(
          workspaceMember,
          and(eq(workspaceMember.userId, teamspaceMember.userId), eq(workspaceMember.workspaceId, workspaceId)),
        )
        .where(and(inArray(teamspaceMember.teamspaceId, ids), eq(teamspaceMember.role, "owner")))
        .orderBy(asc(teamspaceMember.createdAt))
    : [];
  return rows.map((r) => {
    const row = r.own_role ? { role: r.own_role } : r.via_group ? { role: "member" as const } : undefined;
    const t = { access: r.access, archivedAt: r.archived_at } as Row;
    const joined = joinedTeamspace(r, row);
    const ownersOf = owners.filter((o) => o.teamspaceId === r.id).map(({ id, name, image }) => ({ id, name, image }));
    return {
      id: r.id,
      name: r.name,
      icon: r.icon,
      description: r.description,
      access: r.access,
      memberLevel: r.member_level,
      archivedAt: r.archived_at ? new Date(r.archived_at) : null,
      updatedAt: new Date(r.updated_at),
      memberCount: Number(r.member_count),
      owners: ownersOf,
      joined,
      role: joined ? (row?.role ?? "member") : null,
      viaGroup: Boolean(r.via_group) && r.access !== "default",
      canManage: canManage(t, workspaceRole, row),
      canJoin: !joined && r.access === "open" && !r.archived_at,
      // The last owner hands the teamspace on first (a default teamspace's owners are optional).
      // Someone in it through a group leaves the group instead.
      canLeave:
        joined &&
        r.access !== "default" &&
        !r.via_group &&
        !(row?.role === "owner" && ownersOf.length <= 1),
    };
  });
}

export async function getTeamspace(userId: string, teamspaceId: string) {
  const { teamspace: found } = await visibleTeamspace(userId, teamspaceId);
  const list = await listTeamspaces(userId, found.workspaceId, { archived: "all" });
  const summary = list.find((t) => t.id === teamspaceId);
  if (!summary) throw new AccessError();
  return { ...summary, workspaceId: found.workspaceId };
}

function cleanName(name: string) {
  const clean = name.trim().slice(0, MAX_NAME);
  if (!clean) throw new TeamspaceError("nameRequired", "Give the teamspace a name.");
  return clean;
}

export type TeamspaceInput = {
  name: string;
  icon?: string | null;
  description?: string;
  access?: TeamspaceAccess;
  /** What members get on its pages where a page says nothing (see TEAMSPACE_MEMBER_LEVELS). */
  memberLevel?: TeamspaceMemberLevel;
};

/**
 * A new teamspace with its creator as owner. Needs `canCreateTeamspace`; a default teamspace (one
 * everybody is in) needs a workspace owner.
 */
export async function createTeamspace(userId: string, workspaceId: string, input: TeamspaceInput) {
  const membership = await requireMember(userId, workspaceId);
  if (!(await canCreateTeamspace(userId, workspaceId))) {
    throw new TeamspaceError("creationRestricted", "Only workspace owners can create teamspaces here.");
  }
  const access = input.access ?? "open";
  if (!isTeamspaceAccess(access)) throw new TeamspaceError("invalidAccess", `Unknown access ${String(access)}`);
  if (access === "default" && membership.role !== "owner") {
    throw new TeamspaceError("ownersOnly", "Only workspace owners can make a teamspace everyone is in.");
  }
  const memberLevel = input.memberLevel ?? "full";
  if (!isTeamspaceMemberLevel(memberLevel)) {
    throw new TeamspaceError("invalidMemberLevel", `Unknown member level ${String(memberLevel)}`);
  }
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(teamspace)
      .values({
        workspaceId,
        name: cleanName(input.name),
        icon: input.icon ?? null,
        description: (input.description ?? "").trim().slice(0, MAX_DESCRIPTION),
        access,
        memberLevel,
        createdBy: userId,
      })
      .returning();
    await tx.insert(teamspaceMember).values({ teamspaceId: row.id, userId, role: "owner" });
    await recordAudit(
      { workspaceId, actorId: userId, action: "teamspace.created", target: { type: "teamspace", id: row.id, label: row.name }, details: { access, memberLevel } },
      tx,
    );
    return row;
  });
  getCollab().broadcast(`ws:${workspaceId}`, "tree");
  return created;
}

/**
 * Changes a teamspace's name, icon, description, access or member level. Needs to manage it; making
 * a teamspace default, or one default no longer, needs a workspace owner, since it changes
 * everyone's sidebar, and so does changing what everyone gets in a default one.
 * Everyone in a default teamspace stays in it when it stops being one (they can leave then).
 */
export async function updateTeamspace(
  userId: string,
  teamspaceId: string,
  patch: Partial<Omit<TeamspaceInput, "access">> & { access?: TeamspaceAccess },
) {
  const { teamspace: current, role } = await manageableTeamspace(userId, teamspaceId);
  const access = patch.access ?? current.access;
  if (!isTeamspaceAccess(access)) throw new TeamspaceError("invalidAccess", `Unknown access ${String(access)}`);
  const memberLevel = patch.memberLevel ?? current.memberLevel;
  if (!isTeamspaceMemberLevel(memberLevel)) {
    throw new TeamspaceError("invalidMemberLevel", `Unknown member level ${String(memberLevel)}`);
  }
  const changesDefault = access !== current.access && (access === "default" || current.access === "default");
  if (changesDefault && role !== "owner") {
    throw new TeamspaceError("ownersOnly", "Only workspace owners can change which teamspaces everyone is in.");
  }
  if (memberLevel !== current.memberLevel && (access === "default" || current.access === "default") && role !== "owner") {
    throw new TeamspaceError("ownersOnly", "Only workspace owners can change what everyone gets in a teamspace everyone is in.");
  }
  const next = {
    ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
    ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim().slice(0, MAX_DESCRIPTION) } : {}),
    access,
    memberLevel,
  };
  await db.transaction(async (tx) => {
    if (current.access === "default" && access !== "default") {
      await tx.execute(sql`
        insert into ${teamspaceMember} (teamspace_id, user_id, role)
        select ${teamspaceId}, wm.user_id, 'member' from ${workspaceMember} wm
        where wm.workspace_id = ${current.workspaceId} and wm.role in ('owner', 'member')
        on conflict do nothing
      `);
      // It runs on its own from now on: someone has to own it.
      await tx
        .update(teamspaceMember)
        .set({ role: "owner" })
        .where(
          and(
            eq(teamspaceMember.teamspaceId, teamspaceId),
            eq(teamspaceMember.userId, userId),
            sql`not exists (select 1 from ${teamspaceMember} o where o.teamspace_id = ${teamspaceId} and o.role = 'owner')`,
          ),
        );
    }
    await tx
      .update(teamspace)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(teamspace.id, teamspaceId));
    const changes = changedValues<Record<string, unknown>>(current, next);
    if (Object.keys(changes).length) {
      await recordAudit(
        {
          workspaceId: current.workspaceId,
          actorId: userId,
          action: "teamspace.updated",
          target: { type: "teamspace", id: teamspaceId, label: next.name ?? current.name },
          details: { changes },
        },
        tx,
      );
    }
  });
  // People who lost its pages drop their open editors and reconnect with what they have left.
  const narrower =
    ACCESS_RANK[access] < ACCESS_RANK[current.access] || MEMBER_LEVEL_RANK[memberLevel] < MEMBER_LEVEL_RANK[current.memberLevel];
  if (narrower) await getCollab().disconnectTeamspace(teamspaceId);
  getCollab().broadcast(`ws:${current.workspaceId}`, "tree");
}

/** How much of the teamspace people outside it see, for spotting narrower access. */
const ACCESS_RANK: Record<TeamspaceAccess, number> = { private: 0, closed: 1, open: 2, default: 3 };

/** Archives a teamspace (it leaves every sidebar and takes no new pages) or brings it back. */
export async function setTeamspaceArchived(userId: string, teamspaceId: string, archived: boolean) {
  const { teamspace: current } = await manageableTeamspace(userId, teamspaceId);
  await db
    .update(teamspace)
    .set({ archivedAt: archived ? (current.archivedAt ?? new Date()) : null, updatedAt: new Date() })
    .where(eq(teamspace.id, teamspaceId));
  if (archived !== (current.archivedAt !== null)) {
    await recordAudit({
      workspaceId: current.workspaceId,
      actorId: userId,
      action: archived ? "teamspace.archived" : "teamspace.restored",
      target: { type: "teamspace", id: teamspaceId, label: current.name },
    });
  }
  getCollab().broadcast(`ws:${current.workspaceId}`, "tree");
}

/** Joins an open teamspace. */
export async function joinTeamspace(userId: string, teamspaceId: string) {
  const { teamspace: found, row } = await visibleTeamspace(userId, teamspaceId);
  if (joinedTeamspace(found, row)) return;
  if (found.archivedAt) throw new TeamspaceError("archived", "This teamspace is archived.");
  if (found.access !== "open") {
    throw new TeamspaceError("notJoinable", "Ask an owner of this teamspace to add you.");
  }
  const joined = await db
    .insert(teamspaceMember)
    .values({ teamspaceId, userId, role: "member" })
    .onConflictDoNothing()
    .returning({ userId: teamspaceMember.userId });
  if (joined.length) {
    await recordAudit({
      workspaceId: found.workspaceId,
      actorId: userId,
      action: "teamspace.member_added",
      target: { type: "teamspace", id: teamspaceId, label: found.name },
      details: { names: await namesOf(db, [userId]), role: "member" },
    });
  }
  getCollab().broadcast(`ws:${found.workspaceId}`, "tree");
}

/** Leaves a teamspace: see removeTeamspaceMember. */
export async function leaveTeamspace(userId: string, teamspaceId: string) {
  await removeTeamspaceMember(userId, teamspaceId, userId);
}

/**
 * Adds owners or members of the workspace to the teamspace; people already in it keep their role.
 * Needs to manage it. Guests can't be added: they get single pages shared with them instead.
 */
export async function addTeamspaceMembers(
  actorId: string,
  teamspaceId: string,
  userIds: string[],
  role: TeamspaceRole = "member",
) {
  const { teamspace: found } = await manageableTeamspace(actorId, teamspaceId);
  const wanted = [...new Set(userIds)];
  if (!wanted.length) return;
  const people = await db
    .select({ userId: workspaceMember.userId, role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, found.workspaceId), inArray(workspaceMember.userId, wanted)));
  const allowed = new Set(people.filter((p) => !isGuest(p.role)).map((p) => p.userId));
  const missing = wanted.filter((id) => !allowed.has(id));
  if (missing.length) {
    throw new TeamspaceError("notMember", "Only owners and members of the workspace can join its teamspaces.");
  }
  const added = await db
    .insert(teamspaceMember)
    .values(wanted.map((id) => ({ teamspaceId, userId: id, role: role === "owner" ? ("owner" as const) : ("member" as const) })))
    .onConflictDoNothing()
    .returning({ userId: teamspaceMember.userId });
  await db.update(teamspace).set({ updatedAt: new Date() }).where(eq(teamspace.id, teamspaceId));
  if (added.length) {
    await recordAudit({
      workspaceId: found.workspaceId,
      actorId,
      action: "teamspace.member_added",
      target: { type: "teamspace", id: teamspaceId, label: found.name },
      details: { names: await namesOf(db, added.map((a) => a.userId)), role: role === "owner" ? "owner" : "member" },
    });
  }
  getCollab().broadcast(`ws:${found.workspaceId}`, "tree");
}

/**
 * Takes someone out of a teamspace: themselves (leaving), or anyone when the actor manages it.
 * Nobody leaves a default teamspace; there it only takes away their owner role. The last owner
 * stays until they make someone else owner, so every teamspace has someone running it.
 */
export async function removeTeamspaceMember(actorId: string, teamspaceId: string, targetId: string) {
  const self = actorId === targetId;
  const { teamspace: found } = self
    ? await visibleTeamspace(actorId, teamspaceId)
    : await manageableTeamspace(actorId, teamspaceId);
  if (self && found.access === "default") {
    throw new TeamspaceError("cannotLeaveDefault", "Everyone is in this teamspace; it can't be left.");
  }
  await db.transaction(async (tx) => {
    const members = await tx
      .select({ userId: teamspaceMember.userId, role: teamspaceMember.role })
      .from(teamspaceMember)
      .where(eq(teamspaceMember.teamspaceId, teamspaceId))
      .for("update");
    const target = members.find((m) => m.userId === targetId);
    if (!target) {
      if (found.access === "default") return;
      if ((await ownRow(tx, teamspaceId, targetId))?.direct === false) {
        throw new TeamspaceError("inGroup", "This person is in the teamspace through a group; remove them from the group.");
      }
      throw new TeamspaceError("notMember", "This person isn't in the teamspace.");
    }
    const owners = members.filter((m) => m.role === "owner");
    if (found.access !== "default" && target.role === "owner" && owners.length <= 1) {
      throw new TeamspaceError("lastOwner", "Make someone else an owner of the teamspace first.");
    }
    await tx
      .delete(teamspaceMember)
      .where(and(eq(teamspaceMember.teamspaceId, teamspaceId), eq(teamspaceMember.userId, targetId)));
    await tx.update(teamspace).set({ updatedAt: new Date() }).where(eq(teamspace.id, teamspaceId));
    await recordAudit(
      {
        workspaceId: found.workspaceId,
        actorId,
        action: "teamspace.member_removed",
        target: { type: "teamspace", id: teamspaceId, label: found.name },
        subject: { type: "user", id: targetId },
        details: { role: target.role },
      },
      tx,
    );
  });
  if (found.access !== "default") await getCollab().disconnectTeamspace(teamspaceId, [targetId]);
  getCollab().broadcast(`ws:${found.workspaceId}`, "tree");
}

/** Makes someone in the teamspace an owner or a member of it. Needs to manage it. */
export async function setTeamspaceRole(actorId: string, teamspaceId: string, targetId: string, role: TeamspaceRole) {
  const { teamspace: found } = await manageableTeamspace(actorId, teamspaceId);
  const demoted = await db.transaction(async (tx) => {
    const record = () =>
      recordAudit(
        {
          workspaceId: found.workspaceId,
          actorId,
          action: "teamspace.role_changed",
          target: { type: "teamspace", id: teamspaceId, label: found.name },
          subject: { type: "user", id: targetId },
          details: { role },
        },
        tx,
      );
    const members = await tx
      .select({ userId: teamspaceMember.userId, role: teamspaceMember.role })
      .from(teamspaceMember)
      .where(eq(teamspaceMember.teamspaceId, teamspaceId))
      .for("update");
    const target = members.find((m) => m.userId === targetId);
    if (!target && found.access !== "default" && (await ownRow(tx, teamspaceId, targetId))?.direct === false) {
      // In through a group: making them an owner gives them a row of their own.
      if (role !== "owner") return;
      await tx.insert(teamspaceMember).values({ teamspaceId, userId: targetId, role: "owner" });
      await record();
      return;
    }
    if (!target) {
      // In a default teamspace everyone is a member without a row.
      const [person] = await tx
        .select({ role: workspaceMember.role })
        .from(workspaceMember)
        .where(and(eq(workspaceMember.workspaceId, found.workspaceId), eq(workspaceMember.userId, targetId)));
      if (found.access !== "default" || !person || isGuest(person.role)) {
        throw new TeamspaceError("notMember", "This person isn't in the teamspace.");
      }
      if (role !== "owner") return;
      await tx.insert(teamspaceMember).values({ teamspaceId, userId: targetId, role: "owner" });
      await record();
      return;
    }
    if (target.role === role) return false;
    if (role === "member" && found.access !== "default" && members.filter((m) => m.role === "owner").length <= 1) {
      throw new TeamspaceError("lastOwner", "Make someone else an owner of the teamspace first.");
    }
    if (role === "member" && found.access === "default") {
      // Default teamspaces only keep rows for their owners.
      await tx
        .delete(teamspaceMember)
        .where(and(eq(teamspaceMember.teamspaceId, teamspaceId), eq(teamspaceMember.userId, targetId)));
    } else {
      await tx
        .update(teamspaceMember)
        .set({ role })
        .where(and(eq(teamspaceMember.teamspaceId, teamspaceId), eq(teamspaceMember.userId, targetId)));
    }
    await record();
    return target.role === "owner";
  });
  await db.update(teamspace).set({ updatedAt: new Date() }).where(eq(teamspace.id, teamspaceId));
  // A teamspace owner has full access to its pages, a member what its member access gives: their
  // open editors are checked again.
  if (demoted) await getCollab().disconnectLostAccess(found.workspaceId, [targetId]);
}

export type TeamspacePerson = {
  userId: string;
  name: string;
  email: string;
  role: TeamspaceRole;
  joinedAt: Date;
  /** They have a row of their own; without one they are in it only through `groups`. */
  direct: boolean;
  /** The groups that put them in the teamspace (none in a default teamspace). */
  groups: string[];
};

/**
 * Who is in a teamspace, owners first: people with a row and everyone in its groups. Anyone who
 * can see the teamspace can see who is in it.
 */
export async function listTeamspaceMembers(userId: string, teamspaceId: string): Promise<TeamspacePerson[]> {
  const { teamspace: found } = await visibleTeamspace(userId, teamspaceId);
  if (found.access === "default") {
    const rows = await db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        role: sql<TeamspaceRole>`coalesce(${teamspaceMember.role}, 'member')`,
        joinedAt: workspaceMember.createdAt,
      })
      .from(workspaceMember)
      .innerJoin(user, eq(user.id, workspaceMember.userId))
      .leftJoin(
        teamspaceMember,
        and(eq(teamspaceMember.teamspaceId, teamspaceId), eq(teamspaceMember.userId, workspaceMember.userId)),
      )
      .where(and(eq(workspaceMember.workspaceId, found.workspaceId), inArray(workspaceMember.role, ["owner", "member"])));
    return sortPeople(rows.map((r) => ({ ...r, joinedAt: new Date(r.joinedAt), direct: true, groups: [] })));
  }
  const [direct, grouped] = await Promise.all([
    db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        role: teamspaceMember.role,
        joinedAt: teamspaceMember.createdAt,
      })
      .from(teamspaceMember)
      .innerJoin(user, eq(user.id, teamspaceMember.userId))
      .innerJoin(
        workspaceMember,
        and(eq(workspaceMember.userId, teamspaceMember.userId), eq(workspaceMember.workspaceId, found.workspaceId)),
      )
      .where(and(eq(teamspaceMember.teamspaceId, teamspaceId), inArray(workspaceMember.role, ["owner", "member"]))),
    db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        group: memberGroup.name,
        joinedAt: teamspaceGroup.createdAt,
      })
      .from(teamspaceGroup)
      .innerJoin(memberGroup, eq(memberGroup.id, teamspaceGroup.groupId))
      .innerJoin(memberGroupMember, eq(memberGroupMember.groupId, teamspaceGroup.groupId))
      .innerJoin(user, eq(user.id, memberGroupMember.userId))
      .where(eq(teamspaceGroup.teamspaceId, teamspaceId)),
  ]);
  const people = new Map<string, TeamspacePerson>(
    direct.map((r) => [r.userId, { ...r, joinedAt: new Date(r.joinedAt), direct: true, groups: [] }]),
  );
  for (const r of grouped) {
    const person = people.get(r.userId);
    if (person) {
      if (!person.groups.includes(r.group)) person.groups.push(r.group);
    } else {
      people.set(r.userId, {
        userId: r.userId,
        name: r.name,
        email: r.email,
        role: "member",
        joinedAt: new Date(r.joinedAt),
        direct: false,
        groups: [r.group],
      });
    }
  }
  for (const person of people.values()) person.groups.sort((a, b) => a.localeCompare(b));
  return sortPeople([...people.values()]);
}

const sortPeople = (people: TeamspacePerson[]) =>
  people.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "owner" ? -1 : 1));

export type TeamspaceGroupSummary = { id: string; name: string; memberCount: number; addedAt: Date };

/** The groups that joined a teamspace, by name. Anyone who can see the teamspace can see them. */
export async function listTeamspaceGroups(userId: string, teamspaceId: string): Promise<TeamspaceGroupSummary[]> {
  await visibleTeamspace(userId, teamspaceId);
  const rows = await db
    .select({
      id: memberGroup.id,
      name: memberGroup.name,
      memberCount: sql<number>`(select count(*) from ${memberGroupMember} gm where gm.group_id = ${memberGroup.id})::int`,
      addedAt: teamspaceGroup.createdAt,
    })
    .from(teamspaceGroup)
    .innerJoin(memberGroup, eq(memberGroup.id, teamspaceGroup.groupId))
    .where(eq(teamspaceGroup.teamspaceId, teamspaceId))
    .orderBy(sql`lower(${memberGroup.name})`);
  return rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) }));
}

/**
 * Adds groups of the workspace to the teamspace: everyone in them is in it as a member while they
 * are in the group. Needs to manage it. A default teamspace has everyone in it already.
 */
export async function addTeamspaceGroups(actorId: string, teamspaceId: string, groupIds: string[]) {
  const { teamspace: found } = await manageableTeamspace(actorId, teamspaceId);
  const wanted = [...new Set(groupIds)];
  if (!wanted.length) return;
  if (found.access === "default") {
    throw new TeamspaceError("everyoneIn", "Everyone is in this teamspace already.");
  }
  const groups = new Map<string, string>();
  for (const groupId of wanted) groups.set(groupId, (await requireGroupIn(found.workspaceId, groupId)).name);
  const added = await db
    .insert(teamspaceGroup)
    .values(wanted.map((groupId) => ({ teamspaceId, workspaceId: found.workspaceId, groupId })))
    .onConflictDoNothing()
    .returning({ groupId: teamspaceGroup.groupId });
  await db.update(teamspace).set({ updatedAt: new Date() }).where(eq(teamspace.id, teamspaceId));
  if (added.length) {
    await recordAudit({
      workspaceId: found.workspaceId,
      actorId,
      action: "teamspace.group_added",
      target: { type: "teamspace", id: teamspaceId, label: found.name },
      details: { names: added.map((a) => groups.get(a.groupId) ?? "") },
    });
  }
  getCollab().broadcast(`ws:${found.workspaceId}`, "tree");
}

/**
 * Takes a group out of the teamspace. Needs to manage it. Its members stay in the teamspace only by
 * a row of their own or another group; open editors of those who lost its pages are dropped, and
 * pages nobody could manage any more go to the person who did it.
 */
export async function removeTeamspaceGroup(actorId: string, teamspaceId: string, groupId: string) {
  const { teamspace: found } = await manageableTeamspace(actorId, teamspaceId);
  const members = await groupMemberIds(groupId);
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(teamspaceGroup)
      .where(and(eq(teamspaceGroup.teamspaceId, teamspaceId), eq(teamspaceGroup.groupId, groupId)))
      .returning({ groupId: teamspaceGroup.groupId });
    await tx.update(teamspace).set({ updatedAt: new Date() }).where(eq(teamspace.id, teamspaceId));
    await handOverOrphanedPages(tx, found.workspaceId, actorId);
    if (removed.length) {
      await recordAudit(
        {
          workspaceId: found.workspaceId,
          actorId,
          action: "teamspace.group_removed",
          target: { type: "teamspace", id: teamspaceId, label: found.name },
          subject: { type: "group", id: groupId },
        },
        tx,
      );
    }
  });

  await afterAccessLoss(found.workspaceId, members);
}

/**
 * For the members list: which of the teamspaces the viewer can see each person is in, by a row of
 * their own or a group (archived ones left out). Guests are in none.
 */
export async function teamspacesByMember(viewerId: string, workspaceId: string) {
  const visible = await listTeamspaces(viewerId, workspaceId);
  const byUser = new Map<string, { id: string; name: string; icon: string | null }[]>();
  if (!visible.length) return byUser;
  const people = await db
    .select({ userId: workspaceMember.userId, role: workspaceMember.role })
    .from(workspaceMember)
    .where(eq(workspaceMember.workspaceId, workspaceId));
  const ids = visible.map((t) => t.id);
  const [direct, grouped] = await Promise.all([
    db
      .select({ teamspaceId: teamspaceMember.teamspaceId, userId: teamspaceMember.userId })
      .from(teamspaceMember)
      .where(inArray(teamspaceMember.teamspaceId, ids)),
    db
      .select({ teamspaceId: teamspaceGroup.teamspaceId, userId: memberGroupMember.userId })
      .from(teamspaceGroup)
      .innerJoin(memberGroupMember, eq(memberGroupMember.groupId, teamspaceGroup.groupId))
      .where(inArray(teamspaceGroup.teamspaceId, ids)),
  ]);
  const rows = [...direct, ...grouped];
  for (const person of people) {
    if (isGuest(person.role)) continue;
    const theirs = visible.filter(
      (t) => t.access === "default" || rows.some((r) => r.teamspaceId === t.id && r.userId === person.userId),
    );
    byUser.set(person.userId, theirs.map(({ id, name, icon }) => ({ id, name, icon })));
  }
  return byUser;
}

/** The teamspace's id, name and icon when the user can see it (see visibleTeamspace), else null. */
export async function teamspaceLabel(userId: string, teamspaceId: string) {
  try {
    const { teamspace: found } = await visibleTeamspace(userId, teamspaceId);
    return { id: found.id, name: found.name, icon: found.icon };
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

/**
 * Who a teamspace page's "everyone" entry reaches: its access and who is in it by row or group
 * (everyone when it is a default one). Only for callers that already checked access to such a page.
 */
export async function teamspaceReach(teamspaceId: string): Promise<TeamspaceReach> {
  const [found] = await db
    .select({ access: teamspace.access, memberLevel: teamspace.memberLevel })
    .from(teamspace)
    .where(eq(teamspace.id, teamspaceId));
  const [rows, grouped] = await Promise.all([
    db.select({ userId: teamspaceMember.userId, role: teamspaceMember.role }).from(teamspaceMember).where(eq(teamspaceMember.teamspaceId, teamspaceId)),
    db
      .select({ userId: memberGroupMember.userId })
      .from(teamspaceGroup)
      .innerJoin(memberGroupMember, eq(memberGroupMember.groupId, teamspaceGroup.groupId))
      .where(eq(teamspaceGroup.teamspaceId, teamspaceId)),
  ]);
  return {
    access: (found?.access ?? "private") as TeamspaceAccess,
    members: new Set([...rows, ...grouped].map((r) => r.userId)),
    owners: new Set(rows.filter((r) => r.role === "owner").map((r) => r.userId)),
    memberLevel: found?.memberLevel ?? "full",
  };
}

/** The teamspaces the user is in and that aren't archived: the sidebar's sections. */
export async function sidebarTeamspaces(userId: string, workspaceId: string) {
  const membership = await requireMember(userId, workspaceId).catch(() => null);
  if (!membership) return [];
  return (await listTeamspaces(userId, workspaceId)).filter((t) => t.joined);
}

/**
 * Throws unless the user may add pages at the top of the teamspace: they are in it (owners and
 * members only), it belongs to the workspace and it isn't archived.
 */
export async function requireTeamspaceForPages(userId: string, teamspaceId: string, workspaceId: string) {
  const [found] = await db
    .select()
    .from(teamspace)
    .where(and(eq(teamspace.id, teamspaceId), eq(teamspace.workspaceId, workspaceId)))
    .limit(1);
  if (!found) throw new AccessError();
  const membership = await requireMember(userId, workspaceId);
  if (isGuest(membership.role)) throw new AccessError();
  const row = await ownRow(db, teamspaceId, userId);
  if (!joinedTeamspace(found, row)) {
    if (found.access === "private") throw new AccessError();
    throw new TeamspaceError("notMember", "Join the teamspace to add pages to it.");
  }
  if (found.archivedAt) throw new TeamspaceError("archived", "This teamspace is archived.");
  return found;
}

/** The oldest default teamspace that isn't archived: where top-level pages go when nobody says. */
export async function defaultTeamspaceId(workspaceId: string) {
  const [row] = await db
    .select({ id: teamspace.id })
    .from(teamspace)
    .where(and(eq(teamspace.workspaceId, workspaceId), eq(teamspace.access, "default"), isNull(teamspace.archivedAt)))
    .orderBy(asc(teamspace.createdAt), asc(teamspace.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Where a new top-level page of `userId` goes. `requested`: a teamspace id (they must be in it),
 * null for their private pages, or undefined for the workspace's first default teamspace (private
 * when there is none). A guest's top-level pages are always private (when the workspace lets
 * them add any: `topLevel` from `topLevelAccess`).
 */
export async function placeTopLevel(
  userId: string,
  workspaceId: string,
  topLevel: "shared" | "private",
  requested: string | null | undefined,
): Promise<{ teamspaceId: string | null; private: boolean }> {
  if (topLevel === "private") {
    if (requested) throw new AccessError();
    return { teamspaceId: null, private: true };
  }
  if (requested === null) return { teamspaceId: null, private: true };
  if (requested === undefined) {
    const fallback = await defaultTeamspaceId(workspaceId);
    return fallback ? { teamspaceId: fallback, private: false } : { teamspaceId: null, private: true };
  }
  await requireTeamspaceForPages(userId, requested, workspaceId);
  return { teamspaceId: requested, private: false };
}

/**
 * After someone left the workspace or became a guest: they are out of its teamspaces, and a
 * teamspace they were the last owner of passes to its oldest member, or to `heirId` (the owner who
 * removed them, else the oldest workspace owner) when nobody is left in it, so no teamspace is
 * stranded without anyone able to run it or, when private, even see it.
 */
export async function dropFromTeamspaces(tx: Tx, workspaceId: string, userId: string, heirId: string | null) {
  const left = await tx.execute<{ teamspace_id: string }>(sql`
    delete from ${teamspaceMember} m
    using ${teamspace} t
    where t.id = m.teamspace_id and t.workspace_id = ${workspaceId} and m.user_id = ${userId}
    returning m.teamspace_id
  `);
  for (const { teamspace_id: teamspaceId } of left) {
    const [ts] = await tx.select({ access: teamspace.access }).from(teamspace).where(eq(teamspace.id, teamspaceId));
    if (!ts || ts.access === "default") continue;
    const rest = await tx
      .select({ userId: teamspaceMember.userId, role: teamspaceMember.role })
      .from(teamspaceMember)
      .innerJoin(
        workspaceMember,
        and(eq(workspaceMember.userId, teamspaceMember.userId), eq(workspaceMember.workspaceId, workspaceId)),
      )
      .where(and(eq(teamspaceMember.teamspaceId, teamspaceId), inArray(workspaceMember.role, ["owner", "member"])))
      .orderBy(asc(teamspaceMember.createdAt));
    if (rest.some((m) => m.role === "owner")) continue;
    const next = rest[0]?.userId ?? heirId;
    if (!next || next === userId) continue;
    await tx
      .insert(teamspaceMember)
      .values({ teamspaceId, userId: next, role: "owner" })
      .onConflictDoUpdate({ target: [teamspaceMember.teamspaceId, teamspaceMember.userId], set: { role: "owner" } });
  }
}

/** Names the General teamspace the database gives a new workspace, and makes its creator its owner. */
export async function setUpGeneralTeamspace(tx: Tx, workspaceId: string, ownerId: string, name: string) {
  const [general] = await tx
    .update(teamspace)
    .set({ name, createdBy: ownerId })
    .where(and(eq(teamspace.workspaceId, workspaceId), eq(teamspace.access, "default")))
    .returning({ id: teamspace.id });
  if (general) await tx.insert(teamspaceMember).values({ teamspaceId: general.id, userId: ownerId, role: "owner" }).onConflictDoNothing();
}
