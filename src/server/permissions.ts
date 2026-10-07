import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accessRequest,
  memberGroup,
  memberGroupMember,
  PAGE_LEVELS,
  pageGroupPermission,
  pageInvitation,
  pagePermission,
  teamspace,
  type PageLevel,
  user,
  workspaceAgent,
  workspaceInvitation,
  workspaceMember,
} from "@/db/schema";
import { teamspaceLabel, teamspaceReach } from "@/server/teamspaces";
import { everyoneFloor } from "@/lib/teamspace-reach";
import { isAgentEmail } from "@/lib/agents";
import { isEmail, normalizeEmail } from "@/lib/emails";
import { AccessError, FULL_RANK, getMembership, hasLevel, requirePageAccess, resolvePageAccess } from "@/server/access";
import { isAgentUser, notAgentUser } from "@/server/agents/users";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { afterAccessLoss, groupMemberIds, requireGroupIn } from "@/server/groups";
import { recordShare, signalInbox, withdrawShare } from "@/server/notifications";
import { addGuest, canInviteGuests, type InvitationDelivery, inviteGuest } from "@/server/workspaces";

/**
 * Who a page is shared with. An entry gives one member (`userId`) or everyone with a member role
 * (`userId` null) a level on the page and its subpages, until a subpage has its own entry for the
 * same principal. Groups have entries of their own (`page_group_permission`) that work the same
 * way for everyone in the group. The rule that reads these entries is `page_access_level` in the
 * database; someone gets the highest level any of them gives.
 */

export type PermissionErrorCode = "notMember" | "lastFullAccess" | "invalidEmail" | "invitesRestricted" | "agentFullAccess";

export class PermissionError extends Error {
  readonly code: PermissionErrorCode;

  constructor(code: PermissionErrorCode, message: string) {
    super(message);
    this.name = "PermissionError";
    this.code = code;
  }
}

export type PermissionEntry = {
  userId: string | null;
  name: string | null;
  /** Null for agents, whose address is no one's. */
  email: string | null;
  image: string | null;
  /** The entry is an agent's (its access is managed in the agent's settings too). */
  isAgent: boolean;
  /** The agent's icon, an emoji. */
  agentIcon: string | null;
  level: PageLevel;
  /** The page the entry is set on: this page, or the ancestor it is inherited from. */
  sourcePageId: string;
  sourceTitle: string;
  inherited: boolean;
};

/** A group's entry on the page or the ancestor it is inherited from, like a person's. */
export type GroupPermissionEntry = {
  groupId: string;
  name: string;
  memberCount: number;
  level: PageLevel;
  sourcePageId: string;
  sourceTitle: string;
  inherited: boolean;
};

/**
 * The entries that apply to a page: for each principal the one on the page itself or its nearest
 * ancestor. Entries for people who have left the workspace are left out, since they grant nothing.
 * `everyone` is what members get without a user entry: the teamspace's member level (or nobody on a
 * private page) when nothing on the page or above it sets it.
 */
export async function listPagePermissions(userId: string, pageId: string) {
  const { page: target, level } = await resolvePageAccess(userId, pageId);
  if (!target || !hasLevel(level, "view")) throw new AccessError();
  const rows = await db.execute<{
    user_id: string | null;
    level: PageLevel;
    page_id: string;
    title: string;
    name: string | null;
    email: string | null;
    image: string | null;
    agent_id: string | null;
    agent_icon: string | null;
  }>(sql`
    with recursive chain as (
      select id, parent_id, 0 as depth from page where id = ${pageId}
      union all
      select p.id, p.parent_id, c.depth + 1 from page p join chain c on p.id = c.parent_id where c.depth < 64
    )
    select distinct on (pp.user_id) pp.user_id, pp.level, pp.page_id, src.title, u.name, u.email, u.image,
      wa.id as agent_id, wa.icon as agent_icon
    from chain c
    join page_permission pp on pp.page_id = c.id
    join page src on src.id = c.id
    left join "user" u on u.id = pp.user_id
    left join ${workspaceAgent} wa on wa.user_id = pp.user_id
    where pp.user_id is null
      or exists (
        select 1 from ${workspaceMember} wm
        where wm.workspace_id = ${target.workspaceId} and wm.user_id = pp.user_id
      )
    order by pp.user_id nulls first, c.depth
  `);
  const entries: PermissionEntry[] = rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.agent_id ? null : r.email,
    image: r.image,
    isAgent: r.agent_id !== null,
    agentIcon: r.agent_icon,
    level: r.level,
    sourcePageId: r.page_id,
    sourceTitle: r.title,
    inherited: r.page_id !== pageId,
  }));
  const groupRows = await db.execute<{
    group_id: string;
    level: PageLevel;
    page_id: string;
    title: string;
    name: string;
    member_count: number;
  }>(sql`
    with recursive chain as (
      select id, parent_id, 0 as depth from page where id = ${pageId}
      union all
      select p.id, p.parent_id, c.depth + 1 from page p join chain c on p.id = c.parent_id where c.depth < 64
    )
    select distinct on (gp.group_id) gp.group_id, gp.level, gp.page_id, src.title, g.name,
      (select count(*) from ${memberGroupMember} gm where gm.group_id = gp.group_id)::int as member_count
    from chain c
    join ${pageGroupPermission} gp on gp.page_id = c.id
    join ${memberGroup} g on g.id = gp.group_id
    join page src on src.id = c.id
    order by gp.group_id, c.depth
  `);
  const groups: GroupPermissionEntry[] = groupRows
    .map((r) => ({
      groupId: r.group_id,
      name: r.name,
      memberCount: Number(r.member_count),
      level: r.level,
      sourcePageId: r.page_id,
      sourceTitle: r.title,
      inherited: r.page_id !== pageId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // "Everyone" means the teamspace's members for a teamspace's page (the teamspace's member level
  // unless the page sets it), and the whole workspace for a private page (nobody unless shared).
  const space = target.teamspaceId ? await teamspaceLabel(userId, target.teamspaceId) : null;
  const reach = target.teamspaceId ? await teamspaceReach(target.teamspaceId) : null;
  const own = entries.find((e) => e.userId === null)?.level;
  const everyone = own ?? (reach ? (reach.memberLevel ?? "full") : "none");
  const manages = hasLevel(level, "full");
  // For those who manage it: the least each owner or member of the workspace gets from "everyone",
  // as page_access_level works it out. In the teamspace (or any of the workspace for a private
  // page): all of it, full for the owners where the teamspace decides; an open teamspace's other
  // members: up to comment; anyone else: nothing.
  const floors: Record<string, PageLevel> = {};
  if (manages) {
    const people = await db
      .select({ userId: workspaceMember.userId, role: workspaceMember.role })
      .from(workspaceMember)
      .where(eq(workspaceMember.workspaceId, target.workspaceId));
    for (const p of people) {
      if (p.role !== "guest") {
        floors[p.userId] = everyoneFloor(everyone, reach, p.userId, { fromTeamspace: own === undefined, workspaceOwner: p.role === "owner" });
      }
    }
  }
  // Only those who manage the page see whom it waits for.
  const invitations = manages
    ? await db
        .select({ email: pageInvitation.email, level: pageInvitation.level })
        .from(pageInvitation)
        .where(eq(pageInvitation.pageId, pageId))
        .orderBy(asc(pageInvitation.createdAt))
    : [];
  return {
    level,
    everyone,
    /** Whether "everyone" is the teamspace's member level (no page entry sets it). */
    everyoneFromTeamspace: reach !== null && own === undefined,
    /** Private pages are in no teamspace; a teamspace's name shows only to those who can see the teamspace. */
    space: target.teamspaceId ? { kind: "teamspace" as const, name: space?.name ?? null } : { kind: "private" as const },
    entries: entries.filter((e) => e.userId !== null),
    groups,
    floors,
    invitations,
  };
}

export type ShareByEmailResult =
  | { kind: "shared" }
  | { kind: "added" }
  | { kind: "invited"; email: string; link: string; delivery: InvitationDelivery };

/**
 * Shares the page with whoever uses `email`. Someone in the workspace gets the level right away;
 * an account outside it joins as a guest; anyone else is invited as a guest and gets the page
 * once they accept. Needs full access; bringing new people in also needs `canInviteGuests`.
 */
export async function sharePageByEmail(
  actorId: string,
  pageId: string,
  email: string,
  level: Exclude<PageLevel, "none">,
): Promise<ShareByEmailResult> {
  const target = await requirePageAccess(actorId, pageId, "full");
  const clean = normalizeEmail(email);
  // Agents' addresses are no one's: pages are shared with an agent from its settings.
  if (!isEmail(clean) || isAgentEmail(clean)) throw new PermissionError("invalidEmail", "Enter a valid email address");
  const [account] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(sql`lower(${user.email})`, clean), notAgentUser(user.id)))
    .limit(1);
  if (account && (await getMembership(account.id, target.workspaceId))) {
    await setPagePermission(actorId, pageId, account.id, level);
    return { kind: "shared" };
  }
  if (!(await canInviteGuests(actorId, target.workspaceId))) {
    throw new PermissionError("invitesRestricted", "This workspace doesn't let you share pages with new people");
  }
  if (account) {
    await addGuest(actorId, target.workspaceId, account.id, clean);
    await setPagePermission(actorId, pageId, account.id, level);
    return { kind: "added" };
  }
  await db
    .insert(pageInvitation)
    .values({ pageId, workspaceId: target.workspaceId, email: clean, level, invitedBy: actorId })
    .onConflictDoUpdate({
      target: [pageInvitation.pageId, pageInvitation.email],
      set: { level, invitedBy: actorId, createdAt: new Date() },
    });
  // The page waits for them under their address; the guest invitation is recorded by inviteGuest.
  await recordAudit({
    workspaceId: target.workspaceId,
    actorId,
    action: "page.permission_changed",
    target: { type: "page", id: pageId },
    subject: { type: "email", id: clean, label: clean },
    details: { level },
  });
  const { link, delivery } = await inviteGuest(actorId, target.workspaceId, clean);
  return { kind: "invited", email: clean, link, delivery };
}

/**
 * Stops waiting for `email` on this page. A guest invitation that no page waits on any more is
 * withdrawn too, since it would only let them into an empty workspace. Needs full access.
 */
export async function removePageInvitation(actorId: string, pageId: string, email: string) {
  const target = await requirePageAccess(actorId, pageId, "full");
  const clean = normalizeEmail(email);
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(pageInvitation)
      .where(and(eq(pageInvitation.pageId, pageId), eq(pageInvitation.email, clean)))
      .returning({ level: pageInvitation.level });
    for (const { level } of removed) {
      await recordAudit(
        {
          workspaceId: target.workspaceId,
          actorId,
          action: "page.permission_removed",
          target: { type: "page", id: pageId },
          subject: { type: "email", id: clean, label: clean },
          details: { previous: level },
        },
        tx,
      );
    }
    const [left] = await tx
      .select({ id: pageInvitation.id })
      .from(pageInvitation)
      .where(and(eq(pageInvitation.workspaceId, target.workspaceId), eq(pageInvitation.email, clean)))
      .limit(1);
    if (!left) {
      await tx
        .delete(workspaceInvitation)
        .where(
          and(
            eq(workspaceInvitation.workspaceId, target.workspaceId),
            eq(workspaceInvitation.email, clean),
            eq(workspaceInvitation.role, "guest"),
          ),
        );
    }
  });
}

/**
 * Sets what `principal` (a member's id, or null for everyone) gets on the page. Needs full access.
 * A member whose own entry is new or raised hears about it in their inbox; setting it to "none"
 * takes that back while it is unread. Open editors of whoever it narrowed for are dropped: a
 * connection's access is only checked when it opens.
 */
export async function setPagePermission(actorId: string, pageId: string, principal: string | null, level: PageLevel) {
  const target = await requirePageAccess(actorId, pageId, "full");
  if (principal && !(await getMembership(principal, target.workspaceId))) {
    throw new PermissionError("notMember", "Pages can only be shared with workspace members");
  }
  // An agent doesn't share pages, manage databases or receive access requests.
  if (principal && level === "full" && (await isAgentUser(principal))) {
    throw new PermissionError("agentFullAccess", "Agents can view, comment on or edit a page, never get full access");
  }
  const [previous] = await db
    .select({ level: pagePermission.level })
    .from(pagePermission)
    .where(and(eq(pagePermission.pageId, pageId), principal ? eq(pagePermission.userId, principal) : isNull(pagePermission.userId)));
  await changePermissions(target.workspaceId, pageId, async (tx) => {
    await tx
      .insert(pagePermission)
      .values({ pageId, workspaceId: target.workspaceId, userId: principal, level, createdBy: actorId })
      .onConflictDoUpdate({
        target: [pagePermission.pageId, pagePermission.userId],
        set: { level, createdBy: actorId, createdAt: new Date() },
      });
    if (previous?.level !== level) {
      await recordAudit(
        {
          workspaceId: target.workspaceId,
          actorId,
          action: "page.permission_changed",
          target: { type: "page", id: pageId },
          subject: principal ? { type: "user", id: principal } : { type: "everyone" },
          details: { level, previous: previous?.level ?? null },
        },
        tx,
      );
    }
  });
  await dropLostEditors(target.workspaceId, principal);
  if (!principal) return;
  if (level === "none") await withdrawShare(target.workspaceId, principal, pageId);
  else {
    // Sharing the page answers their request for it, whichever way it was shared.
    const answered = await db
      .delete(accessRequest)
      .where(and(eq(accessRequest.pageId, pageId), eq(accessRequest.requesterId, principal)))
      .returning({ id: accessRequest.id });
    if (answered.length) signalInbox(target.workspaceId);
    if (!previous || PAGE_LEVELS.indexOf(level) > PAGE_LEVELS.indexOf(previous.level)) {
      await recordShare(actorId, target.workspaceId, principal, pageId);
    }
  }
}

/**
 * Removes the page's own entry for `principal`, so it inherits again, and its unread notification.
 * Needs full access. What it inherits may be less, so open editors are checked again.
 */
export async function removePagePermission(actorId: string, pageId: string, principal: string | null) {
  const target = await requirePageAccess(actorId, pageId, "full");
  await changePermissions(target.workspaceId, pageId, async (tx) => {
    const removed = await tx
      .delete(pagePermission)
      .where(
        and(
          eq(pagePermission.pageId, pageId),
          principal ? eq(pagePermission.userId, principal) : isNull(pagePermission.userId),
        ),
      )
      .returning({ level: pagePermission.level });
    for (const { level } of removed) {
      await recordAudit(
        {
          workspaceId: target.workspaceId,
          actorId,
          action: "page.permission_removed",
          target: { type: "page", id: pageId },
          subject: principal ? { type: "user", id: principal } : { type: "everyone" },
          details: { previous: level },
        },
        tx,
      );
    }
  });
  await dropLostEditors(target.workspaceId, principal);
  if (principal) await withdrawShare(target.workspaceId, principal, pageId);
}

/** Drops the open editors `principal` (a member, or everyone for null) may no longer use. */
const dropLostEditors = (workspaceId: string, principal: string | null) =>
  getCollab().disconnectLostAccess(workspaceId, principal ? [principal] : undefined);

const rankOf = (level: PageLevel) => PAGE_LEVELS.indexOf(level);

/**
 * Sets what a group of the page's workspace gets on the page, like a person's own entry, for
 * everyone in the group. Needs full access. Lowering it drops the open editors of the group's
 * members that lost access. Members aren't notified one by one: a group can be large.
 */
export async function setPageGroupPermission(actorId: string, pageId: string, groupId: string, level: PageLevel) {
  const target = await requirePageAccess(actorId, pageId, "full");
  await requireGroupIn(target.workspaceId, groupId);
  const [previous] = await db
    .select({ level: pageGroupPermission.level })
    .from(pageGroupPermission)
    .where(and(eq(pageGroupPermission.pageId, pageId), eq(pageGroupPermission.groupId, groupId)));
  await changePermissions(target.workspaceId, pageId, async (tx) => {
    await tx
      .insert(pageGroupPermission)
      .values({ pageId, workspaceId: target.workspaceId, groupId, level, createdBy: actorId })
      .onConflictDoUpdate({
        target: [pageGroupPermission.pageId, pageGroupPermission.groupId],
        set: { level, createdBy: actorId, createdAt: new Date() },
      });
    if (previous?.level !== level) {
      await recordAudit(
        {
          workspaceId: target.workspaceId,
          actorId,
          action: "page.permission_changed",
          target: { type: "page", id: pageId },
          subject: { type: "group", id: groupId },
          details: { level, previous: previous?.level ?? null },
        },
        tx,
      );
    }
  });
  if (previous && rankOf(level) < rankOf(previous.level)) {
    await afterAccessLoss(target.workspaceId, await groupMemberIds(groupId));
  }
}

/** Removes the page's own entry for a group, so it inherits again. Needs full access. */
export async function removePageGroupPermission(actorId: string, pageId: string, groupId: string) {
  const target = await requirePageAccess(actorId, pageId, "full");
  await changePermissions(target.workspaceId, pageId, async (tx) => {
    const removed = await tx
      .delete(pageGroupPermission)
      .where(and(eq(pageGroupPermission.pageId, pageId), eq(pageGroupPermission.groupId, groupId)))
      .returning({ level: pageGroupPermission.level });
    for (const { level } of removed) {
      await recordAudit(
        {
          workspaceId: target.workspaceId,
          actorId,
          action: "page.permission_removed",
          target: { type: "page", id: pageId },
          subject: { type: "group", id: groupId },
          details: { previous: level },
        },
        tx,
      );
    }
  });

  await afterAccessLoss(target.workspaceId, await groupMemberIds(groupId));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Makes a page only `userId` can see: nobody else by default, them with full access. For a
 * private top-level page (outside any teamspace); run it in the transaction that creates the
 * page, so it is never visible to anyone else in between.
 */
export async function makePagePrivate(tx: Tx, workspaceId: string, pageId: string, userId: string) {
  await tx.delete(pagePermission).where(eq(pagePermission.pageId, pageId));
  await tx.delete(pageGroupPermission).where(eq(pageGroupPermission.pageId, pageId));
  await tx.insert(pagePermission).values([
    { pageId, workspaceId, userId: null, level: "none", createdBy: userId },
    { pageId, workspaceId, userId, level: "full", createdBy: userId },
  ]);
}

/**
 * Keeps full access for whoever puts a page at the top of a teamspace whose members get less (see
 * TEAMSPACE_MEMBER_LEVELS): they made it, copied it or moved it there, and could otherwise neither
 * share it nor set who may see its properties. Run in the transaction that places it; nothing is
 * written when they have full access anyway (the teamspace's or the workspace's owners, say).
 */
export async function keepFullAccess(tx: Tx, workspaceId: string, pageId: string, userId: string) {
  // Only where the teamspace lowered its members' level: elsewhere nothing changes.
  const [row] = await tx.execute<{ level: number }>(sql`
    select page_access_level(${userId}, p.id) as level
    from page p join ${teamspace} t on t.id = p.teamspace_id
    where p.id = ${pageId} and t.member_level <> 'full'
  `);
  if (!row || Number(row.level) >= FULL_RANK) return;
  // An entry of their own (copied along with a page, say) stays as it is.
  await tx.insert(pagePermission).values({ pageId, workspaceId, userId, level: "full", createdBy: userId }).onConflictDoNothing();
}

const lockPermissions = (tx: Tx, workspaceId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`page_permission:${workspaceId}`}))`);

/**
 * After `pageId` moved (by `userId`, who has full access to it), in the move's transaction:
 * - into another teamspace, or into or out of the private pages (`changedSpace`), the page drops
 *   its own "everyone" entry and so takes the access of its new place: its new teamspace's, or
 *   nobody's but the people it is shared with. People named on it keep their entries.
 * - into the private pages (`toPrivate`), "everyone" entries below it that open pages up are
 *   dropped too: outside a teamspace they would open them to the whole workspace. Entries that
 *   close pages ("none") stay.
 * - to the top of the private pages (`privateTop`), the mover keeps full access by an entry of
 *   their own, since nothing above gives it to them any more.
 */
export async function followNewSpace(
  tx: Tx,
  workspaceId: string,
  pageId: string,
  userId: string,
  { changedSpace, toPrivate, privateTop }: { changedSpace: boolean; toPrivate: boolean; privateTop: boolean },
) {
  if (!changedSpace && !privateTop) return;
  await lockPermissions(tx, workspaceId);
  if (changedSpace) {
    await tx.delete(pagePermission).where(and(eq(pagePermission.pageId, pageId), isNull(pagePermission.userId)));
    if (toPrivate) {
      await tx.execute(sql`
        delete from ${pagePermission} pp
        where pp.user_id is null and pp.level <> 'none' and pp.page_id in (
          with recursive sub as (
            select id from page where id = ${pageId}
            union all
            select p.id from page p join sub on p.parent_id = sub.id
          ) select id from sub
        )
      `);
    }
  }
  if (privateTop) {
    await tx
      .insert(pagePermission)
      .values({ pageId, workspaceId, userId, level: "full", createdBy: userId })
      .onConflictDoUpdate({
        target: [pagePermission.pageId, pagePermission.userId],
        set: { level: "full", createdBy: userId, createdAt: new Date() },
      });
  }
}

/**
 * Gives `pageId` entries of its own for what it inherits from its ancestors now, for each
 * principal (person, group or everyone) that has no entry on the page itself. Run before it loses those ancestors (restored
 * out of a deleted parent), so it keeps the access it had.
 */
export async function freezeInheritedEntries(tx: Tx, workspaceId: string, pageId: string) {
  await lockPermissions(tx, workspaceId);
  await tx.execute(sql`
    insert into ${pagePermission} (id, page_id, workspace_id, user_id, level, created_by)
    select gen_random_uuid()::text, ${pageId}, inherited.workspace_id, inherited.user_id, inherited.level, inherited.created_by
    from (
      with recursive chain as (
        select p.id, p.parent_id, 1 as depth from page p where p.id = (select parent_id from page where id = ${pageId})
        union all
        select p.id, p.parent_id, c.depth + 1 from page p join chain c on p.id = c.parent_id where c.depth < 64
      )
      select distinct on (pp.user_id) pp.workspace_id, pp.user_id, pp.level, pp.created_by
      from chain c join ${pagePermission} pp on pp.page_id = c.id
      order by pp.user_id nulls first, c.depth
    ) inherited
    on conflict (page_id, user_id) do nothing
  `);
  await tx.execute(sql`
    insert into ${pageGroupPermission} (id, page_id, workspace_id, group_id, level, created_by)
    select gen_random_uuid()::text, ${pageId}, inherited.workspace_id, inherited.group_id, inherited.level, inherited.created_by
    from (
      with recursive chain as (
        select p.id, p.parent_id, 1 as depth from page p where p.id = (select parent_id from page where id = ${pageId})
        union all
        select p.id, p.parent_id, c.depth + 1 from page p join chain c on p.id = c.parent_id where c.depth < 64
      )
      select distinct on (gp.group_id) gp.workspace_id, gp.group_id, gp.level, gp.created_by
      from chain c join ${pageGroupPermission} gp on gp.page_id = c.id
      order by gp.group_id, c.depth
    ) inherited
    on conflict (page_id, group_id) do nothing
  `);
}

/**
 * Applies a change and rolls it back if it leaves the page, or a subpage with entries of its own,
 * without any member who has full access: nobody could share or delete it any more. Changes in one
 * workspace are serialized so two of them can't each pass the check and together fail it.
 */
async function changePermissions(workspaceId: string, pageId: string, change: (tx: Tx) => Promise<void>) {
  await db.transaction(async (tx) => {
    await lockPermissions(tx, workspaceId);
    await change(tx);
    const orphans = await tx.execute<{ id: string }>(sql`
      with recursive sub as (
        select id from page where id = ${pageId}
        union all
        select p.id from page p join sub on p.parent_id = sub.id
      )
      select s.id from sub s
      where (s.id = ${pageId}
          or exists (select 1 from ${pagePermission} pp where pp.page_id = s.id)
          or exists (select 1 from ${pageGroupPermission} gp where gp.page_id = s.id))
        and not exists (
          select 1 from ${workspaceMember} wm
          where wm.workspace_id = ${workspaceId} and page_access_level(wm.user_id, s.id) = ${FULL_RANK}
        )
      limit 1
    `);
    if (orphans.length) {
      throw new PermissionError("lastFullAccess", "Someone in the workspace must keep full access to the page");
    }
  });
}
