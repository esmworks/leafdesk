/**
 * Voice notes: a recording is transcribed (speech to text, STT_PROVIDER), the AI writes the
 * transcript up as a clean note with a title, and the note goes into the workspace: a private page
 * or a database row from the quick note (app/share), or at the cursor in the page editor (the
 * person's own editor inserts it there, see components/voice).
 *
 * Writing up happens first (`draftVoiceNote`), saving after (`saveVoiceNote`), so the quick note
 * shows the note and the person can change it before it is saved. The raw transcript goes along in
 * a toggle block under the note, to check what the AI made of it.
 *
 * The audio is never stored: it is held in memory for the transcription request and dropped with
 * it. The transcript under the note keeps what was said, and recordings would otherwise take up the
 * workspace's file storage for something nobody reads again; people who want the recording can
 * upload the file to the page like any other.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import { MAX_TRANSCRIPT, pickTagValues, transcriptBlock, type VoiceNoteDraft, type VoiceNoteLimits, type VoiceNoteTagProperty } from "@/lib/voice-notes";
import { isPageLocked } from "@/lib/page-lock";
import { PropertyValueError } from "@/lib/properties";
import { AccessError, hasLevel, requireMembership, requirePageAccess, resolvePageAccess, WorkspacePolicyError } from "@/server/access";
import { aiConfig, AiError, complete, sttLimits, transcribe } from "@/server/ai";
import { fallbackVoiceTitle, parseVoiceNote, voiceNotePrompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { getCollab } from "@/server/collab/bridge";
import { knownProperties } from "@/server/databases";
import { createPage } from "@/server/pages";
import { workspaceSettings } from "@/server/workspaces";

/** Room left for the transcript in the prompt after the instructions and the database's options. */
const PROMPT_OVERHEAD = 3_000;
/** Most options of one property offered to the AI. */
const MAX_OPTIONS = 50;
/** Most properties offered to the AI. */
const MAX_TAG_PROPERTIES = 10;

/**
 * The recording limits when voice notes work in a workspace: the server can transcribe and the
 * workspace left AI on (the audio goes to an AI provider like any other AI request). Null otherwise.
 */
export async function voiceNoteLimits(workspaceId: string): Promise<VoiceNoteLimits | null> {
  const limits = sttLimits();
  if (!limits) return null;
  return (await workspaceSettings(workspaceId)).ai !== false ? limits : null;
}

/** Turns access failures into AiError("noAccess"), as the AI routes answer them. */
function noAccess(error: unknown): never {
  if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) throw new AiError("noAccess", "Not found");
  throw error;
}

/** A database the person may add rows to, in `workspaceId`; throws AiError("noAccess") otherwise. */
async function targetDatabase(userId: string, workspaceId: string, databaseId: string) {
  const found = await requirePageAccess(userId, databaseId, "edit").catch(noAccess);
  if (found.kind !== "database" || found.workspaceId !== workspaceId || found.archivedAt || found.inTemplate) {
    throw new AiError("noAccess", "Database not found");
  }
  return found;
}

/** The databases of a workspace a voice note can be added to as a row: the ones the person may edit. */
export async function voiceNoteDatabases(userId: string, workspaceId: string): Promise<{ id: string; title: string; icon: string | null }[]> {
  await requireMembership(userId, workspaceId);
  const rows = await db
    .select({ id: page.id, title: page.title, icon: page.icon })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), eq(page.kind, "database"), eq(page.inTemplate, false)))
    .orderBy(page.title);
  const checked = await Promise.all(
    rows.map(async (row) => {
      const { page: found, level } = await resolvePageAccess(userId, row.id);
      return found && !found.archivedAt && hasLevel(level, "edit") ? row : null;
    }),
  );
  return checked.filter((row) => row !== null);
}

/** The select and multi-select properties (with options) of a database the AI may fill for a note. */
export async function voiceTagProperties(userId: string, databaseId: string): Promise<VoiceNoteTagProperty[]> {
  const properties = await knownProperties(userId, databaseId);
  return properties
    .filter((p) => (p.type === "select" || p.type === "multi_select") && p.options.options?.length)
    .slice(0, MAX_TAG_PROPERTIES)
    .map((p) => ({
      id: p.id,
      name: p.name,
      multiple: p.type === "multi_select",
      options: (p.options.options ?? []).slice(0, MAX_OPTIONS).map((o) => o.name),
    }));
}

export type VoiceNoteTarget =
  /** The quick note: a private page of the workspace, or a row of `databaseId`. */
  | { workspaceId: string; databaseId?: string | null }
  /** The editor: the note goes into this page at the cursor. */
  | { pageId: string };

/** Where a recording's note goes, checked: the workspace, and the database whose options apply. */
async function resolveTarget(userId: string, target: VoiceNoteTarget) {
  if ("pageId" in target) {
    const found = await requirePageAccess(userId, target.pageId, "edit").catch(noAccess);
    if (found.archivedAt || found.kind !== "page") throw new AiError("noAccess", "Page not found");
    if (isPageLocked(found)) throw new AiError("noAccess", "The page is locked");
    return { workspaceId: found.workspaceId, databaseId: null };
  }
  await requireMembership(userId, target.workspaceId).catch(noAccess);
  if (target.databaseId) await targetDatabase(userId, target.workspaceId, target.databaseId);
  return { workspaceId: target.workspaceId, databaseId: target.databaseId ?? null };
}

/**
 * Checks where the note goes and that voice notes work there, before anything is sent anywhere.
 * Throws AiError ("noAccess", "disabled").
 */
export async function prepareVoiceNote(userId: string, target: VoiceNoteTarget) {
  const resolved = await resolveTarget(userId, target);
  if (!(await voiceNoteLimits(resolved.workspaceId))) throw new AiError("disabled", "Voice notes are off for this workspace");
  return resolved;
}

/**
 * Writes a recording up as a note. `onStage` hears when the transcript is done and writing starts.
 * When the AI can't write it up (no chat model, a provider failure, an answer cut off at the output
 * limit), the note is the transcript itself with its first words as the title. Throws AiError for
 * failures to transcribe (and when cancelled).
 */
export async function draftVoiceNote(
  userId: string,
  target: Awaited<ReturnType<typeof prepareVoiceNote>>,
  audio: { bytes: Blob; type: string },
  { signal, onStage }: { signal?: AbortSignal; onStage?: (stage: "writing") => void } = {},
): Promise<VoiceNoteDraft> {
  const { workspaceId, databaseId } = target;
  const transcript = (await transcribe(audio, { feature: "voice.transcribe", userId, workspaceId, signal })).slice(0, MAX_TRANSCRIPT);
  const raw: VoiceNoteDraft = { title: fallbackVoiceTitle(transcript), markdown: transcript, transcript, properties: {}, rewritten: false };
  if (!(await aiAvailable(workspaceId))) return raw;
  onStage?.("writing");
  const tags = databaseId ? await voiceTagProperties(userId, databaseId) : [];
  const maxContent = Math.max(1_000, aiConfig().limits.maxInputChars - PROMPT_OVERHEAD);
  const prompt = voiceNotePrompt(transcript, tags, maxContent);
  try {
    const result = await complete({
      feature: "voice.rewrite",
      userId,
      workspaceId,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.prompt }],
      signal,
    });
    // A note cut off half way would lose what was said; the transcript keeps all of it.
    if (result.stopReason === "length") return raw;
    const parsed = parseVoiceNote(result.text);
    if (!parsed.markdown) return raw;
    return {
      title: parsed.title || raw.title,
      markdown: parsed.markdown,
      transcript,
      properties: pickTagValues(parsed.tags, tags),
      rewritten: true,
    };
  } catch (error) {
    if (error instanceof AiError && error.code === "aborted") throw error;
    // Already logged by the AI layer; the transcript is too good to throw away.
    return raw;
  }
}

export type SaveVoiceNoteInput = {
  workspaceId: string;
  databaseId?: string | null;
  title: string;
  markdown: string;
  transcript: string;
  properties?: Record<string, string | string[]>;
  /** The transcript toggle's title, in the person's language. */
  transcriptLabel: string;
};

/**
 * Saves a written-up note: a private page at the top of the workspace, or a row of the database
 * with the property values the AI picked (left out when one can't be set, e.g. a property the
 * person may not change). The transcript goes in a toggle under the note. Returns the new page.
 */
export async function saveVoiceNote(userId: string, input: SaveVoiceNoteInput): Promise<{ id: string; workspaceId: string }> {
  const actor = { userId };
  await requireMembership(userId, input.workspaceId);
  const title = input.title.trim();
  const markdown = input.markdown;
  let created;
  if (input.databaseId) {
    const database = await targetDatabase(userId, input.workspaceId, input.databaseId);
    const properties = input.properties ?? {};
    const create = (values: Record<string, unknown>) =>
      createPage(actor, { workspaceId: database.workspaceId, parentId: database.id, title, properties: values, markdown });
    try {
      created = await create(properties);
    } catch (error) {
      if (!Object.keys(properties).length || !(error instanceof PropertyValueError || error instanceof AccessError)) throw error;
      created = await create({});
    }
  } else {
    created = await createPage(actor, { workspaceId: input.workspaceId, title, markdown, teamspaceId: null });
  }
  const transcript = input.transcript.trim().slice(0, MAX_TRANSCRIPT);
  if (transcript) await getCollab().appendBlocks(created.id, [transcriptBlock(transcript, input.transcriptLabel)], actor);
  return { id: created.id, workspaceId: created.workspaceId };
}
