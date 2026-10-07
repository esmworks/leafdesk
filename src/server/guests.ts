import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  page,
  pageInvitation,
  pagePermission,
  type PageKind,
  type PageLevel,
  user,
  workspaceInvitation,
  workspaceMember,
} from "@/db/schema";
import { AccessError, accessRank, FULL_RANK, getMembership, pageIdColumn } from "@/server/access";
import { notAgentUser } from "@/server/agents/users";
import { canInviteGuests } from "@/server/workspaces";

/**
 * Settings > Guests: who is in the workspace as a guest, and what they were given. For the people
 * who may bring guests in (`canInviteGuests`): owners, and members when the workspace lets them.
 *
 * A guest sees a page through an entry of their own on it or an ancestor (see
 * `page_access_level`), so their own entries are the whole of what they were given: subpages that
 * inherit an entry aren't listed again. Entries that take access away ("none") aren't access and
 * are left out. What the viewer can't see themselves is only counted, never named, the way every
 * other list keeps restricted pages out of sight; owners don't see other people's private pages
 * either. Agents are guests too, but no people: they and what is shared with them are managed in
 * the agents' own settings, not here.
 *
 * Nothing here changes anything: the tab removes access with `removePagePermission` and
 * `removePageInvitation`, and changes roles with `setMemberRole` and `removeMember`, which check
 * who may do it.
 */

export type GuestPage = {
  pageId: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  level: PageLevel;
  /** Who gave it: the entry's author, or the page invitation's. Null when their account is gone. */
  by: { id: string; name: string } | null;
  at: Date;
  inTrash: boolean;
  /** The viewer has full access to the page, so they may take this away. */
  canManage: boolean;
};

export type Guest = {
  /** Null for someone invited who hasn't joined yet. */
  userId: string | null;
  name: string;
  email: string;
  image: string | null;
  /** When they joined, or were invited. */
  addedAt: Date;
  /**
   * Who sent the invitation, or for someone who joined, who brought them in (see `listGuests`).
   * Null when that isn't known.
   */
  invitedBy: { id: string; name: string } | null;
  /** Invited but not joined: when their invitation link stops working. */
  expiresAt: Date | null;
  /** The workspace invitation, for owners to withdraw; null for everyone else. */
  invitationId: string | null;
  pages: GuestPage[];
  /** Pages they have an entry on that the viewer can't see. */
  hiddenPages: number;
  /** Pages shared with their email that wait for them to join. */
  invitations: GuestPage[];
  hiddenInvitations: number;
};

/** Owners, or members the workspace lets invite guests; anyone else gets AccessError. */
export async function requireGuestManager(userId: string, workspaceId: string) {
  const [allowed, membership] = await Promise.all([canInviteGuests(userId, workspaceId), getMembership(userId, workspaceId)]);
  if (!allowed) throw new AccessError();
  return { isOwner: membership?.role === "owner" };
}

type EntryRow = {
  page_id: string;
  principal: string;
  level: PageLevel;
  at: Date | string;
  by_id: string | null;
  by_name: string | null;
  title: string;
  icon: string | null;
  kind: PageKind;
  in_trash: boolean;
  viewer: number;
};

/** Splits rows into the pages the viewer may see, by principal (a user id or an email), and counts the rest. */
function byPrincipal(rows: EntryRow[]) {
  const shown = new Map<string, GuestPage[]>();
  const hidden = new Map<string, number>();
  for (const r of rows) {
    const viewer = Number(r.viewer);
    if (viewer <= 0) {
      hidden.set(r.principal, (hidden.get(r.principal) ?? 0) + 1);
      continue;
    }
    const list = shown.get(r.principal) ?? [];
    list.push({
      pageId: r.page_id,
      title: r.title,
      icon: r.icon,
      kind: r.kind,
      level: r.level,
      by: r.by_id ? { id: r.by_id, name: r.by_name ?? "" } : null,
      at: new Date(r.at),
      inTrash: Boolean(r.in_trash),
      canManage: viewer >= FULL_RANK,
    });
    shown.set(r.principal, list);
  }
  // Pages in use first, then those in the trash (they come back with their access when restored).
  for (const list of shown.values()) {
    list.sort((a, b) => Number(a.inTrash) - Number(b.inTrash) || (a.title || "").localeCompare(b.title || ""));
  }
  return { shown, hidden };
}

/**
 * The workspace's guests and the people invited as guests who haven't joined, with the pages each
 * was given and the page invitations waiting for them. Members see an invited guest only when a
 * page they can see waits for them; the workspace's invitations are otherwise for owners.
 */
export async function listGuests(actorId: string, workspaceId: string): Promise<Guest[]> {
  const { isOwner } = await requireGuestManager(actorId, workspaceId);
  const inviter = alias(user, "inviter");
  const [members, invited, entries, pending] = await Promise.all([
    // Who brought them in, as the membership records it (`invited_by`). Where it doesn't (the
    // inviter's account is gone, or they joined before it was recorded and the migration found
    // nothing better), the author of their oldest entry by someone else, since guests arrive by a
    // page being shared with their address (an entry changed since counts from the change, by
    // whoever changed it).
    db.execute<{
      user_id: string;
      name: string;
      email: string;
      image: string | null;
      added_at: Date | string;
      invited_by_id: string | null;
      invited_by_name: string | null;
    }>(sql`
      select wm.user_id, u.name, u.email, u.image, wm.created_at as added_at,
        inviter.id as invited_by_id, inviter.name as invited_by_name
      from ${workspaceMember} wm
      join ${user} u on u.id = wm.user_id
      left join lateral (
        select pp.created_by from ${pagePermission} pp
        where wm.invited_by is null
          and pp.workspace_id = wm.workspace_id and pp.user_id = wm.user_id
          and pp.created_by is not null and pp.created_by <> wm.user_id
        order by pp.created_at
        limit 1
      ) first_share on true
      left join ${user} inviter on inviter.id = coalesce(wm.invited_by, first_share.created_by)
      where wm.workspace_id = ${workspaceId} and wm.role = 'guest' and ${notAgentUser(sql`wm.user_id`)}
    `),
    db
      .select({
        id: workspaceInvitation.id,
        email: workspaceInvitation.email,
        addedAt: workspaceInvitation.createdAt,
        expiresAt: workspaceInvitation.expiresAt,
        invitedById: workspaceInvitation.invitedBy,
        invitedByName: inviter.name,
      })
      .from(workspaceInvitation)
      .leftJoin(inviter, eq(inviter.id, workspaceInvitation.invitedBy))
      .where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.role, "guest")))
      .orderBy(asc(workspaceInvitation.createdAt)),
    db.execute<EntryRow>(sql`
      select pp.page_id, pp.user_id as principal, pp.level, pp.created_at as at,
        pp.created_by as by_id, by_user.name as by_name,
        p.title, p.icon, p.kind, p.archived_at is not null as in_trash,
        ${accessRank(actorId, pageIdColumn("p"))} as viewer
      from ${pagePermission} pp
      join ${workspaceMember} wm on wm.workspace_id = pp.workspace_id and wm.user_id = pp.user_id and wm.role = 'guest'
      join ${page} p on p.id = pp.page_id
      left join ${user} by_user on by_user.id = pp.created_by
      where pp.workspace_id = ${workspaceId} and pp.level <> 'none' and ${notAgentUser(sql`pp.user_id`)}
    `),
    db.execute<EntryRow>(sql`
      select pi.page_id, pi.email as principal, pi.level, pi.created_at as at,
        pi.invited_by as by_id, by_user.name as by_name,
        p.title, p.icon, p.kind, p.archived_at is not null as in_trash,
        ${accessRank(actorId, pageIdColumn("p"))} as viewer
      from ${pageInvitation} pi
      join ${page} p on p.id = pi.page_id
      left join ${user} by_user on by_user.id = pi.invited_by
      where pi.workspace_id = ${workspaceId}
    `),
  ]);
  const pages = byPrincipal([...entries]);
  const waiting = byPrincipal([...pending]);
  const by = (id: string | null, name: string | null) => (id ? { id, name: name ?? "" } : null);

  const guests: Guest[] = [...members].map((m) => {
    const email = m.email.toLowerCase();
    return {
      userId: m.user_id,
      name: m.name,
      email: m.email,
      image: m.image,
      addedAt: new Date(m.added_at),
      invitedBy: by(m.invited_by_id, m.invited_by_name),
      expiresAt: null,
      invitationId: null,
      pages: pages.shown.get(m.user_id) ?? [],
      hiddenPages: pages.hidden.get(m.user_id) ?? 0,
      // Joining turns page invitations into entries, so these are left only if the email changed hands.
      invitations: waiting.shown.get(email) ?? [],
      hiddenInvitations: waiting.hidden.get(email) ?? 0,
    };
  });
  for (const i of invited) {
    const invitations = waiting.shown.get(i.email) ?? [];
    if (!isOwner && !invitations.length) continue;
    guests.push({
      userId: null,
      name: "",
      email: i.email,
      image: null,
      addedAt: i.addedAt,
      invitedBy: by(i.invitedById, i.invitedByName),
      expiresAt: i.expiresAt,
      invitationId: isOwner ? i.id : null,
      pages: [],
      hiddenPages: 0,
      invitations,
      hiddenInvitations: waiting.hidden.get(i.email) ?? 0,
    });
  }
  return guests.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}
