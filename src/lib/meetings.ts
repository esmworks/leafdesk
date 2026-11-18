// Client-safe: shared by the meeting block (components/page/meeting-block.tsx), the server
// (server/meetings.ts) and the Markdown and editor schemas. The recorder's clock is in
// meeting-clock.ts, the Meetings page's list in meeting-list.ts.

import { formatStamp, MEETING_STALE_MS } from "./meeting-clock";

export { formatStamp, MAX_MEETING_SECONDS, MEETING_CHUNK_SECONDS, MEETING_HEARTBEAT_MS, MEETING_STALE_MS } from "./meeting-clock";

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
    /** What it is recorded from: "" the microphone, "file" a recording uploaded from elsewhere. */
    source: { default: "" },
    /** Who records it while it is being recorded (user id), and their name to show others. */
    recorder: { default: "" },
    recorderName: { default: "" },
    /** When the recorder last reported (ISO): a recording that goes quiet can be ended by others. */
    lastAt: { default: "" },
    /** JSON: the transcript's chunks (see TranscriptChunk). */
    transcript: { default: "" },
    /** JSON: names given to speakers, `{ [key]: { name, id? } }` (see SpeakerNames). */
    speakers: { default: "" },
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
  source: MeetingSource;
  recorder: string;
  recorderName: string;
  lastAt: string;
  transcript: string;
  speakers: string;
  summary: string;
  decisions: string;
  actions: string;
  notice: string;
};

export const MEETING_STATUSES = ["", "recording", "summarizing", "done"] as const;
export type MeetingSource = "" | "file";
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** Why the block says something went wrong: see `meetings.notices`. */
export const MEETING_NOTICES = ["summaryFailed", "noAi", "limit", "empty"] as const;
export type MeetingNotice = (typeof MEETING_NOTICES)[number];

/** Longest meeting title and most attendees. */
export const MAX_MEETING_TITLE = 200;
export const MAX_ATTENDEES = 50;
/** Most characters one chunk's transcript keeps (30 s of speech is far less). */
export const MAX_CHUNK_TEXT = 4_000;

export const newMeetingId = () => crypto.randomUUID();

export type Attendee = { id: string; name: string };

/**
 * A piece of the transcript: chunk `c`, starting `t` seconds in, lasting `d`; its text, or a gap.
 * `s` says who spoke (a SpeakerKey) when the recording could tell; `r` is "o" for a piece heard
 * from the other participants' stream (tab or system audio), absent for the microphone. A chunk of
 * a recording diarized by the provider is several pieces with the same `c`.
 */
export type TranscriptChunk = { c: number; t: number; d?: number; s?: string; r?: StreamMark } & ({ x: string } | { gap: true });

/** Where a piece was heard: absent the microphone (or the only stream), "o" the other participants'. */
export type StreamMark = "o";

/** A speaker's key: "you" (the microphone, when others are recorded too), "others", "o:A" / "d:A" (the provider's ids). */
export const SPEAKER_KEY = /^[\w:.-]{1,32}$/;
export const MAX_SPEAKERS = 40;

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

const byTime = (a: TranscriptChunk, b: TranscriptChunk) => a.t - b.t || a.c - b.c || (a.r ?? "").localeCompare(b.r ?? "");

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
    const who = {
      ...(d !== undefined ? { d } : {}),
      ...(typeof item.s === "string" && SPEAKER_KEY.test(item.s) ? { s: item.s } : {}),
      ...(item.r === "o" ? { r: "o" as const } : {}),
    };
    if (item.gap === true) out.push({ c, t, ...who, gap: true });
    else if (typeof item.x === "string") out.push({ c, t, ...who, x: item.x });
  }
  return out.sort(byTime);
}

export const serializeTranscript = (chunks: TranscriptChunk[]) => (chunks.length ? JSON.stringify(chunks) : "");

/**
 * The transcript with one chunk added (or, for a diarized chunk, all its pieces: `chunk` a list):
 * in its place by time, replacing an earlier report of the same chunk from the same stream (a gap
 * whose retry came through, or the other way round, though text is never replaced by a gap).
 */
export function mergeChunk(chunks: TranscriptChunk[], chunk: TranscriptChunk | TranscriptChunk[]): TranscriptChunk[] {
  const pieces = Array.isArray(chunk) ? chunk : [chunk];
  if (!pieces.length) return chunks;
  const { c, r } = pieces[0];
  const same = (x: TranscriptChunk) => x.c === c && x.r === r;
  if (pieces.length === 1 && "gap" in pieces[0] && chunks.some((x) => same(x) && !("gap" in x))) return chunks;
  const next = chunks.filter((x) => !same(x));
  for (const piece of pieces) next.push("gap" in piece ? piece : { ...piece, x: piece.x.trim().slice(0, MAX_CHUNK_TEXT) });
  return next.sort(byTime);
}

/** What a recording piece was recorded from, when a recording has both: the microphone or the other participants' stream. */
export type ChunkStream = "mic" | "others";
export const isChunkStream = (value: unknown): value is ChunkStream => value === "mic" || value === "others";

/**
 * The transcript entries one recorded piece becomes. `stream` says what it was recorded from when
 * the recording has two streams: the microphone's pieces are "you", the other participants' are
 * "others" (or, when the provider told its speakers apart, "o:<id>"); a single stream is labelled
 * only by the provider's speakers ("d:<id>"), never guessed. `segments` are the diarized stretches
 * (seconds into the piece); neighbours of one speaker join. Silence is one empty entry.
 */
export function chunkPieces(
  place: { chunk: number; offset: number; duration: number; stream?: ChunkStream },
  text: string,
  segments?: { speaker: string; start: number; end: number; text: string }[] | null,
): TranscriptChunk[] {
  const r = place.stream === "others" ? ({ r: "o" } as const) : {};
  const base = { c: place.chunk, d: place.duration, ...r };
  if (!text.trim()) return [{ ...base, t: place.offset, x: "" }];
  if (place.stream === "mic") return [{ ...base, t: place.offset, s: "you", x: text }];
  if (!segments?.length) return [{ ...base, t: place.offset, ...(place.stream === "others" ? { s: "others" } : {}), x: text }];
  const key = (speaker: string) => (place.stream === "others" ? `o:${speaker}` : `d:${speaker}`);
  const out: TranscriptChunk[] = [];
  for (const seg of segments) {
    const s = key(seg.speaker);
    const last = out[out.length - 1];
    if (last && last.s === s && "x" in last) {
      last.x = `${last.x} ${seg.text}`;
      last.d = Math.max(0, Math.round((place.offset + Math.min(seg.end, place.duration) - last.t) * 10) / 10);
      continue;
    }
    const start = Math.min(Math.max(0, seg.start), place.duration);
    out.push({ ...base, t: Math.round((place.offset + start) * 10) / 10, d: Math.max(0, Math.round((Math.min(seg.end, place.duration) - start) * 10) / 10), s, x: seg.text });
  }
  return out;
}

/** Seconds of a `mm:ss` or `h:mm:ss` stamp (without brackets), or null. */
export function parseStamp(text: string): number | null {
  const match = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * The transcript as the AI and Markdown read it: a line per chunk, `[mm:ss] text`, gaps said. With
 * `nameOf` (see speakerNamer), a line of a known speaker reads `[mm:ss] Name: text`.
 */
export function transcriptLines(chunks: TranscriptChunk[], gapText = "(not transcribed)", nameOf?: (key: string) => string): string[] {
  return chunks.flatMap((c) => {
    if ("gap" in c) return [`[${formatStamp(c.t)}] ${gapText}`];
    const text = c.x.replace(/\s+/g, " ").trim();
    if (!text) return [];
    const who = c.s && nameOf ? nameOf(c.s).replace(/\s+/g, " ").trim() : "";
    return [`[${formatStamp(c.t)}] ${who ? `${who}: ` : ""}${text}`];
  });
}

// ---------------------------------------------------------------------------------------------
// Speakers

/** Names a person gave to speakers: by key, with the workspace member's id when they chose one. */
export type SpeakerNames = Record<string, { name: string; id?: string }>;

/** The speakers prop read, anything malformed dropped. */
export function parseSpeakers(value: unknown): SpeakerNames {
  let map: unknown;
  try {
    map = typeof value === "string" && value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
  if (!isObject(map)) return {};
  const out: SpeakerNames = {};
  for (const [key, item] of Object.entries(map)) {
    if (!SPEAKER_KEY.test(key) || !isObject(item) || typeof item.name !== "string" || !item.name.trim()) continue;
    const id = typeof item.id === "string" && item.id ? item.id.slice(0, 100) : "";
    out[key] = { name: item.name.trim().slice(0, 100), ...(id ? { id } : {}) };
    if (Object.keys(out).length >= MAX_SPEAKERS) break;
  }
  return out;
}

export const serializeSpeakers = (names: SpeakerNames) => (Object.keys(names).length ? JSON.stringify(names) : "");

/** The speakers a transcript tells apart, in the order they first speak. */
export function speakerKeys(chunks: TranscriptChunk[]): string[] {
  const seen = new Set<string>();
  for (const c of chunks) if (c.s && !("gap" in c)) seen.add(c.s);
  return [...seen];
}

/** The words a speaker is called by until someone names them: "You" is the recorder's own name when known. */
export type SpeakerLabels = { you: string; others: string; speaker: (n: number) => string };

export const ENGLISH_SPEAKER_LABELS = (recorderName = ""): SpeakerLabels => ({ you: recorderName.trim() || "You", others: "Others", speaker: (n) => `Speaker ${n}` });

/**
 * A function giving each speaker key its name: the one given in `names`, else "you" / "others" /
 * "Speaker N" (N counting the provider-identified speakers by first appearance).
 */
export function speakerNamer(chunks: TranscriptChunk[], names: SpeakerNames, labels: SpeakerLabels): (key: string) => string {
  const numbered = speakerKeys(chunks).filter((k) => k !== "you" && k !== "others");
  return (key) => {
    const given = names[key]?.name;
    if (given) return given;
    if (key === "you") return labels.you;
    if (key === "others") return labels.others;
    const n = numbered.indexOf(key);
    return labels.speaker(n >= 0 ? n + 1 : numbered.length + 1);
  };
}

/** The member (or attendee) a name given in a summary points at: the whole name, else a first name, only when exactly one fits. */
export function matchPerson(name: string, people: { id: string; name: string }[]): { id: string; name: string } | null {
  const fold = (v: string) => v.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const wanted = fold(name);
  if (!wanted) return null;
  const withId = people.filter((p) => p.id);
  const exact = withId.filter((p) => fold(p.name) === wanted);
  if (exact.length) return exact.every((p) => p.id === exact[0].id) ? exact[0] : null;
  const part = withId.filter((p) => fold(p.name).split(" ").includes(wanted) || wanted.split(" ").includes(fold(p.name)));
  const ids = new Set(part.map((p) => p.id));
  return ids.size === 1 ? part[0] : null;
}

/** Everyone the block can name by id: the attendees and speakers a member was chosen for. */
export function knownPeople(props: Pick<MeetingProps, "attendees" | "speakers">): { id: string; name: string }[] {
  const out = parseAttendees(props.attendees).filter((a) => a.id);
  for (const s of Object.values(parseSpeakers(props.speakers))) if (s.id && !out.some((p) => p.id === s.id)) out.push({ id: s.id, name: s.name });
  return out;
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
    source: s("source") === "file" ? "file" : "",
    recorder: s("recorder"),
    recorderName: s("recorderName"),
    lastAt: s("lastAt"),
    transcript: s("transcript"),
    speakers: s("speakers"),
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
  // Speakers someone named are found by name too.
  for (const { name } of Object.values(parseSpeakers(props.speakers))) lines.push(name);
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
  const chunks = parseTranscript(props.transcript);
  const transcript = transcriptLines(chunks, undefined, speakerNamer(chunks, parseSpeakers(props.speakers), ENGLISH_SPEAKER_LABELS(props.recorderName)));
  if (transcript.length) out.push("**Transcript**", "", ...transcript.map((line) => `- ${safe(line)}`), "");
  out.push("<!-- leafdesk:/meeting -->");
  return out.join("\n");
}

/**
 * Markdown with the transcripts of its meetings (meetingMarkdown's regions) left out, for what
 * shows a body to people who see the meeting only as its block shows it: a published feed's
 * excerpts. A region cut short (the start of a long body) loses all of its transcript too.
 */
export function withoutTranscripts(markdown: string): string {
  if (!markdown.includes("<!-- leafdesk:meeting ")) return markdown;
  const out: string[] = [];
  let inMeeting = false;
  let inTranscript = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("<!-- leafdesk:meeting ")) inMeeting = true;
    else if (line === "<!-- leafdesk:/meeting -->") inMeeting = inTranscript = false;
    else if (inMeeting && line === "**Transcript**") inTranscript = true;
    if (!inTranscript) out.push(line);
  }
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
