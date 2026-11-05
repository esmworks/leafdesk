/**
 * Notes about a person in every workspace they are in (table account_memory): their language, how
 * they want answers, who they are apart from any one workspace. What a workspace holds about them
 * stays in that workspace's notes (ai-memory.ts), so one company's work never reaches another's
 * questions. Only the person sees and changes them, in the Memory page of any workspace and over
 * MCP; they go with their own questions in a workspace while their memory is on there (both
 * switches, ai-memory.ts memoryOn), never with agents' runs.
 *
 * Since a note here goes everywhere, the AI chat never keeps one on its own: it asks each time
 * (assistant/chat-dispatch.ts), saying the note goes to all the person's workspaces.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { accountMemory, oauthClient } from "@/db/schema";
import { MAX_MEMORIES, type MemoryCategory, type MemoryView } from "@/lib/ai-chat";
import { cleanDetails, cleanNote, MemoryError, sameNote } from "@/server/ai-memory";

type Note = typeof accountMemory.$inferSelect;

/** The person's notes, oldest first. */
export async function accountNotesOf(userId: string, reader: Pick<typeof db, "select"> = db): Promise<Note[]> {
  return reader.select().from(accountMemory).where(eq(accountMemory.userId, userId)).orderBy(asc(accountMemory.createdAt), asc(accountMemory.id));
}

/** The person's notes as the Memory page and MCP list them, with the app that kept each, if one did. */
export async function accountNotes(userId: string): Promise<MemoryView[]> {
  const rows = await db
    .select({ note: accountMemory, app: oauthClient.name })
    .from(accountMemory)
    .leftJoin(oauthClient, eq(oauthClient.clientId, accountMemory.oauthClientId))
    .where(eq(accountMemory.userId, userId))
    .orderBy(asc(accountMemory.createdAt), asc(accountMemory.id));
  return rows.map((r) => accountView(r.note, r.app ?? null));
}

export const accountView = (m: Note, app: string | null = null): MemoryView => ({
  id: m.id,
  text: m.text,
  details: m.details,
  category: m.category,
  app,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

/**
 * Keeps a note, or with `replaces` changes that note to it. A note the person already has (case
 * aside) is kept once: that one is returned, marked `known`, and the replaced one goes. `full` at
 * MAX_MEMORIES, `notFound` when the replaced note isn't theirs. `app`: the connected app writing it.
 * `category`: what it is about (a changed note keeps its own without one).
 */
export async function writeAccountNote(
  userId: string,
  text: string,
  { replaces = null, app = null, category = null, details }: { replaces?: string | null; app?: string | null; category?: MemoryCategory | null; details?: string | null } = {},
): Promise<Note & { known?: true }> {
  const note = cleanNote(text);
  const more = cleanDetails(details);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`account_memory:${userId}`}))`);
    const notes = await accountNotesOf(userId, tx);
    const target = replaces ? notes.find((m) => m.id === replaces) : undefined;
    if (replaces && !target) throw new MemoryError("notFound", "Note not found");
    const known = notes.find((m) => m.id !== target?.id && sameNote(m.text, note));
    if (known) {
      if (target) await tx.delete(accountMemory).where(eq(accountMemory.id, target.id));
      return { ...known, known: true as const };
    }
    if (target) {
      const [changed] = await tx.update(accountMemory).set({ text: note, ...(category ? { category } : {}), ...(more !== undefined ? { details: more } : {}), oauthClientId: app, updatedAt: new Date() }).where(eq(accountMemory.id, target.id)).returning();
      return changed;
    }
    if (notes.length >= MAX_MEMORIES) throw new MemoryError("full", `The memory holds at most ${MAX_MEMORIES} notes`);
    const [made] = await tx.insert(accountMemory).values({ userId, text: note, category: category ?? "other", details: more ?? null, oauthClientId: app }).returning();
    return made;
  });
}

/** Deletes notes of the person (only theirs): some, or all. Returns the ids of those that went. */
export async function deleteAccountNotes(userId: string, ids: string[] | "all"): Promise<string[]> {
  const gone = await db
    .delete(accountMemory)
    .where(and(eq(accountMemory.userId, userId), ids === "all" ? undefined : inArray(accountMemory.id, ids.length ? ids : [""])))
    .returning({ id: accountMemory.id });
  return gone.map((m) => m.id);
}
