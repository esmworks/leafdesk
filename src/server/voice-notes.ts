/**
 * Voice notes: a recording is transcribed (speech to text, STT_PROVIDER), the AI writes the
 * transcript up as a clean note with a title, and the note goes into the workspace: a private page
 * or a database row from the quick note (app/share), or at the cursor in the page editor (the
 * person's own editor inserts it there, see components/voice).
 *
 * Writing up happens first (`draftVoiceNote`), saving after (`saveVoiceNote`), so the quick note
 * shows the note and the person can change it before it is saved. The raw transcript goes along in
 * a toggle block under the note, to check what the AI made of it. Apps sending a recording through
 * the REST API (`POST /api/v1/voice-notes`) get both in one go (`createVoiceNote`).
 *
 * The audio is never stored: it is held in memory for the transcription request and dropped with
 * it. The transcript under the note keeps what was said, and recordings would otherwise take up the
 * workspace's file storage for something nobody reads again; people who want the recording can
 * upload the file to the page like any other.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import { cleanVoiceNoteInstructions, MAX_TRANSCRIPT, pickTagValues, transcriptBlock, type VoiceNoteDraft, type VoiceNoteLimits, type VoiceNoteTagProperty } from "@/lib/voice-notes";
import { isPageLocked } from "@/lib/page-lock";
import { PropertyValueError } from "@/lib/properties";
import {
  AccessError,
  accessRank,
  ConnectedAppReadOnlyError,
  hasLevel,
  levelFromRank,
  requireMembership,
  requirePageAccess,
  WorkspacePolicyError,
} from "@/server/access";
import { aiConfig, AiError, complete, contentChars, sttLimitsFor, transcribe } from "@/server/ai";
import { fallbackVoiceTitle, parseVoiceNote, voiceNotePrompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { getCollab } from "@/server/collab/bridge";
import { knownProperties, requireDatabase } from "@/server/databases";
import { loadMessages } from "@/i18n/messages";
import { recipientLocale } from "@/server/mail/locale";
import { createPage } from "@/server/pages";
import { workspaceSettings } from "@/server/workspaces";

/**
 * Room left for the transcript in the prompt after the instructions and the database's options;
 * the database's own writing instructions come off it too.
 */
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
  const limits = await sttLimitsFor(workspaceId);
  if (!limits) return null;
  return (await workspaceSettings(workspaceId)).ai !== false ? limits : null;
}

/**
 * Turns access failures into AiError("noAccess"), as the AI routes answer them. Refusals that say
 * why (a sign-in policy, a workspace letting apps only read) go through as they are.
 */
function noAccess(error: unknown): never {
  if (error instanceof AccessError && !(error instanceof WorkspacePolicyError) && !(error instanceof ConnectedAppReadOnlyError)) {
    throw new AiError("noAccess", "Not found");
  }
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

/**
 * The databases of a workspace a voice note can be added to as a row: the ones the person may edit.
 * `instructions` says whether the database has writing instructions for its notes (not what they say).
 */
export async function voiceNoteDatabases(
  userId: string,
  workspaceId: string,
): Promise<{ id: string; title: string; icon: string | null; instructions: boolean }[]> {
  // The workspace's sign-in policies are checked here, once; access to each database in the query.
  await requireMembership(userId, workspaceId);
  const rows = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      instructions: sql<boolean>`${page.voiceNoteInstructions} <> ''`,
      level: accessRank(userId, sql`${page.id}`),
    })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), eq(page.kind, "database"), eq(page.inTemplate, false), isNull(page.archivedAt)))
    .orderBy(page.title);
  return rows.filter((row) => hasLevel(levelFromRank(row.level), "edit")).map(({ level: _level, ...row }) => row);
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

/**
 * A database's writing instructions for the voice notes saved in it, to edit them. Shared by
 * everyone who records into the database; set by people with full access to it, like its other
 * settings (locking it, automations).
 */
export async function getVoiceNoteInstructions(userId: string, databaseId: string): Promise<string> {
  const database = await requireDatabase(userId, databaseId, "full");
  return database.voiceNoteInstructions;
}

/** Sets a database's writing instructions for voice notes (see getVoiceNoteInstructions); empty removes them. */
export async function setVoiceNoteInstructions(userId: string, databaseId: string, text: string): Promise<string> {
  const database = await requireDatabase(userId, databaseId, "full");
  if (database.archivedAt) throw new AccessError("The database is in the trash");
  const instructions = cleanVoiceNoteInstructions(text);
  await db.update(page).set({ voiceNoteInstructions: instructions, updatedBy: userId }).where(eq(page.id, databaseId));
  return instructions;
}

export type VoiceNoteTarget =
  /** The quick note: a private page of the workspace, or a row of `databaseId`. */
  | { workspaceId: string; databaseId?: string | null }
  /** The editor: the note goes into this page at the cursor. */
  | { pageId: string };

/**
 * Where a recording's note goes, checked: the workspace, and the database whose options and writing
 * instructions apply.
 */
async function resolveTarget(userId: string, target: VoiceNoteTarget): Promise<{ workspaceId: string; databaseId: string | null; instructions: string }> {
  if ("pageId" in target) {
    const found = await requirePageAccess(userId, target.pageId, "edit").catch(noAccess);
    if (found.archivedAt || found.kind !== "page") throw new AiError("noAccess", "Page not found");
    if (isPageLocked(found)) throw new AiError("noAccess", "The page is locked");
    return { workspaceId: found.workspaceId, databaseId: null, instructions: "" };
  }
  await requireMembership(userId, target.workspaceId).catch(noAccess);
  const database = target.databaseId ? await targetDatabase(userId, target.workspaceId, target.databaseId) : null;
  return { workspaceId: target.workspaceId, databaseId: database?.id ?? null, instructions: database?.voiceNoteInstructions ?? "" };
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
 * Saves the page to its history before a voice note goes in at the cursor, like the writing
 * assistant's suggestions ("Before AI assistant edit"). Checked as voice notes are: the person may
 * edit the page and voice notes work in its workspace, with or without a chat model.
 */
export async function snapshotBeforeVoiceNote(userId: string, pageId: string) {
  await prepareVoiceNote(userId, { pageId });
  await getCollab().snapshot(pageId, "before_ai_edit", { userId });
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
  const { workspaceId, databaseId, instructions } = target;
  const transcript = (await transcribe(audio, { feature: "voice.transcribe", userId, workspaceId, signal })).slice(0, MAX_TRANSCRIPT);
  const raw: VoiceNoteDraft = { title: fallbackVoiceTitle(transcript), markdown: transcript, transcript, properties: {}, rewritten: false };
  if (!(await aiAvailable(workspaceId))) return raw;
  onStage?.("writing");
  const tags = databaseId ? await voiceTagProperties(userId, databaseId) : [];
  const maxContent = Math.max(1_000, contentChars(aiConfig().limits) - PROMPT_OVERHEAD - instructions.length);
  const prompt = voiceNotePrompt(transcript, tags, maxContent, instructions);
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

/**
 * A question dictated in the AI chat's box: the recording written down as it was said, for the
 * person to check before sending. Works where voice notes do, and counts as the chat's AI usage
 * ("chat.dictate"). Throws AiError ("noAccess", "disabled", and transcription failures).
 */
export async function transcribeDictation(
  userId: string,
  workspaceId: string,
  audio: { bytes: Blob; type: string },
  { signal }: { signal?: AbortSignal } = {},
): Promise<string> {
  await requireMembership(userId, workspaceId).catch(noAccess);
  if (!(await voiceNoteLimits(workspaceId))) throw new AiError("disabled", "Speech to text is off for this workspace");
  return (await transcribe(audio, { feature: "chat.dictate", userId, workspaceId, signal })).trim().slice(0, MAX_TRANSCRIPT);
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
export async function saveVoiceNote(
  userId: string,
  input: SaveVoiceNoteInput,
): Promise<{ id: string; workspaceId: string; properties: Record<string, string | string[]> }> {
  const actor = { userId };
  await requireMembership(userId, input.workspaceId);
  const title = input.title.trim();
  const markdown = input.markdown;
  let created;
  /** The values the row got (none when they no longer fit the database). */
  let properties: Record<string, string | string[]> = {};
  if (input.databaseId) {
    const database = await targetDatabase(userId, input.workspaceId, input.databaseId);
    properties = input.properties ?? {};
    const create = (values: Record<string, unknown>) =>
      createPage(actor, { workspaceId: database.workspaceId, parentId: database.id, title, properties: values, markdown });
    try {
      created = await create(properties);
    } catch (error) {
      if (!Object.keys(properties).length || !(error instanceof PropertyValueError || error instanceof AccessError)) throw error;
      properties = {};
      created = await create({});
    }
  } else {
    created = await createPage(actor, { workspaceId: input.workspaceId, title, markdown, teamspaceId: null });
  }
  const transcript = input.transcript.trim().slice(0, MAX_TRANSCRIPT);
  if (transcript) await getCollab().appendBlocks(created.id, [transcriptBlock(transcript, input.transcriptLabel)], actor);
  return { id: created.id, workspaceId: created.workspaceId, properties };
}

/**
 * A recording written up and saved in one go, for apps (the REST API): a private page of the
 * workspace, or a row of `databaseId`. The transcript toggle is titled in the language the person
 * last used the app in. `properties` are the values the row got, by property name. Throws AiError
 * ("noAccess", "disabled", and transcription failures).
 */
export async function createVoiceNote(
  userId: string,
  target: { workspaceId: string; databaseId?: string | null },
  audio: { bytes: Blob; type: string },
  { signal }: { signal?: AbortSignal } = {},
) {
  const prepared = await prepareVoiceNote(userId, target);
  const draft = await draftVoiceNote(userId, prepared, audio, { signal });
  const messages = await loadMessages(await recipientLocale(userId, null));
  const created = await saveVoiceNote(userId, {
    workspaceId: prepared.workspaceId,
    databaseId: prepared.databaseId,
    title: draft.title,
    markdown: draft.markdown,
    transcript: draft.transcript,
    properties: draft.properties,
    transcriptLabel: messages.page.voiceNote.transcriptToggle,
  });
  // By property name, as apps read and write them.
  const names = new Map(prepared.databaseId ? (await knownProperties(userId, prepared.databaseId)).map((p) => [p.id, p.name]) : []);
  const properties = Object.fromEntries(Object.entries(created.properties).flatMap(([id, value]) => (names.has(id) ? [[names.get(id)!, value]] : [])));
  return { id: created.id, workspaceId: created.workspaceId, databaseId: prepared.databaseId, draft, properties };
}
