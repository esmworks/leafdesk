// Client-safe: shared by the meeting block (components/page/meeting-block.tsx), its recorder
// (components/voice/meeting-recorder.tsx), the server (server/meetings.ts) and the Markdown and
// editor schemas.

import { searchFold } from "./search-fold";

/**
 * Meeting notes: a page block that records a meeting from the microphone, transcribes it chunk by
 * chunk while it goes on (speech to text, as voice notes do), and has the AI write a summary, the
 * decisions and the action items when it ends, each pointing at the moment of the transcript it
 * comes from. The audio is never stored. Everything the block shows lives in its props, so it
 * syncs, versions and copies with the page; the server writes the transcript and the summary into
 * them (server/meetings.ts), and `meeting_note` rows list the meetings (the Meetings page).
 */

/** The page block. */
export const MEETING_BLOCK = "meeting";

export const meetingBlockConfig = {
  type: MEETING_BLOCK,
  propSchema: {
    /** Names the meeting; set when the block is made and kept through copies and Markdown rewrites. */
    meetingId: { default: "" },
    title: { default: "" },
    /** When it is planned (ISO), or "". */
    scheduledAt: { default: "" },
    /** When recording first started and when it ended (ISO), or "". */
    startedAt: { default: "" },
    endedAt: { default: "" },
    /** Seconds recorded so far, pauses left out. */
    seconds: { default: 0 },
    /** JSON: [{ id, name }] of workspace people. */
    attendees: { default: "" },
    /** "" (not started), "recording", "summarizing" or "done". */
    status: { default: "" },
    /** Who records it while it is being recorded (user id), and their name to show others. */
    recorder: { default: "" },
    recorderName: { default: "" },
    /** When the recorder last reported (ISO): a recording that goes quiet can be ended by others. */
    lastAt: { default: "" },
    /** JSON: the transcript's chunks (see TranscriptChunk). */
    transcript: { default: "" },
    /** Lines `- text [mm:ss]`; action items `- [ ] @Name: text [mm:ss]`. */
    summary: { default: "" },
    decisions: { default: "" },
    actions: { default: "" },
    /** Why something didn't go as planned (see MEETING_NOTICES), or "". */
    notice: { default: "" },
  },
  content: "none",
} as const;

export type MeetingProps = {
  meetingId: string;
  title: string;
  scheduledAt: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  attendees: string;
  status: string;
  recorder: string;
  recorderName: string;
  lastAt: string;
  transcript: string;
  summary: string;
  decisions: string;
  actions: string;
  notice: string;
};

export const MEETING_STATUSES = ["", "recording", "summarizing", "done"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** Why the block says something went wrong: see `meetings.notices`. */
export const MEETING_NOTICES = ["summaryFailed", "noAi", "limit", "empty"] as const;
export type MeetingNotice = (typeof MEETING_NOTICES)[number];

/** The longest meeting: recording stops by itself at three hours. */
export const MAX_MEETING_SECONDS = 3 * 60 * 60;
/** How long each piece of audio sent to be transcribed is. */
export const MEETING_CHUNK_SECONDS = 30;
/** A recording whose recorder hasn't reported for this long may be ended by anyone who can edit it. */
export const MEETING_STALE_MS = 5 * 60 * 1000;
/** While paused, the recorder says it is still there this often. */
export const MEETING_HEARTBEAT_MS = 2 * 60 * 1000;
/** Longest meeting title and most attendees. */
export const MAX_MEETING_TITLE = 200;
export const MAX_ATTENDEES = 50;
/** Most characters one chunk's transcript keeps (30 s of speech is far less). */
export const MAX_CHUNK_TEXT = 4_000;

export const newMeetingId = () => crypto.randomUUID();

export type Attendee = { id: string; name: string };

/** A piece of the transcript: chunk `c`, starting `t` seconds in, lasting `d`; its text, or a gap. */
export type TranscriptChunk = { c: number; t: number; d?: number; x: string } | { c: number; t: number; d?: number; gap: true };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** The attendees prop read, anything malformed dropped. */
export function parseAttendees(value: unknown): Attendee[] {
  let list: unknown;
  try {
    list = typeof value === "string" && value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Attendee[] = [];
  for (const item of list) {
    if (!isObject(item) || typeof item.name !== "string" || !item.name.trim()) continue;
    const id = typeof item.id === "string" ? item.id : "";
    const key = id || `name:${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name: item.name.trim().slice(0, 100) });
    if (out.length >= MAX_ATTENDEES) break;
  }
  return out;
}

export const serializeAttendees = (list: Attendee[]) => (list.length ? JSON.stringify(list.slice(0, MAX_ATTENDEES)) : "");

/** The transcript prop read, in time order, anything malformed dropped. */
export function parseTranscript(value: unknown): TranscriptChunk[] {
  let list: unknown;
  try {
    list = typeof value === "string" && value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: TranscriptChunk[] = [];
  for (const item of list) {
    if (!isObject(item)) continue;
    const c = finite(item.c);
    const t = finite(item.t);
    if (c === null || t === null) continue;
    const d = finite(item.d) ?? undefined;
    if (item.gap === true) out.push({ c, t, ...(d !== undefined ? { d } : {}), gap: true });
    else if (typeof item.x === "string") out.push({ c, t, ...(d !== undefined ? { d } : {}), x: item.x });
  }
  return out.sort((a, b) => a.t - b.t || a.c - b.c);
}

export const serializeTranscript = (chunks: TranscriptChunk[]) => (chunks.length ? JSON.stringify(chunks) : "");

/**
 * The transcript with one chunk added: in its place by time, replacing an earlier report of the
 * same chunk (a gap whose retry came through, or the other way round, though text is never
 * replaced by a gap).
 */
export function mergeChunk(chunks: TranscriptChunk[], chunk: TranscriptChunk): TranscriptChunk[] {
  const existing = chunks.find((c) => c.c === chunk.c);
  if (existing && !("gap" in existing) && "gap" in chunk) return chunks;
  const next = chunks.filter((c) => c.c !== chunk.c);
  const value: TranscriptChunk = "gap" in chunk ? chunk : { ...chunk, x: chunk.x.trim().slice(0, MAX_CHUNK_TEXT) };
  next.push(value);
  return next.sort((a, b) => a.t - b.t || a.c - b.c);
}

/** `[mm:ss]` as written in the summary and the transcript (`h:mm:ss` from an hour on). */
export function formatStamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** Seconds of a `mm:ss` or `h:mm:ss` stamp (without brackets), or null. */
export function parseStamp(text: string): number | null {
  const match = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** The transcript as the AI and Markdown read it: a line per chunk, `[mm:ss] text`, gaps said. */
export function transcriptLines(chunks: TranscriptChunk[], gapText = "(not transcribed)"): string[] {
  return chunks.flatMap((c) => {
    if ("gap" in c) return [`[${formatStamp(c.t)}] ${gapText}`];
    const text = c.x.replace(/\s+/g, " ").trim();
    return text ? [`[${formatStamp(c.t)}] ${text}`] : [];
  });
}

/** The chunk a moment of the meeting falls in: the last one starting at or before it. */
export function chunkAt(chunks: TranscriptChunk[], seconds: number): TranscriptChunk | null {
  let found: TranscriptChunk | null = null;
  for (const c of chunks) {
    if (c.t <= seconds + 0.5) found = c;
    else break;
  }
  return found ?? chunks[0] ?? null;
}

/** A takeaway: its text, who it is for (action items), whether it is done, and the moment it cites. */
export type Takeaway = { text: string; assignee: string; done: boolean; at: number | null };

const STAMP_AT_END = /\s*\[((?:\d{1,2}:)?\d{1,3}:[0-5]\d)\]\s*$/;

/** One line of a summary section read: `- text [mm:ss]`, `- [ ] @Name: text [mm:ss]`. */
export function parseTakeaway(line: string): Takeaway | null {
  let rest = line.trim().replace(/^(?:[-*+]|\d{1,3}[.)])(?:\s+|$)/, "");
  if (!rest) return null;
  let done = false;
  const box = /^\[([ xX])\]\s*/.exec(rest);
  if (box) {
    done = box[1] !== " ";
    rest = rest.slice(box[0].length);
  }
  let at: number | null = null;
  const stamp = STAMP_AT_END.exec(rest);
  if (stamp) {
    at = parseStamp(stamp[1]);
    rest = rest.slice(0, stamp.index);
  }
  let assignee = "";
  const who = /^@([^:]{1,80}):\s*/.exec(rest);
  if (who) {
    assignee = who[1].trim();
    rest = rest.slice(who[0].length);
  }
  const text = rest.trim();
  return text ? { text, assignee, done, at } : null;
}

/** A section's lines read. */
export const parseTakeaways = (lines: string): Takeaway[] => lines.split("\n").flatMap((line) => parseTakeaway(line) ?? []);

/** A takeaway written back as its line; `action` writes the checkbox. */
export function takeawayLine(item: Takeaway, action = false): string {
  const box = action ? `[${item.done ? "x" : " "}] ` : "";
  const who = item.assignee ? `@${item.assignee}: ` : "";
  const at = item.at !== null ? ` [${formatStamp(item.at)}]` : "";
  return `- ${box}${who}${item.text}${at}`;
}

/** Props of a meeting block from anything (a block's props, Markdown, JSON), defaults filled in. */
export function meetingProps(props: Record<string, unknown> | undefined): MeetingProps {
  const s = (key: string) => (typeof props?.[key] === "string" ? (props[key] as string) : "");
  const seconds = Number(props?.seconds);
  return {
    meetingId: s("meetingId"),
    title: s("title"),
    scheduledAt: s("scheduledAt"),
    startedAt: s("startedAt"),
    endedAt: s("endedAt"),
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
    attendees: s("attendees"),
    status: (MEETING_STATUSES as readonly string[]).includes(s("status")) ? s("status") : "",
    recorder: s("recorder"),
    recorderName: s("recorderName"),
    lastAt: s("lastAt"),
    transcript: s("transcript"),
    summary: s("summary"),
    decisions: s("decisions"),
    actions: s("actions"),
    notice: s("notice"),
  };
}

/** Whether a recording went quiet: its recorder hasn't reported for MEETING_STALE_MS. */
export function isStale(props: Pick<MeetingProps, "status" | "lastAt">, now = Date.now()): boolean {
  if (props.status !== "recording" && props.status !== "summarizing") return false;
  const last = Date.parse(props.lastAt);
  return !Number.isFinite(last) || now - last > MEETING_STALE_MS;
}

// ---------------------------------------------------------------------------------------------
// Text and Markdown

/** Words that never go into the stored Markdown from the block's own text: they would end its region. */
const safe = (text: string) => text.replace(/<!--/g, "<\\!--").replace(/-->/g, "--\\>");

/** The meeting's plain text, as search sees it: title, attendees, takeaways and transcript. */
export function meetingPlainText(raw: Record<string, unknown> | undefined): string {
  const props = meetingProps(raw);
  const lines = [props.title.trim(), parseAttendees(props.attendees).map((a) => a.name).join(", ")];
  for (const section of [props.summary, props.decisions, props.actions]) {
    for (const item of parseTakeaways(section)) lines.push(item.assignee ? `${item.assignee}: ${item.text}` : item.text);
  }
  for (const chunk of parseTranscript(props.transcript)) if (!("gap" in chunk) && chunk.x.trim()) lines.push(chunk.x.trim());
  return lines.filter(Boolean).join("\n");
}

const MEETING_BEGIN = /^ {0,3}<!--\s*leafdesk:meeting\s+([\w-]{1,64})\s*-->\s*$/;
const MEETING_END = /^ {0,3}<!--\s*leafdesk:\/meeting\s*-->\s*$/;

export const parseMeetingBegin = (line: string): string | null => MEETING_BEGIN.exec(line)?.[1] ?? null;
export const isMeetingEnd = (line: string) => MEETING_END.test(line);

const isoMinute = (iso: string) => {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
};

/**
 * A meeting in Markdown (stored for search and history, read by MCP and the AI): its title, when
 * and who, the summary, decisions and action items, and the transcript, between marker lines. A
 * body rewritten with the region keeps the block as it was (restoreMeetings); where the page has no
 * such meeting, what is between the lines comes in as plain blocks.
 *
 *   <!-- leafdesk:meeting 5b1e… -->
 *   ### Weekly sync
 *   …
 *   <!-- leafdesk:/meeting -->
 */
export function meetingMarkdown(raw: Record<string, unknown> | undefined): string {
  const props = meetingProps(raw);
  if (!props.meetingId) return "";
  const out: string[] = [`<!-- leafdesk:meeting ${props.meetingId} -->`, `### ${safe(props.title.trim() || "Meeting")}`, ""];
  const facts = [
    isoMinute(props.startedAt || props.scheduledAt),
    props.seconds ? `${Math.max(1, Math.round(props.seconds / 60))} min` : "",
    parseAttendees(props.attendees).length ? `Attendees: ${parseAttendees(props.attendees).map((a) => safe(a.name)).join(", ")}` : "",
  ].filter(Boolean);
  if (facts.length) out.push(facts.join(" · "), "");
  const section = (label: string, lines: string, action = false) => {
    const items = parseTakeaways(lines);
    if (!items.length) return;
    out.push(`**${label}**`, "", ...items.map((item) => safe(takeawayLine(item, action))), "");
  };
  section("Summary", props.summary);
  section("Decisions", props.decisions);
  section("Action items", props.actions, true);
  const transcript = transcriptLines(parseTranscript(props.transcript));
  if (transcript.length) out.push("**Transcript**", "", ...transcript.map((line) => `- ${safe(line)}`), "");
  out.push("<!-- leafdesk:/meeting -->");
  return out.join("\n");
}

type AnyBlock = { id?: string; type: string; props?: Record<string, unknown>; children?: AnyBlock[] };

/**
 * Meeting blocks parsed from Markdown hold only the meeting id their region named, with what the
 * region held as plain blocks under them: each becomes the page's meeting block with that id,
 * everything kept, or its plain blocks when the page has no such meeting (or it is named twice).
 */
export function restoreMeetings<B extends AnyBlock>(blocks: B[], existing: B[]): B[] {
  const current = new Map<string, B>();
  const collect = (list: B[]) => {
    for (const block of list) {
      const meetingId = block.type === MEETING_BLOCK ? String(block.props?.meetingId ?? "") : "";
      if (meetingId && !current.has(meetingId)) current.set(meetingId, block);
      if (block.children?.length) collect(block.children as B[]);
    }
  };
  collect(existing);
  const used = new Set<string>();
  const walk = (list: B[]): B[] =>
    list.flatMap((block): B[] => {
      if (block.type === MEETING_BLOCK) {
        const meetingId = String(block.props?.meetingId ?? "");
        const match = current.get(meetingId);
        if (!match || used.has(meetingId)) return walk((block.children ?? []) as B[]);
        used.add(meetingId);
        return [{ ...block, id: match.id ?? block.id, props: { ...match.props }, children: [] } as B];
      }
      return block.children?.length ? [{ ...block, children: walk(block.children as B[]) }] : [block];
    });
  return walk(blocks);
}

/** The meeting blocks of a body, nested ones too, in order. */
export function meetingBlocksIn<B extends AnyBlock>(blocks: B[]): B[] {
  const out: B[] = [];
  const walk = (list: B[]) => {
    for (const block of list) {
      if (block.type === MEETING_BLOCK && block.props?.meetingId) out.push(block);
      if (block.children?.length) walk(block.children as B[]);
    }
  };
  walk(blocks);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The Meetings page

/** A meeting as the Meetings page lists it. */
export type MeetingListItem = {
  pageId: string;
  meetingId: string;
  title: string;
  pageTitle: string;
  icon: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  seconds: number;
  attendees: Attendee[];
  status: string;
  /** The summary's first point, if it has one. */
  preview: string;
};

/** Whether a listed meeting matches what was typed: every word in its title, page, attendees or summary. */
export function matchesMeeting(item: MeetingListItem, query: string): boolean {
  const words = searchFold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [item.title, item.pageTitle, item.preview, ...item.attendees.map((a) => a.name)].map(searchFold);
  return words.every((word) => haystack.some((text) => text.includes(word)));
}

/** Upcoming: planned for later and not recorded yet. */
export const isUpcoming = (item: Pick<MeetingListItem, "scheduledAt" | "startedAt" | "status">, now = Date.now()) =>
  !item.startedAt && !item.status && item.scheduledAt !== null && Date.parse(item.scheduledAt) > now;
