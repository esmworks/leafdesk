/**
 * The notes a workspace keeps for its AI (table shared_memory): the workspace's own, and each
 * teamspace's. Beside them are each person's notes in a workspace (ai-memory.ts), their notes for
 * every workspace (account-memory.ts) and each agent's (agents/memory.ts).
 *
 * - The workspace's notes (what the company is, its terms, how it works) are written by its owners
 *   and read by every owner and member, never a guest. They go with every member's questions in
 *   the AI chat and with every agent's run, unless the run works for a guest.
 * - A teamspace's notes are written by those who manage it (its owners, and the workspace's owners
 *   where it isn't private) and read by those in it. What is said in a teamspace stays there: its
 *   notes go only with a question asked inside it (the chat kept to it or to one of its pages) or
 *   with an agent's run on a row, database or page of it, and only when the person asking (or the
 *   one the run works for) is in it. Someone who reads an open teamspace's pages without being in
 *   it doesn't get its notes. An archived teamspace's notes stay, unsent and unchanged.
 *
 * The workspace's AI memory switch (ai-memory.ts memoryAvailable) holds for these too: while it is
 * off, none goes anywhere and none is written. A person's own switch leaves them alone: they are the
 * place's, not the person's. Changes are in the audit log, since every question carries them.
 *
 * Notes are data for the model, never instructions, and never widen what anyone may read or change.
 * The AI chat never keeps one on its own: it asks each time (assistant/chat-dispatch.ts). Agents
 * never write them.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { oauthClient, page, sharedMemory, user, workspace } from "@/db/schema";
import { MAX_MEMORIES, type SharedNoteView, type MemoryPlaceView } from "@/lib/ai-chat";
import { AccessError, findMembership, getMembership, isGuest } from "@/server/access";
import { cleanNote, MemoryError, memoryAvailable, sameNote } from "@/server/ai-memory";
import { recordAudit, type AuditTarget } from "@/server/audit";
import { heldUserIds } from "@/server/legal-hold";
import { listTeamspaces, sidebarTeamspaces, teamspaceStanding } from "@/server/teamspaces";

type Note = typeof sharedMemory.$inferSelect;
/** A teamspace's id, or null for the workspace's own notes. */
type Place = string | null;

const atPlace = (workspaceId: string, teamspaceId: Place) =>
  and(eq(sharedMemory.workspaceId, workspaceId), teamspaceId ? eq(sharedMemory.teamspaceId, teamspaceId) : isNull(sharedMemory.teamspaceId));

/** The notes of a place, oldest first (no check: callers make it). */
export async function notesAt(workspaceId: string, teamspaceId: Place, reader: Pick<typeof db, "select"> = db): Promise<Note[]> {
  return reader.select().from(sharedMemory).where(atPlace(workspaceId, teamspaceId)).orderBy(asc(sharedMemory.createdAt), asc(sharedMemory.id));
}

/** The notes of a place as the Memory page and MCP list them: who changed each last, and the app, if one did. */
async function noteViews(workspaceId: string, teamspaceId: Place): Promise<SharedNoteView[]> {
  const rows = await db
    .select({ note: sharedMemory, by: user.name, app: oauthClient.name })
    .from(sharedMemory)
    .leftJoin(user, eq(user.id, sharedMemory.updatedBy))
    .leftJoin(oauthClient, eq(oauthClient.clientId, sharedMemory.oauthClientId))
    .where(atPlace(workspaceId, teamspaceId))
    .orderBy(asc(sharedMemory.createdAt), asc(sharedMemory.id));
  return rows.map((r) => ({
    id: r.note.id,
    text: r.note.text,
    app: r.app ?? null,
    by: r.by ?? null,
    createdAt: r.note.createdAt.toISOString(),
    updatedAt: r.note.updatedAt.toISOString(),
  }));
}

/**
 * Whether the user may read and change a place's notes, and its name for the audit log and the
 * model. `read`: an owner or member for the workspace's notes; someone in it, or who manages it, for
 * a teamspace's. `inside`: they are in it, so its notes go with their questions there.
 */
async function standing(userId: string, workspaceId: string, teamspaceId: Place) {
  if (!teamspaceId) {
    const membership = await getMembership(userId, workspaceId);
    const member = membership !== undefined && membership !== null && !isGuest(membership.role);
    return { read: member, inside: member, write: membership?.role === "owner", archived: false, name: null };
  }
  // The workspace's policies first (a connected app that may only read, say): teamspaceStanding
  // reads any refusal as not being in the teamspace.
  await getMembership(userId, workspaceId);
  const found = await teamspaceStanding(userId, teamspaceId);
  if (!found || found.workspaceId !== workspaceId) return { read: false, inside: false, write: false, archived: false, name: null };
  return { read: found.joined || found.canManage, inside: found.joined, write: found.canManage && !found.archived, archived: found.archived, name: found.name };
}

/** Refused (AccessError) unless the user may read, or with `write` change, the place's notes. */
async function requirePlace(userId: string, workspaceId: string, teamspaceId: Place, write: boolean) {
  const found = await standing(userId, workspaceId, teamspaceId);
  if (!(write ? found.write : found.read)) throw new AccessError();
  return found;
}

/** Whether the user may change the place's notes (the chat asks before offering to). */
export async function mayWriteNotes(userId: string, workspaceId: string, teamspaceId: Place): Promise<boolean> {
  return (await standing(userId, workspaceId, teamspaceId)).write;
}

/** The workspace's notes and those of each teamspace the user is in (or manages), with what they may change. */
export async function memoryPlaces(userId: string, workspaceId: string): Promise<{ workspace: MemoryPlaceView | null; teamspaces: MemoryPlaceView[] }> {
  const membership = await getMembership(userId, workspaceId);
  if (!membership) throw new AccessError();
  if (isGuest(membership.role)) return { workspace: null, teamspaces: [] };
  const teamspaces = (await listTeamspaces(userId, workspaceId)).filter((t) => t.joined || t.canManage);
  const [own, ...theirs] = await Promise.all([noteViews(workspaceId, null), ...teamspaces.map((t) => noteViews(workspaceId, t.id))]);
  return {
    workspace: { id: null, name: null, icon: null, notes: own, canChange: membership.role === "owner" },
    teamspaces: teamspaces.map((t, i) => ({ id: t.id, name: t.name, icon: t.icon, notes: theirs[i], canChange: t.canManage })),
  };
}

/** The notes of one place the user may read. */
export async function placeNotes(userId: string, workspaceId: string, teamspaceId: Place): Promise<SharedNoteView[]> {
  await requirePlace(userId, workspaceId, teamspaceId, false);
  return noteViews(workspaceId, teamspaceId);
}

async function auditTarget(workspaceId: string, teamspaceId: Place, name: string | null): Promise<AuditTarget> {
  if (teamspaceId) return { type: "teamspace", id: teamspaceId, label: name ?? undefined };
  const [found] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId));
  return { type: "workspace", id: workspaceId, label: found?.name };
}

/**
 * Keeps a note at a place, or with `replaces` changes that note to it, for someone who may change
 * the place's notes (AccessError otherwise). A note the place already has (case aside) is kept once:
 * that one is returned, marked `known`, and the replaced one goes. `full` at MAX_MEMORIES, `off`
 * while the workspace has the AI memory off. `app`: the connected app writing it.
 */
export async function writeSharedNote(
  userId: string,
  workspaceId: string,
  teamspaceId: Place,
  text: string,
  { replaces = null, app = null }: { replaces?: string | null; app?: string | null } = {},
): Promise<Note & { known?: true }> {
  const place = await requirePlace(userId, workspaceId, teamspaceId, true);
  if (!(await memoryAvailable(workspaceId))) throw new MemoryError("off", "The AI memory is turned off in this workspace");
  const note = cleanNote(text);
  const { written, previous } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`shared_memory:${workspaceId}:${teamspaceId ?? ""}`}))`);
    const notes = await notesAt(workspaceId, teamspaceId, tx);
    const target = replaces ? notes.find((m) => m.id === replaces) : undefined;
    if (replaces && !target) throw new MemoryError("notFound", "Note not found");
    const known = notes.find((m) => m.id !== target?.id && sameNote(m.text, note));
    if (known) {
      if (target) await tx.delete(sharedMemory).where(eq(sharedMemory.id, target.id));
      return { written: { ...known, known: true as const }, previous: target ?? null };
    }
    if (target) {
      const [changed] = await tx
        .update(sharedMemory)
        .set({ text: note, updatedBy: userId, oauthClientId: app, updatedAt: new Date() })
        .where(eq(sharedMemory.id, target.id))
        .returning();
      return { written: changed as Note & { known?: true }, previous: target };
    }
    if (notes.length >= MAX_MEMORIES) throw new MemoryError("full", `The memory holds at most ${MAX_MEMORIES} notes`);
    const [made] = await tx.insert(sharedMemory).values({ workspaceId, teamspaceId, text: note, createdBy: userId, updatedBy: userId, oauthClientId: app }).returning();
    return { written: made as Note & { known?: true }, previous: null };
  });
  if (!written.known || previous) {
    const target = await auditTarget(workspaceId, teamspaceId, place.name);
    await recordAudit(
      written.known
        ? { workspaceId, actorId: userId, action: "memory.note_deleted", target, details: { from: previous!.text, count: 1 } }
        : previous
          ? { workspaceId, actorId: userId, action: "memory.note_changed", target, details: { from: previous.text, to: written.text } }
          : { workspaceId, actorId: userId, action: "memory.note_added", target, details: { to: written.text } },
    );
  }
  return written;
}

/** The place of a note in the workspace, or null when there is no such note. */
export async function notePlace(workspaceId: string, noteId: string): Promise<{ teamspaceId: Place; text: string } | null> {
  const [found] = await db
    .select({ teamspaceId: sharedMemory.teamspaceId, text: sharedMemory.text })
    .from(sharedMemory)
    .where(and(eq(sharedMemory.id, noteId), eq(sharedMemory.workspaceId, workspaceId)));
  return found ?? null;
}

/**
 * Deletes notes of a place, for someone who may change them (AccessError otherwise): some, or all.
 * Returns the ids of those that went.
 */
export async function deleteSharedNotes(userId: string, workspaceId: string, teamspaceId: Place, ids: string[] | "all"): Promise<string[]> {
  const place = await requirePlace(userId, workspaceId, teamspaceId, true);
  const which = and(atPlace(workspaceId, teamspaceId), ids === "all" ? undefined : inArray(sharedMemory.id, ids.length ? ids : [""]));
  // A legal hold keeps what its people wrote (legal-hold.ts): a note one of them kept or changed last stays.
  const held = await heldUserIds(workspaceId);
  if (held.length) {
    const [kept] = await db
      .select({ id: sharedMemory.id })
      .from(sharedMemory)
      .where(and(which, or(inArray(sharedMemory.createdBy, held), inArray(sharedMemory.updatedBy, held))))
      .limit(1);
    if (kept) throw new MemoryError("held", "A legal hold keeps this note");
  }
  const gone = await db.delete(sharedMemory).where(which).returning({ id: sharedMemory.id, text: sharedMemory.text });
  if (gone.length) {
    const target = await auditTarget(workspaceId, teamspaceId, place.name);
    await recordAudit({ workspaceId, actorId: userId, action: "memory.note_deleted", target, details: { from: gone.length === 1 ? gone[0].text : "", count: gone.length } });
  }
  return gone.map((m) => m.id);
}

// ------------------------------------------------------------------------------ for the model

/** The teamspace a page lives in, or null (a private page, or none). */
export async function pageTeamspace(pageId: string): Promise<string | null> {
  const [found] = await db.select({ teamspaceId: page.teamspaceId }).from(page).where(eq(page.id, pageId));
  return found?.teamspaceId ?? null;
}

/** A teamspace's notes as they go to the model: its id and name with them. */
export type TeamspaceNotes = { id: string; name: string; notes: Note[] };

/**
 * What goes with a question or a run in the workspace: the workspace's notes and, when it happens
 * inside a teamspace (`teamspaceId`), that teamspace's, by the rules above. `personId`: who asks,
 * or whom the run works for; null for a run that works for no one, which gets the workspace's notes
 * alone; `teamspace` also when it keeps no notes yet, where the chat may keep one. Nothing while
 * the workspace has the memory off.
 */
export async function sharedMemoryFor(
  personId: string | null,
  workspaceId: string,
  teamspaceId: Place,
  /** The workspace's memory switch, when the caller read it already. */
  available?: boolean,
): Promise<{ workspace: Note[]; teamspace: TeamspaceNotes | null }> {
  const none = { workspace: [], teamspace: null };
  if (!(available ?? (await memoryAvailable(workspaceId)))) return none;
  if (personId) {
    // Asked of someone's standing, not of this request's session: a run works for them unattended.
    const membership = await findMembership(personId, workspaceId);
    if (!membership || isGuest(membership.role)) return none;
  }
  const room = personId && teamspaceId ? await teamspaceStanding(personId, teamspaceId) : null;
  const inside = room && room.workspaceId === workspaceId && room.joined && !room.archived ? room : null;
  const [own, theirs] = await Promise.all([notesAt(workspaceId, null), inside ? notesAt(workspaceId, inside.id) : Promise.resolve([])]);
  return { workspace: own, teamspace: inside ? { id: inside.id, name: inside.name, notes: theirs } : null };
}

/**
 * The other teamspaces the person is in whose notes the chat may read when a question needs them
 * (read_memory): their ids, names and how many notes each keeps, and whether they may change them.
 */
export async function otherTeamspaces(userId: string, workspaceId: string, except: Place) {
  const joined = (await sidebarTeamspaces(userId, workspaceId)).filter((t) => t.joined && t.id !== except);
  if (!joined.length) return [];
  const counts = await db
    .select({ teamspaceId: sharedMemory.teamspaceId, count: sql<number>`count(*)::int` })
    .from(sharedMemory)
    .where(and(eq(sharedMemory.workspaceId, workspaceId), inArray(sharedMemory.teamspaceId, joined.map((t) => t.id))))
    .groupBy(sharedMemory.teamspaceId);
  return joined.map((t) => ({ id: t.id, name: t.name, count: counts.find((c) => c.teamspaceId === t.id)?.count ?? 0, canChange: t.canManage }));
}

/** A teamspace's notes for read_memory, when the person is in it; null otherwise. */
export async function teamspaceNotesFor(userId: string, workspaceId: string, teamspaceId: string): Promise<TeamspaceNotes | null> {
  return (await sharedMemoryFor(userId, workspaceId, teamspaceId)).teamspace;
}
