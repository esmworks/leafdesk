import * as z from "zod";
import { MAX_MEMORIES, MAX_MEMORY_CHARS, MAX_MEMORY_DETAILS_CHARS, MEMORY_CATEGORIES, type MemoryPlaceView, type MemoryView, type SharedNoteView } from "@/lib/ai-chat";
import { MEMORY_SEARCH_LIMIT } from "@/lib/memory-search";
import { MemoryError, memoryOff } from "@/server/ai-memory";
import { id } from "@/server/operations";
import { ToolInputError } from "./format";

/**
 * The user's own memory over MCP: the notes about them that the AI chat keeps in each workspace
 * (server/ai-memory.ts), read and kept by every app they connect, the same notes and limits. Each
 * note an app keeps or changes records the app, which the Memory view shows. Only while the memory
 * is on for them there: either switch off, nothing is read or kept (notes can still be deleted).
 */

const noteInput = z.string().min(1).max(MAX_MEMORY_CHARS);
const memoryIdInput = z.string().min(1).max(100).describe("The note's memory_id, from list_memory.");

export const memoryInputs = {
  list: z.object({
    workspace_id: id("workspace").optional().describe("Only this workspace's notes; the notes of every workspace of the user when omitted."),
    query: z.string().max(200).optional().describe(`Words to search every note and its details for: the ${MEMORY_SEARCH_LIMIT} that match best, with their details, instead of the list.`),
    memory_id: memoryIdInput.optional().describe("One note, with its details, instead of the list."),
  }),
  change: z.object({
    workspace_id: id("workspace").optional().describe("Not for scope account."),
    scope: z.enum(["person", "account", "workspace", "teamspace"]).default("person").describe("Whose notes (see list_memory)."),
    teamspace_id: id("teamspace").optional().describe("scope teamspace: from list_memory."),
    action: z.enum(["add", "update", "delete"]).describe("add: keep a new note (text). update: change a note (memory_id, text). delete: forget notes (memory_ids, or all)."),
    text: noteInput.optional().describe(`add, update: the note, one fact about the user in a sentence of at most ${MAX_MEMORY_CHARS} characters, in the user's language.`),
    category: z
      .enum(MEMORY_CATEGORIES)
      .optional()
      .describe("add, update: what it is about (default other)."),
    details: z.string().max(MAX_MEMORY_DETAILS_CHARS).optional().describe("add, update: the note in full (\"\" drops it)."),
    memory_id: memoryIdInput.optional().describe("update: the note's memory_id, from list_memory."),
    memory_ids: z.array(memoryIdInput).min(1).max(MAX_MEMORIES).optional().describe("delete: the memory_ids of the notes to forget, from list_memory."),
    all: z.boolean().default(false).describe("delete: forget every note of that scope instead."),
  }),
};

/** Why nothing is read or kept, by the switch that has the memory off. */
export const MEMORY_OFF = {
  workspace:
    "The workspace's owners turned the AI memory off (Settings → General → AI → AI memory), so no note about the user is read or kept there. Keep nothing; the notes come back if an owner turns it on again. The user can still have them deleted (change_memory delete with all: true).",
  person:
    "The user turned their memory off in this workspace (the Use memory switch in the AI chat's Memory), so no note about them is read or kept there. Keep nothing; they can turn it back on there. They can still have the notes deleted (change_memory delete with all: true).",
} as const;

/** Refused unless the user's memory in the workspace is on (the owners' switch and their own). */
export async function requireMemoryOn(userId: string, workspaceId: string) {
  const off = await memoryOff(userId, workspaceId);
  if (off) throw new ToolInputError(MEMORY_OFF[off]);
}

/** MemoryError as errors with a next step. */
export async function withMemoryErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MemoryError) {
      switch (error.code) {
        case "notFound":
          throw new ToolInputError("No note with this memory_id in the user's memory in this workspace. Call list_memory to see their notes.");
        case "full":
          throw new ToolInputError(
            `The user's memory in this workspace is full (${MAX_MEMORIES} notes). Delete a note that matters less or change one (change_memory); or tell the user it is full.`,
          );
        case "tooLong":
          throw new ToolInputError(`A note has at most ${MAX_MEMORY_CHARS} characters. Make it shorter.`);
        case "detailsTooLong":
          throw new ToolInputError(`A note's details have at most ${MAX_MEMORY_DETAILS_CHARS} characters. Make them shorter.`);
        case "empty":
          throw new ToolInputError("A note needs text.");
        case "off":
          throw new ToolInputError(MEMORY_OFF.workspace);
        case "held":
          throw new ToolInputError("A legal hold of the workspace keeps these notes: they can't be deleted while it stands.");
      }
    }
    throw error;
  }
}

/**
 * A note as list_memory shows it: in the list only its line, `has_details` saying there is more,
 * which a search or a read of the note (`full`) shows. Notes are read at the start of every
 * conversation, so the list stays short however many notes have details.
 */
export function describeNote(note: MemoryView, full = false) {
  const details = note.details ? (full ? { details: note.details } : { has_details: true as const }) : {};
  return { memory_id: note.id, text: note.text, category: note.category, ...details, ...(note.app ? { kept_by_app: note.app } : {}), created_at: note.createdAt, updated_at: note.updatedAt };
}

/** How much of one layer's notes list_memory lists, in characters of JSON: about thirty notes. */
export const LIST_CHARS = 10_000;

/**
 * The newest of `notes` (oldest first) whose descriptions fit LIST_CHARS, shown oldest first, and
 * how many older ones were left out (`notes_not_listed`, found with list_memory's query).
 */
export function listNotes<T>(notes: T[], describe: (note: T) => object): { notes: object[]; notes_not_listed?: number } {
  const taken: object[] = [];
  let used = 0;
  for (const note of [...notes].reverse()) {
    const shown = describe(note);
    const size = JSON.stringify(shown).length + 1;
    if (used + size > LIST_CHARS) break;
    used += size;
    taken.push(shown);
  }
  const left = notes.length - taken.length;
  return { notes: taken.reverse(), ...(left ? { notes_not_listed: left } : {}) };
}

/**
 * The user's memory in a workspace as list_memory shows it: the notes while it is on, after the
 * summary of them the user keeps (`about`, server/memory-summary.ts), if any; while off, why and how many.
 */
export function describeMemory(workspaceId: string, { off, notes }: { off: keyof typeof MEMORY_OFF | null; notes: MemoryView[] }, about = "") {
  return off
    ? { workspace_id: workspaceId, memory: "off" as const, why: MEMORY_OFF[off], notes: [], notes_kept: notes.length }
    : { workspace_id: workspaceId, memory: "on" as const, ...(about ? { about } : {}), ...listNotes(notes, (n) => describeNote(n)) };
}

/** A note of the workspace or a teamspace as list_memory shows it: who changed it last, too. */
export function describeSharedNote(note: SharedNoteView, full = false) {
  return { ...describeNote(note, full), ...(note.by ? { changed_by: note.by } : {}) };
}

/** A note with whose it is, for a search or a read of one note across every layer list_memory reads. */
export type LocatedNote =
  | { layer: "account" | "person"; workspace_id?: string; note: MemoryView }
  | { layer: "workspace" | "teamspace"; workspace_id: string; teamspace_id?: string | null; note: SharedNoteView };

/** The notes list_memory shows for a workspace (as describeMemory and describePlaces show them), with whose each is. */
export function notesOf(
  workspaceId: string,
  { off, notes }: { off: keyof typeof MEMORY_OFF | null; notes: MemoryView[] },
  places: { workspace: MemoryPlaceView | null; teamspaces: MemoryPlaceView[] } | null,
): LocatedNote[] {
  return [
    ...(off ? [] : notes.map((note) => ({ layer: "person" as const, workspace_id: workspaceId, note }))),
    ...(places?.workspace
      ? [
          ...places.workspace.notes.map((note) => ({ layer: "workspace" as const, workspace_id: workspaceId, note })),
          ...places.teamspaces.flatMap((t) => t.notes.map((note) => ({ layer: "teamspace" as const, workspace_id: workspaceId, teamspace_id: t.id, note }))),
        ]
      : []),
  ];
}

/** A located note in full, saying whose it is. */
export function describeLocated(located: LocatedNote) {
  const { note, ...where } = located;
  return { ...where, ...(located.layer === "workspace" || located.layer === "teamspace" ? describeSharedNote(located.note, true) : describeNote(note, true)) };
}

/**
 * The workspace's notes and its teamspaces' as list_memory shows them beside the user's own: the
 * workspace's while it has the memory on, and each teamspace's the user is in or manages that keeps
 * notes or that they may change; nothing for a guest.
 */
export function describePlaces(places: { workspace: MemoryPlaceView | null; teamspaces: MemoryPlaceView[] }) {
  if (!places.workspace) return {};
  const teamspaces = places.teamspaces.filter((t) => t.notes.length || t.canChange);
  return {
    workspace_notes: { can_change: places.workspace.canChange, ...listNotes(places.workspace.notes, (n) => describeSharedNote(n)) },
    ...(teamspaces.length
      ? { teamspace_notes: teamspaces.map((t) => ({ teamspace_id: t.id, name: t.name, can_change: t.canChange, ...listNotes(t.notes, (n) => describeSharedNote(n)) })) }
      : {}),
  };
}

/** Why a note of the workspace or a teamspace can't be changed by the user, with a next step. */
export const NOT_THEIRS = {
  workspace: "Only the workspace's owners keep its notes. Tell the user; they can ask an owner, or keep the note as their own (scope person).",
  teamspace:
    "Only those who manage this teamspace keep its notes, and only in a teamspace the user is in or manages. Tell the user; they can ask its owners, or keep the note as their own (scope person).",
} as const;
