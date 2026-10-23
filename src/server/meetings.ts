/**
 * Meeting notes (lib/meetings): a meeting block records a meeting from the browser's microphone,
 * sends it here in pieces of about 30 seconds (app/api/meetings/chunk), and each piece is
 * transcribed as it comes and written into the block's transcript at its time, so everyone with
 * the page open sees it fill in. When the recording stops, the AI writes the summary, decisions and
 * action items into the block. The audio is never stored: each piece is held in memory for its
 * transcription request and dropped with it, as for voice notes (server/voice-notes.ts).
 *
 * The browser keeps the recording going (components/voice/meeting-recorder.tsx); the server checks
 * every piece again: the person may still edit the page, the meeting is being recorded by them,
 * and it stays under MAX_MEETING_SECONDS. Writes go into the block's props in place
 * (CollabService.updateBlockAttributes), so they never undo what people type meanwhile.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { meetingNote, page } from "@/db/schema";
import {
  isStale,
  MAX_MEETING_SECONDS,
  MAX_MEETING_TITLE,
  MEETING_BLOCK,
  meetingProps,
  mergeChunk,
  newMeetingId,
  parseAttendees,
  parseTranscript,
  serializeTranscript,
  transcriptLines,
  type MeetingListItem,
  type MeetingProps,
  type TranscriptChunk,
} from "@/lib/meetings";
import { isPageLocked } from "@/lib/page-lock";
import { AccessError, pageVisibleTo, requireMembership, requirePageAccess } from "@/server/access";
import { aiConfig, AiError, complete, contentChars, transcribe } from "@/server/ai";
import { meetingMergePrompt, meetingSummaryPrompt, parseMeetingSummary } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { getCollab } from "@/server/collab/bridge";
import { createPage } from "@/server/pages";
import { voiceNoteLimits } from "@/server/voice-notes";

/** Why a meeting request was refused: see `meetings.errors`. */
export const MEETING_ERRORS = ["noAccess", "notFound", "disabled", "busy", "tooLong", "notRecording", "invalid"] as const;
export type MeetingErrorCode = (typeof MEETING_ERRORS)[number];

export class MeetingError extends Error {
  constructor(
    readonly code: MeetingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeetingError";
  }
}

export const isMeetingError = (error: unknown): error is MeetingError => error instanceof MeetingError;

/** Room left for the transcript in the prompt after the instructions. */
const PROMPT_OVERHEAD = 3_000;
/** A piece may run this far past MAX_MEETING_SECONDS (the recorder stops at the next second). */
const LENGTH_SLACK = 60;

/** The page a meeting block is on, checked: the person may edit it, and it can be written. */
async function meetingPage(userId: string, pageId: string) {
  const found = await requirePageAccess(userId, pageId, "edit").catch((error) => {
    if (error instanceof AccessError) throw new MeetingError("noAccess", "You can't edit this page");
    throw error;
  });
  if (found.archivedAt || found.kind === "database" || isPageLocked(found)) throw new MeetingError("noAccess", "This page can't be changed");
  return found;
}

const findMeeting = (meetingId: string) => (props: Record<string, unknown>) => props.meetingId === meetingId;
const nowIso = () => new Date().toISOString();

/**
 * Changes the meeting block's props in place: `update` gets them read and returns the props to set
 * (or null for none), and may throw a MeetingError to refuse. Throws "notFound" when the page has
 * no such meeting. Resolves to the props after the change.
 */
async function updateMeeting(
  userId: string,
  pageId: string,
  meetingId: string,
  update: (props: MeetingProps) => Partial<Record<keyof MeetingProps, string | number>> | null,
): Promise<MeetingProps> {
  const after = await getCollab().updateBlockAttributes(
    pageId,
    MEETING_BLOCK,
    findMeeting(meetingId),
    (raw) => update(meetingProps(raw)) as Record<string, string | number> | null,
    { userId },
  );
  if (!after) throw new MeetingError("notFound", "This meeting isn't on the page anymore");
  return meetingProps(after);
}

/** The meeting block's props as they are now, or "notFound". */
async function readMeeting(pageId: string, meetingId: string): Promise<MeetingProps> {
  const { blocks } = await getCollab().readBlocks(pageId);
  const walk = (list: unknown[]): Record<string, unknown> | null => {
    for (const block of list as { type?: string; props?: Record<string, unknown>; children?: unknown[] }[]) {
      if (block.type === MEETING_BLOCK && block.props?.meetingId === meetingId) return block.props;
      const inner = block.children?.length ? walk(block.children) : null;
      if (inner) return inner;
    }
    return null;
  };
  const found = walk(blocks);
  if (!found) throw new MeetingError("notFound", "This meeting isn't on the page anymore");
  return meetingProps(found);
}

/** Who may record now: nobody else is recording or writing it up, unless they went quiet. */
function assertFree(props: MeetingProps, userId: string) {
  if (props.status === "recording" && props.recorder !== userId && !isStale(props)) throw new MeetingError("busy", "Someone else is recording this meeting");
  if (props.status === "summarizing" && !isStale(props)) throw new MeetingError("busy", "The summary is being written");
}

/**
 * Starts (or carries on) recording a meeting. Throws MeetingError ("disabled" without speech to
 * text, "busy", "tooLong"). Returns where the recording goes on from: the seconds recorded so far
 * and the next piece's number.
 */
export async function startMeeting(userId: string, pageId: string, meetingId: string, userName = ""): Promise<{ seconds: number; nextChunk: number }> {
  const found = await meetingPage(userId, pageId);
  if (!(await voiceNoteLimits(found.workspaceId))) throw new MeetingError("disabled", "Speech to text isn't available in this workspace");
  const props = await updateMeeting(userId, pageId, meetingId, (p) => {
    assertFree(p, userId);
    if (p.seconds >= MAX_MEETING_SECONDS) throw new MeetingError("tooLong", "This meeting reached its length limit");
    const now = nowIso();
    return { status: "recording", recorder: userId, recorderName: userName.slice(0, 100), startedAt: p.startedAt || now, endedAt: "", lastAt: now, notice: "" };
  });
  const chunks = parseTranscript(props.transcript);
  return { seconds: props.seconds, nextChunk: chunks.reduce((max, c) => Math.max(max, c.c + 1), 0) };
}

export type ChunkPlace = { pageId: string; meetingId: string; chunk: number; offset: number; duration: number };

function checkPlace(place: ChunkPlace) {
  const ok =
    Number.isInteger(place.chunk) &&
    place.chunk >= 0 &&
    place.chunk < 100_000 &&
    Number.isFinite(place.offset) &&
    place.offset >= 0 &&
    Number.isFinite(place.duration) &&
    place.duration >= 0 &&
    place.duration <= 600;
  if (!ok) throw new MeetingError("invalid", "The recording's place in the meeting is missing");
  if (place.offset + place.duration > MAX_MEETING_SECONDS + LENGTH_SLACK) throw new MeetingError("tooLong", "Meetings can be at most three hours long");
}

/** Writes a piece of the transcript (text or a gap) into the block, if its recorder still records it. */
async function writeChunk(userId: string, place: ChunkPlace, chunk: TranscriptChunk) {
  return updateMeeting(userId, place.pageId, place.meetingId, (p) => {
    if (p.status !== "recording" || p.recorder !== userId) throw new MeetingError("notRecording", "This meeting isn't being recorded by you");
    return {
      transcript: serializeTranscript(mergeChunk(parseTranscript(p.transcript), chunk)),
      seconds: Math.min(MAX_MEETING_SECONDS, Math.max(p.seconds, Math.round(place.offset + place.duration))),
      lastAt: nowIso(),
    };
  });
}

/**
 * A piece of a meeting's recording: transcribed (counted as the workspace's AI usage, feature
 * "voice.meeting") and written into the block at its time. Silence writes an empty piece. Throws
 * MeetingError, or AiError when transcribing fails (the browser tries again, then calls
 * markMeetingGap).
 */
export async function addMeetingChunk(userId: string, place: ChunkPlace, audio: { bytes: Blob; type: string }, { signal }: { signal?: AbortSignal } = {}) {
  checkPlace(place);
  const found = await meetingPage(userId, place.pageId);
  const before = await readMeeting(place.pageId, place.meetingId);
  if (before.status !== "recording" || before.recorder !== userId) throw new MeetingError("notRecording", "This meeting isn't being recorded by you");
  let text = "";
  try {
    text = await transcribe(audio, { feature: "voice.meeting", userId, workspaceId: found.workspaceId, signal });
  } catch (error) {
    // Nothing said in these seconds: not a failure.
    if (!(error instanceof AiError && error.code === "empty")) throw error;
  }
  const props = await writeChunk(userId, place, { c: place.chunk, t: place.offset, d: place.duration, x: text });
  return { text: text.trim(), seconds: props.seconds };
}

/** A piece that couldn't be transcribed after its retries: a gap in the transcript at its time. */
export async function markMeetingGap(userId: string, place: ChunkPlace) {
  checkPlace(place);
  await meetingPage(userId, place.pageId);
  await writeChunk(userId, place, { c: place.chunk, t: place.offset, d: place.duration, gap: true });
}

/** The recorder is still there (while paused, when no pieces come). */
export async function meetingHeartbeat(userId: string, pageId: string, meetingId: string, seconds: number) {
  await meetingPage(userId, pageId);
  await updateMeeting(userId, pageId, meetingId, (p) => {
    if (p.status !== "recording" || p.recorder !== userId) throw new MeetingError("notRecording", "This meeting isn't being recorded by you");
    const recorded = Number.isFinite(seconds) ? Math.min(MAX_MEETING_SECONDS, Math.max(p.seconds, Math.round(seconds))) : p.seconds;
    return { lastAt: nowIso(), seconds: recorded };
  });
}

/** Summaries being written in this process, by page and meeting: one at a time for each. */
const writing = new Set<string>();

/**
 * Ends the recording and has the AI write it up, in the background: the block says it is being
 * written, and the summary goes in when it's done. Its recorder ends it; anyone who may edit the
 * page may end one that went quiet (its browser closed). `seconds`: what the browser recorded.
 */
export async function finishMeeting(userId: string, pageId: string, meetingId: string, seconds?: number) {
  const found = await meetingPage(userId, pageId);
  await updateMeeting(userId, pageId, meetingId, (p) => {
    if (p.status !== "recording") throw new MeetingError("notRecording", "This meeting isn't being recorded");
    if (p.recorder !== userId && !isStale(p)) throw new MeetingError("busy", "Someone else is recording this meeting");
    const now = nowIso();
    const recorded = seconds !== undefined && Number.isFinite(seconds) ? Math.min(MAX_MEETING_SECONDS, Math.max(p.seconds, Math.round(seconds))) : p.seconds;
    return { status: "summarizing", endedAt: now, lastAt: now, seconds: recorded, notice: "" };
  });
  startSummary(userId, pageId, meetingId, found.workspaceId);
}

/** Writes the summary again from the transcript, replacing the one there (edits to it included). */
export async function regenerateMeetingSummary(userId: string, pageId: string, meetingId: string) {
  const found = await meetingPage(userId, pageId);
  await updateMeeting(userId, pageId, meetingId, (p) => {
    if (p.status === "recording" && !isStale(p)) throw new MeetingError("busy", "This meeting is still being recorded");
    if (p.status === "summarizing" && !isStale(p)) throw new MeetingError("busy", "The summary is being written");
    if (!parseTranscript(p.transcript).length) throw new MeetingError("invalid", "There is no transcript to write up yet");
    return { status: "summarizing", lastAt: nowIso(), endedAt: p.endedAt || nowIso(), notice: "" };
  });
  startSummary(userId, pageId, meetingId, found.workspaceId);
}

function startSummary(userId: string, pageId: string, meetingId: string, workspaceId: string) {
  const key = `${pageId}:${meetingId}`;
  if (writing.has(key)) return;
  writing.add(key);
  void summarizeMeeting(userId, pageId, meetingId, workspaceId)
    .catch((error) => console.error(`[meetings] could not write up meeting ${meetingId} of page ${pageId}`, error))
    .finally(() => writing.delete(key));
}

/**
 * The write-up of a transcript: one request when it fits the model's prompt, else one per part and
 * one more putting the parts together. Returns null when the AI didn't give one.
 */
export async function writeUpMeeting(
  lines: string[],
  attendees: string[],
  seconds: number,
  ai: { userId: string; workspaceId: string; signal?: AbortSignal },
): Promise<{ summary: string; decisions: string; actions: string } | null> {
  const room = Math.max(1_000, contentChars(aiConfig().limits) - PROMPT_OVERHEAD);
  const ask = async (prompt: { system: string; prompt: string }) => {
    const result = await complete({ feature: "voice.meetingSummary", ...ai, system: prompt.system, messages: [{ role: "user", content: prompt.prompt }] });
    return result.stopReason === "length" ? null : result.text;
  };
  const transcript = lines.join("\n");
  let answer: string | null;
  if (transcript.length <= room) {
    answer = await ask(meetingSummaryPrompt(transcript, attendees, room));
  } else {
    const parts: string[] = [];
    let current: string[] = [];
    let size = 0;
    for (const line of lines) {
      if (size + line.length + 1 > room && current.length) {
        parts.push(current.join("\n"));
        current = [];
        size = 0;
      }
      current.push(line);
      size += line.length + 1;
    }
    if (current.length) parts.push(current.join("\n"));
    const written: string[] = [];
    for (const [i, part] of parts.entries()) {
      const text = await ask(meetingSummaryPrompt(part, attendees, room, { index: i + 1, of: parts.length }));
      if (text) written.push(text);
    }
    if (!written.length) return null;
    answer = (await ask(meetingMergePrompt(written, attendees, room))) ?? written.join("\n\n");
  }
  if (!answer) return null;
  const parsed = parseMeetingSummary(answer, seconds);
  return parsed.summary || parsed.decisions || parsed.actions ? parsed : null;
}

async function summarizeMeeting(userId: string, pageId: string, meetingId: string, workspaceId: string) {
  const props = await readMeeting(pageId, meetingId);
  const lines = transcriptLines(parseTranscript(props.transcript), "(not transcribed)");
  const heard = parseTranscript(props.transcript).some((c) => !("gap" in c) && c.x.trim());
  const done = (values: Partial<Record<keyof MeetingProps, string>>) =>
    updateMeeting(userId, pageId, meetingId, (p) => (p.status === "summarizing" ? { status: "done", lastAt: nowIso(), ...values } : null));
  if (!heard) return done({ notice: "empty" });
  if (!(await aiAvailable(workspaceId))) return done({ notice: "noAi" });
  try {
    const written = await writeUpMeeting(lines, parseAttendees(props.attendees).map((a) => a.name), props.seconds, { userId, workspaceId });
    if (!written) return done({ notice: "summaryFailed" });
    return done({ ...written, notice: "" });
  } catch (error) {
    if (!(error instanceof AiError)) console.error("[meetings] summary", error);
    return done({ notice: error instanceof AiError && error.code === "limitReached" ? "limit" : "summaryFailed" });
  }
}

/**
 * A new private page holding a meeting block, planned for now, for "New meeting note". `title`:
 * the page's title (the person's language's "Meeting notes, <date>").
 */
export async function createMeetingNote(userId: string, workspaceId: string, title: string): Promise<{ id: string }> {
  await requireMembership(userId, workspaceId);
  const created = await createPage({ userId }, { workspaceId, title: title.trim().slice(0, MAX_MEETING_TITLE), teamspaceId: null });
  await getCollab().appendBlocks(
    created.id,
    [
      { type: MEETING_BLOCK, props: { meetingId: newMeetingId(), scheduledAt: nowIso() } },
      { type: "paragraph", content: [] },
    ],
    { userId },
  );
  return { id: created.id };
}

/** Most meetings the Meetings page lists. */
const MAX_LISTED = 500;

/**
 * The meetings of a workspace the person can see, newest first (by when they started, else when
 * they are planned). Pages in the trash and templates are left out.
 */
export async function listMeetings(userId: string, workspaceId: string): Promise<MeetingListItem[]> {
  await requireMembership(userId, workspaceId);
  const rows = await db
    .select({
      pageId: meetingNote.pageId,
      meetingId: meetingNote.meetingId,
      title: meetingNote.title,
      pageTitle: page.title,
      icon: page.icon,
      scheduledAt: meetingNote.scheduledAt,
      startedAt: meetingNote.startedAt,
      endedAt: meetingNote.endedAt,
      seconds: meetingNote.seconds,
      attendees: meetingNote.attendees,
      status: meetingNote.status,
      preview: meetingNote.preview,
    })
    .from(meetingNote)
    .innerJoin(page, eq(page.id, meetingNote.pageId))
    .where(and(eq(page.workspaceId, workspaceId), isNull(page.archivedAt), eq(page.inTemplate, false), pageVisibleTo(userId)))
    .orderBy(desc(sql`coalesce(${meetingNote.startedAt}, ${meetingNote.scheduledAt}, ${meetingNote.createdAt})`))
    .limit(MAX_LISTED);
  return rows.map((r) => ({
    ...r,
    scheduledAt: r.scheduledAt?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    attendees: Array.isArray(r.attendees) ? r.attendees : [],
  }));
}
