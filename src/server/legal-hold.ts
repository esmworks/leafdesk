import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import * as Y from "yjs";
import { db } from "@/db";
import { file, legalHold, legalHoldPerson, page, pageSnapshot, rowActivity, user, workspace } from "@/db/schema";
import { THREADS_MAP } from "@/lib/comments";
import { cleanLegalHoldInput, commentAuthors, LegalHoldError } from "@/lib/legal-hold";
import { requireMembership } from "@/server/access";
import { notAgentUser } from "@/server/agents/users";
import { recordAudit } from "@/server/audit";
import { workspacePeople } from "@/server/workspaces";

/**
 * Legal holds. Owners put a hold on people of the workspace (members, guests, or people who have
 * left), with a name and a reason; while it stands, nothing those people created or edited there
 * is deleted for good. Pages and rows still go to the trash and come back from it; what goes
 * further is kept or refused here:
 *  - deleting pages for good (Delete forever, the trash's retention), templates included: a page
 *    is kept when it, or a page under it (which would go with it), is held (`heldPageIds`);
 *  - page history: versions of held pages aren't pruned (`touchedUnderHold`, server/retention.ts);
 *  - deleted properties' values on held rows (server/databases.ts purgeProperty, the retention);
 *  - uploads by held people (server/files.ts cleanups);
 *  - comments by held people (server/comments.ts), and PDF letterheads they made (letterheads.ts);
 *  - the workspace (server/workspace-deletion.ts, and with an account: workspaces.ts) and held
 *    people's accounts (server/account.ts). The foreign keys refuse both too, should a path be missed.
 *
 * A page is held when someone under a hold of its workspace created it, last edited it, saved one
 * of its versions, changed one of its values (a row's activity), uploaded a file to it or wrote a
 * comment on it. Removing a held person from the workspace stays possible: their pages stay, those
 * only they could manage handed to an owner as usual (workspaces.ts handOverOrphanedPages).
 *
 * Releasing a hold deletes it. Both are recorded in the audit log, which is where they live on.
 */

type Reader = Pick<typeof db, "select" | "selectDistinct" | "execute">;

/** The people under a hold of the workspace now. */
export async function heldUserIds(workspaceId: string, reader: Reader = db): Promise<string[]> {
  const rows = await reader
    .selectDistinct({ userId: legalHoldPerson.userId })
    .from(legalHoldPerson)
    .innerJoin(legalHold, eq(legalHold.id, legalHoldPerson.holdId))
    .where(eq(legalHold.workspaceId, workspaceId));
  return rows.map((r) => r.userId);
}

/** Whether the workspace has a hold: the cheap check before the others. */
export async function workspaceHasHolds(workspaceId: string, reader: Reader = db): Promise<boolean> {
  const [row] = await reader.select({ id: legalHold.id }).from(legalHold).where(eq(legalHold.workspaceId, workspaceId)).limit(1);
  return Boolean(row);
}

/** Of `workspaceIds`, the ones with a hold, with their names. */
export async function workspacesWithHolds(workspaceIds: string[], reader: Reader = db) {
  if (!workspaceIds.length) return [];
  return reader
    .selectDistinct({ id: workspace.id, name: workspace.name })
    .from(legalHold)
    .innerJoin(workspace, eq(workspace.id, legalHold.workspaceId))
    .where(inArray(legalHold.workspaceId, workspaceIds));
}

/** The workspaces where `userId` is under a hold, with their names (for deleting the account). */
export async function workspacesHolding(userId: string, reader: Reader = db) {
  return reader
    .selectDistinct({ id: workspace.id, name: workspace.name })
    .from(legalHoldPerson)
    .innerJoin(legalHold, eq(legalHold.id, legalHoldPerson.holdId))
    .innerJoin(workspace, eq(workspace.id, legalHold.workspaceId))
    .where(eq(legalHoldPerson.userId, userId));
}

/**
 * SQL: the page (an id expression) was created or edited by someone under a hold of its
 * workspace, as far as the database says: its creator and last editor, who saved its versions, who
 * changed its values, who uploaded its files. Comments live in the page's document; `heldPageIds`
 * reads those too.
 */
export const touchedUnderHold = (pageId: SQL) => sql`exists (
  select 1 from ${page} tp
  join ${legalHold} th on th.workspace_id = tp.workspace_id
  join ${legalHoldPerson} thp on thp.hold_id = th.id
  where tp.id = ${pageId}
    and (
      tp.created_by = thp.user_id or tp.updated_by = thp.user_id
      or exists (select 1 from ${pageSnapshot} ts where ts.page_id = tp.id and ts.created_by = thp.user_id)
      or exists (select 1 from ${rowActivity} ta where ta.row_id = tp.id and (ta.actor_user_id = thp.user_id or ta.proposed_by = thp.user_id))
      or exists (select 1 from ${file} tf where tf.page_id = tp.id and tf.uploaded_by = thp.user_id)
    )
)`;

/** SQL: the file (its table's row) was uploaded by someone under a hold of its workspace. */
export const uploadUnderHold = () => sql`exists (
  select 1 from ${legalHoldPerson} fhp
  join ${legalHold} fh on fh.id = fhp.hold_id
  where fh.workspace_id = ${file.workspaceId} and fhp.user_id = ${file.uploadedBy}
)`;

/** Documents read at once when looking for comments. */
const DOC_BATCH = 50;

/**
 * Of `pageIds` (pages of `workspaceId`), those a hold keeps: deleting one for good would delete a
 * held page, itself or one under it. Empty, after one query, in a workspace without holds.
 */
export async function heldPageIds(workspaceId: string, pageIds: string[], reader: Reader = db): Promise<Set<string>> {
  const held = new Set<string>();
  if (!pageIds.length) return held;
  const people = new Set(await heldUserIds(workspaceId, reader));
  if (!people.size) return held;
  const subtree = sql`
    with recursive sub as (
      select id, id as root from ${page} where workspace_id = ${workspaceId} and id in ${pageIds}
      union all
      select p.id, sub.root from ${page} p join sub on p.parent_id = sub.id
    )`;
  const touched = await reader.execute<{ root: string }>(sql`
    ${subtree}
    select distinct sub.root from sub where ${touchedUnderHold(sql`sub.id`)}
  `);
  for (const row of touched) held.add(row.root);
  // The rest: comments by held people, in the documents of the pages that would go.
  const rest = pageIds.filter((id) => !held.has(id));
  if (!rest.length) return held;
  const documents = await reader.execute<{ id: string; root: string }>(sql`
    ${subtree}
    select sub.id, sub.root from sub join ${page} p on p.id = sub.id
    where sub.root in ${rest} and p.ydoc is not null
  `);
  for (let i = 0; i < documents.length; i += DOC_BATCH) {
    const batch = [...documents].slice(i, i + DOC_BATCH).filter((d) => !held.has(d.root));
    if (!batch.length) continue;
    const docs = await reader.select({ id: page.id, ydoc: page.ydoc }).from(page).where(inArray(page.id, batch.map((d) => d.id)));
    const byId = new Map(docs.map((d) => [d.id, d.ydoc]));
    for (const { id, root } of batch) {
      if (held.has(root)) continue;
      const state = byId.get(id);
      if (state && [...threadAuthors(state)].some((author) => people.has(author))) held.add(root);
    }
  }
  return held;
}

/** Who wrote comments in a stored page document; nothing when it doesn't read. */
function threadAuthors(state: Uint8Array): Set<string> {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return commentAuthors(doc.getMap(THREADS_MAP).toJSON());
  } catch {
    return new Set();
  } finally {
    doc.destroy();
  }
}

/** Throws LegalHoldError (`pageHeld`, or `code`) when a hold keeps any of `pageIds`. */
export async function refuseHeldPages(workspaceId: string, pageIds: string[], code: "pageHeld" | "templateHeld" | "propertyHeld" = "pageHeld") {
  if ((await heldPageIds(workspaceId, pageIds)).size) {
    throw new LegalHoldError(code, "A legal hold keeps this: it can't be deleted for good while the hold stands.");
  }
}

/**
 * Throws LegalHoldError (`commentHeld`) when deleting the comment (or, without `commentId`, the
 * whole thread) would delete what someone under a hold wrote. `threads` reads the page's threads
 * (as collab does), only when the workspace has holds.
 */
export async function refuseHeldComments(workspaceId: string, threads: () => Promise<unknown>, threadId: string, commentId?: string) {
  const people = await heldUserIds(workspaceId);
  if (!people.length) return;
  const authors = commentAuthors(await threads(), threadId, commentId);
  if (people.some((id) => authors.has(id))) {
    throw new LegalHoldError("commentHeld", "A legal hold keeps this comment: it can't be deleted while the hold stands.");
  }
}

/** Throws LegalHoldError (`workspaceHeld`) while the workspace has a hold. */
export async function refuseWorkspaceWithHolds(workspaceId: string, reader: Reader = db) {
  if (await workspaceHasHolds(workspaceId, reader)) {
    throw new LegalHoldError("workspaceHeld", "This workspace has a legal hold: release it before deleting the workspace.");
  }
}

// ------------------------------------------------------------------------------- managing holds

export type LegalHoldPerson = { id: string; name: string; email: string; image: string | null; role: string | null };

export type LegalHoldView = {
  id: string;
  name: string;
  reason: string;
  createdAt: string;
  createdBy: string | null;
  people: LegalHoldPerson[];
};

/** The workspace's holds, newest first. Owners only. */
export async function listLegalHolds(actorId: string, workspaceId: string): Promise<LegalHoldView[]> {
  await requireMembership(actorId, workspaceId, "owner");
  const setter = sql<string | null>`(select ${user.name} from ${user} where ${user.id} = ${legalHold.createdBy})`;
  const holds = await db
    .select({ id: legalHold.id, name: legalHold.name, reason: legalHold.reason, createdAt: legalHold.createdAt, createdBy: setter })
    .from(legalHold)
    .where(eq(legalHold.workspaceId, workspaceId))
    .orderBy(sql`${legalHold.createdAt} desc`, asc(legalHold.id));
  if (!holds.length) return [];
  const people = await db
    .select({ holdId: legalHoldPerson.holdId, id: user.id, name: user.name, email: user.email, image: user.image })
    .from(legalHoldPerson)
    .innerJoin(user, eq(user.id, legalHoldPerson.userId))
    .where(inArray(legalHoldPerson.holdId, holds.map((h) => h.id)))
    .orderBy(asc(user.name));
  const roles = new Map((await workspacePeople(workspaceId)).map((p) => [p.id, p.role as string]));
  return holds.map((h) => ({
    id: h.id,
    name: h.name,
    reason: h.reason,
    createdAt: h.createdAt.toISOString(),
    createdBy: h.createdBy,
    people: people
      .filter((p) => p.holdId === h.id)
      .map(({ id, name, email, image }) => ({ id, name, email, image, role: roles.get(id) ?? null })),
  }));
}

/**
 * Who a hold may be put on: everyone in the workspace, guests included, and the people who left
 * it but created or edited something there (who else would it keep anything of). Agents aren't
 * people. `role` is null for those who left.
 */
export async function legalHoldCandidates(actorId: string, workspaceId: string): Promise<LegalHoldPerson[]> {
  await requireMembership(actorId, workspaceId, "owner");
  return candidates(workspaceId);
}

async function candidates(workspaceId: string): Promise<LegalHoldPerson[]> {
  const present = await workspacePeople(workspaceId);
  const known = new Set(present.map((p) => p.id));
  const authors = await db.execute<{ id: string; name: string; email: string; image: string | null }>(sql`
    select u.id, u.name, u.email, u.image from ${user} u
    where u.id in (
      select created_by from ${page} where workspace_id = ${workspaceId}
      union select updated_by from ${page} where workspace_id = ${workspaceId}
      union select uploaded_by from ${file} where workspace_id = ${workspaceId}
      union select actor_user_id from ${rowActivity} where workspace_id = ${workspaceId}
    ) and ${notAgentUser(sql`u.id`)}
  `);
  const left = [...authors].filter((a) => !known.has(a.id)).map((a) => ({ ...a, role: null }));
  return [...present.map(({ id, name, email, image, role }) => ({ id, name, email, image, role: role as string })), ...left].sort((a, b) =>
    (a.name || a.email).localeCompare(b.name || b.email),
  );
}

/** Puts a new hold on people of the workspace. Owners only; recorded in the audit log. */
export async function setLegalHold(actorId: string, workspaceId: string, input: unknown): Promise<{ id: string }> {
  await requireMembership(actorId, workspaceId, "owner");
  const { name, reason, userIds } = cleanLegalHoldInput(input);
  const people = new Map((await candidates(workspaceId)).map((p) => [p.id, p]));
  if (userIds.some((id) => !people.has(id))) throw new LegalHoldError("unknownPerson", "Someone isn't in this workspace.");
  const names = userIds.map((id) => people.get(id)!).map((p) => p.name || p.email);
  return db.transaction(async (tx) => {
    const [hold] = await tx.insert(legalHold).values({ workspaceId, name, reason, createdBy: actorId }).returning({ id: legalHold.id });
    await tx.insert(legalHoldPerson).values(userIds.map((userId) => ({ holdId: hold.id, userId })));
    await recordAudit(
      {
        workspaceId,
        actorId,
        action: "legal_hold.set",
        target: { type: "legal_hold", id: hold.id, label: name },
        details: { names, count: names.length, reason },
      },
      tx,
    );
    return hold;
  });
}

/** Releases a hold: what it kept can be deleted for good again. Owners only; recorded in the audit log. */
export async function releaseLegalHold(actorId: string, workspaceId: string, holdId: string): Promise<void> {
  await requireMembership(actorId, workspaceId, "owner");
  await db.transaction(async (tx) => {
    const [hold] = await tx
      .select({ id: legalHold.id, name: legalHold.name })
      .from(legalHold)
      .where(and(eq(legalHold.id, holdId), eq(legalHold.workspaceId, workspaceId)))
      .for("update");
    if (!hold) throw new LegalHoldError("notFound", "That hold was released already.");
    const people = await tx
      .select({ name: user.name, email: user.email })
      .from(legalHoldPerson)
      .innerJoin(user, eq(user.id, legalHoldPerson.userId))
      .where(eq(legalHoldPerson.holdId, holdId));
    await tx.delete(legalHold).where(eq(legalHold.id, holdId));
    const names = people.map((p) => p.name || p.email);
    await recordAudit(
      { workspaceId, actorId, action: "legal_hold.released", target: { type: "legal_hold", id: hold.id, label: hold.name }, details: { names, count: names.length } },
      tx,
    );
  });
}
