import { rankNotes } from "@/lib/memory-search";
import * as accountMemory from "@/server/account-memory";
import { AccessError } from "@/server/access";
import * as personalMemory from "@/server/ai-memory";
import * as memoryEmbeddings from "@/server/memory-embeddings";
import * as memorySummary from "@/server/memory-summary";
import * as pages from "@/server/pages";
import * as sharedMemory from "@/server/shared-memory";
import { ToolInputError } from "./format";
import { describeLocated, describeMemory, describeNote, describePlaces, listNotes, notesOf, type LocatedNote } from "./memory";

/**
 * The user's memory as MCP's list_memory and the REST API's GET /memory read it: the notes for all
 * their workspaces, then each workspace's (theirs, the workspace's and its teamspaces'); a search of
 * every note by words and meaning, or one note in full.
 */

/** The user's notes in a workspace with the workspace's and its teamspaces' (none while the workspace has the memory off). */
async function memoryIn(userId: string, workspaceId: string) {
  const state = await personalMemory.memoryState(userId, workspaceId);
  const [summary, places] = await Promise.all([
    state.off ? null : memorySummary.summaryOf(userId, workspaceId),
    state.off === "workspace" ? null : sharedMemory.memoryPlaces(userId, workspaceId),
  ]);
  return {
    shown: { ...describeMemory(workspaceId, state, summary), ...(places ? describePlaces(places) : {}) },
    notes: notesOf(workspaceId, state, places),
  };
}

/**
 * How close the user's notes are to `query` by meaning (memory-embeddings.ts), each workspace's
 * by its own embeddings model, the account notes by the first workspace's; null where no
 * workspace searches by meaning, which leaves the words alone.
 */
async function similarities(userId: string, account: LocatedNote[], read: { id: string; notes: LocatedNote[] }[], query: string) {
  const store = (l: LocatedNote): memoryEmbeddings.NoteStore => (l.layer === "account" ? "account_memory" : l.layer === "person" ? "ai_memory" : "shared_memory");
  const found = await Promise.all(
    read.map((w, i) =>
      memoryEmbeddings.noteSimilarities(
        [...(i === 0 ? account : []), ...w.notes].map((l) => ({ id: l.note.id, store: store(l), text: l.note.text, details: l.note.details })),
        query,
        { userId, workspaceId: w.id },
      ),
    ),
  );
  const merged = new Map<string, number>();
  for (const [id, score] of found.flatMap((m) => [...(m ?? [])])) merged.set(id, Math.max(score, merged.get(id) ?? -1));
  return merged.size ? merged : null;
}

/** list_memory's answer: `workspace_id` alone, or every workspace of the user's the connection may read. */
export async function readMemory(userId: string, input: { workspace_id?: string; query?: string; memory_id?: string }) {
  const { workspace_id, query, memory_id } = input;
  const account = await accountMemory.accountNotes(userId);
  const read = workspace_id
    ? [{ id: workspace_id, name: undefined, ...(await memoryIn(userId, workspace_id)) }]
    : (
        await Promise.all(
          (await pages.listWorkspaces(userId)).map(async (w) => {
            try {
              return { id: w.id, name: w.name, ...(await memoryIn(userId, w.id)) };
            } catch (error) {
              // A workspace whose sign-in policy holds this connection back.
              if (!(error instanceof AccessError)) throw error;
              return null;
            }
          }),
        )
      ).filter((w) => w !== null);
  const search = query?.trim() ?? "";
  if (memory_id || search) {
    const located: LocatedNote[] = [...account.map((note) => ({ layer: "account" as const, note })), ...read.flatMap((w) => w.notes)];
    if (memory_id) {
      const found = located.find((l) => l.note.id === memory_id);
      if (!found) throw new ToolInputError("No note of the user's with this memory_id. Call list_memory to see their notes.");
      return describeLocated(found);
    }
    const byNote = new Map(located.map((l) => [l.note, l] as const));
    const found = rankNotes(
      located.map((l) => l.note),
      search,
      await similarities(
        userId,
        located.filter((l) => l.layer === "account"),
        read,
        search,
      ),
    );
    return found.length
      ? { query: search, notes: found.map((note) => describeLocated(byNote.get(note)!)) }
      : { query: search, notes: [], none: "No note matches that. Call list_memory without query for every note's line." };
  }
  const listed = listNotes(account, (n) => describeNote(n));
  const account_notes = { account_notes: listed.notes, ...(listed.notes_not_listed ? { account_notes_not_listed: listed.notes_not_listed } : {}) };
  if (workspace_id) return { ...account_notes, ...read[0].shown };
  return { ...account_notes, workspaces: read.map((w) => ({ name: w.name, ...w.shown })) };
}
