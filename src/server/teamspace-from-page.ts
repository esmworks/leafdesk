import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, teamspace, type TeamspaceAccess } from "@/db/schema";
import type { PageLevel } from "@/db/schema/permissions";
import type { AuditPagePlace } from "@/lib/audit";
import { accessFromPlace, MEMBER_LEVEL_FROM_PAGE, teamspaceFromShares } from "@/lib/teamspace-from-page";
import { accessRank, FULL_RANK, pageVisibleTo, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { pageChanged } from "@/server/page-events";
import { queuePageMoved } from "@/server/page-webhooks/queue";
import { followNewSpace, freezeInheritedEntries } from "@/server/permissions";
import {
  canCreateTeamspace,
  createTeamspaceFromPage,
  mayArrangeTopLevel,
  requireArrangeTopLevel,
  TeamspaceError,
  teamspaceEligible,
} from "@/server/teamspaces";

/**
 * Turns a page into a teamspace: a new teamspace named after the page takes the page and the pages
 * right under it as its top-level pages (the page first), so its own content stays and its
 * sub-pages become the teamspace's sections in the sidebar. The people the page is shared with
 * join it by how much they could do there (lib/teamspace-from-page.ts), and every page that moves
 * keeps the entries it inherited, so nobody named on it loses access by the move. Sub-pages the
 * user has no full access to move too but keep every entry they have: one closed to everyone
 * else stays closed in the teamspace. One transaction.
 */

type Reader = Pick<typeof db, "execute">;
type LoadedPage = Awaited<ReturnType<typeof requirePageAccess>>;

/**
 * Whether the user may turn the page into a teamspace: they have full access to it, may create
 * teamspaces in its workspace, and it is a page (not a database, a row, a template or a page in the
 * trash). A top-level page leaves its teamspace's top level, so one whose top level is locked takes
 * someone who may arrange it (mayArrangeTopLevel).
 */
export async function canTurnIntoTeamspace(
  userId: string,
  found: Pick<LoadedPage, "workspaceId" | "teamspaceId" | "kind" | "parentId" | "isTemplate" | "inTemplate" | "archivedAt">,
  level: PageLevel,
) {
  if (level !== "full" || found.kind !== "page" || found.isTemplate || found.inTemplate || found.archivedAt) return false;
  if (found.parentId) {
    const [parent] = await db.select({ kind: page.kind }).from(page).where(eq(page.id, found.parentId));
    if (parent?.kind === "database") return false;
  } else if (found.teamspaceId && !(await mayArrangeTopLevel(userId, found.teamspaceId))) {
    return false;
  }
  return canCreateTeamspace(userId, found.workspaceId);
}

async function convertiblePage(userId: string, pageId: string) {
  const found = await requirePageAccess(userId, pageId, "full");
  if (!found.parentId) await requireArrangeTopLevel(userId, found.teamspaceId);
  if (!(await canTurnIntoTeamspace(userId, found, "full"))) {
    if (!(await canCreateTeamspace(userId, found.workspaceId))) {
      throw new TeamspaceError("creationRestricted", "Only workspace owners can create teamspaces here.");
    }
    throw new TeamspaceError("notConvertible", "Only a page can become a teamspace: not a database, a row or a template.");
  }
  return found;
}

/** The people and groups named on the page, each by its nearest entry on the page or above it. */
async function sharesOf(reader: Reader, pageId: string) {
  const chain = sql`with recursive chain as (
    select id, parent_id, 0 as depth from page where id = ${pageId}
    union all
    select p.id, p.parent_id, c.depth + 1 from page p join chain c on p.id = c.parent_id where c.depth < 64
  )`;
  const [people, groups] = await Promise.all([
    reader.execute<{ user_id: string; level: PageLevel }>(sql`${chain}
      select distinct on (pp.user_id) pp.user_id, pp.level
      from chain c join page_permission pp on pp.page_id = c.id
      where pp.user_id is not null
      order by pp.user_id, c.depth`),
    reader.execute<{ group_id: string; level: PageLevel }>(sql`${chain}
      select distinct on (gp.group_id) gp.group_id, gp.level
      from chain c join page_group_permission gp on gp.page_id = c.id
      order by gp.group_id, c.depth`),
  ]);
  return {
    people: people.map((r) => ({ userId: r.user_id, level: r.level })),
    groups: groups.map((r) => ({ groupId: r.group_id, level: r.level })),
  };
}

async function placeAccess(teamspaceId: string | null): Promise<TeamspaceAccess | null> {
  if (!teamspaceId) return null;
  const [found] = await db.select({ access: teamspace.access }).from(teamspace).where(eq(teamspace.id, teamspaceId));
  return found?.access ?? null;
}

/** The pages that move with it: those right under the page, but templates and pages in the trash (they stay under it). */
const childrenOf = (pageId: string) =>
  and(eq(page.parentId, pageId), isNull(page.archivedAt), eq(page.isTemplate, false));

export type TeamspaceFromPagePreview = {
  name: string;
  icon: string | null;
  access: TeamspaceAccess;
  /** The pages that become its top-level pages: the page and those right under it the user can see. */
  pages: number;
  owners: string[];
  members: string[];
  groups: number;
  /** People named on the page who don't join (guests, and those who may only view or comment): they keep their access. */
  kept: number;
};

/** What turning the page into a teamspace would do, for the dialog that asks first. */
export async function previewTeamspaceFromPage(userId: string, pageId: string): Promise<TeamspaceFromPagePreview> {
  const found = await convertiblePage(userId, pageId);
  const [shares, access, [children]] = await Promise.all([
    sharesOf(db, pageId),
    placeAccess(found.teamspaceId),
    // The others move too, but the dialog doesn't tell them they are there.
    db.select({ count: sql<number>`count(*)::int` }).from(page).where(and(childrenOf(pageId), pageVisibleTo(userId))),
  ]);
  const eligible = await teamspaceEligible(db, found.workspaceId, [userId, ...shares.people.map((p) => p.userId)]);
  const plan = teamspaceFromShares(
    userId,
    shares.people.map((p) => ({ ...p, eligible: eligible.has(p.userId) })),
    shares.groups,
  );
  return {
    name: found.title,
    icon: found.icon,
    access: accessFromPlace(access),
    pages: 1 + Number(children?.count ?? 0),
    owners: plan.owners.map((id) => eligible.get(id) ?? ""),
    members: plan.members.map((id) => eligible.get(id) ?? ""),
    groups: plan.groupIds.length,
    kept: plan.kept.length,
  };
}

/**
 * Turns the page into a teamspace named `name` (the page's title when left out) and returns it.
 * Needs full access to the page and the right to create teamspaces (canTurnIntoTeamspace).
 */
export async function turnPageIntoTeamspace(userId: string, pageId: string, name?: string) {
  const found = await convertiblePage(userId, pageId);
  const workspaceId = found.workspaceId;
  const access = accessFromPlace(await placeAccess(found.teamspaceId));
  let from: AuditPagePlace = { type: "private" };
  if (found.parentId) {
    const [parent] = await db.select({ title: page.title }).from(page).where(eq(page.id, found.parentId));
    from = { type: "page", id: found.parentId, label: parent?.title ?? "" };
  } else if (found.teamspaceId) {
    const [space] = await db.select({ name: teamspace.name }).from(teamspace).where(eq(teamspace.id, found.teamspaceId));
    from = { type: "teamspace", id: found.teamspaceId, label: space?.name ?? "" };
  }

  const { created, children } = await db.transaction(async (tx) => {
    // Nothing moves in or out from under the page meanwhile.
    await tx.execute(sql`select 1 from ${page} where ${page.id} = ${pageId} for update`);
    const children = await tx
      .select({
        id: page.id,
        title: page.title,
        kind: page.kind,
        position: page.position,
        // Read before anything changes, like the shares: what they may do there now.
        full: sql<boolean>`${accessRank(userId, sql`${page.id}`)} >= ${FULL_RANK}`,
      })
      .from(page)
      .where(childrenOf(pageId));
    // Who joins is read before anything changes: the entries on the page and above it.
    const shares = await sharesOf(tx, pageId);
    const eligible = await teamspaceEligible(tx, workspaceId, shares.people.map((p) => p.userId));
    const plan = teamspaceFromShares(
      userId,
      shares.people.map((p) => ({ ...p, eligible: eligible.has(p.userId) })),
      shares.groups,
    );
    const created = await createTeamspaceFromPage(tx, {
      workspaceId,
      actorId: userId,
      name: name?.trim() || found.title,
      icon: found.icon,
      access,
      memberLevel: MEMBER_LEVEL_FROM_PAGE,
      owners: plan.owners,
      members: plan.members,
      groupIds: plan.groupIds,
      source: { id: pageId, title: found.title },
    });
    const moved = [pageId, ...children.map((c) => c.id)];
    // What each of them inherits becomes its own (as for a page restored out of a deleted parent),
    // so the people, groups and guests named above keep their access at the top of the teamspace.
    for (const id of moved) await freezeInheritedEntries(tx, workspaceId, id);
    const first = Math.min(0, ...children.map((c) => c.position)) - 1;
    await tx.update(page).set({ parentId: null, teamspaceId: created.id, position: first }).where(eq(page.id, pageId));
    if (children.length) {
      await tx
        .update(page)
        .set({ parentId: null, teamspaceId: created.id })
        .where(inArray(page.id, children.map((c) => c.id)));
    }
    // As any page moved into another teamspace: its "everyone" entry goes, so it takes the
    // teamspace's access (its members', and reading for everyone when it is open). Not on a
    // sub-page the user has no full access to: whoever closed it ("everyone: none", say) decided
    // that, and it would open up to the teamspace's members, the user first.
    const following = [pageId, ...children.filter((c) => c.full).map((c) => c.id)];
    for (const id of following) await followNewSpace(tx, workspaceId, id, userId, { changedSpace: true, toPrivate: false, privateTop: false });
    const to: AuditPagePlace = { type: "teamspace", id: created.id, label: created.name };
    await recordAudit(
      [
        { workspaceId, actorId: userId, action: "page.moved", target: { type: "page", id: pageId, label: found.title }, details: { kind: found.kind, from, to } },
        ...children.map((c) => ({
          workspaceId,
          actorId: userId,
          action: "page.moved" as const,
          target: { type: "page" as const, id: c.id, label: c.title },
          details: { kind: c.kind, from: { type: "page", id: pageId, label: found.title } satisfies AuditPagePlace, to },
        })),
      ],
      tx,
    );
    return { created, children };
  });

  getCollab().broadcast(`ws:${workspaceId}`, "tree");
  await getCollab().disconnectLostAccess(workspaceId);
  // Semantic search names the pages above in every chunk: the pages moved and those under them are indexed again.
  for (const id of [pageId, ...children.map((c) => c.id)]) pageChanged({ pageId: id, subtree: true });
  await queuePageMoved(pageId, userId, { parentId: found.parentId, teamspaceId: found.teamspaceId });
  for (const c of children) await queuePageMoved(c.id, userId, { parentId: pageId, teamspaceId: found.teamspaceId });
  return created;
}
