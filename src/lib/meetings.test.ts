import { describe, expect, it } from "vitest";
import { blocksToPlainText } from "./blocks";
import {
  chunkAt,
  chunkPieces,
  knownPeople,
  matchPerson,
  parseSpeakers,
  serializeSpeakers,
  speakerKeys,
  speakerNamer,
  ENGLISH_SPEAKER_LABELS,
  formatStamp,
  isStale,
  meetingMarkdown,
  mergeChunk,
  parseAttendees,
  parseStamp,
  parseTakeaway,
  parseTakeaways,
  parseTranscript,
  restoreMeetings,
  serializeTranscript,
  takeawayLine,
  transcriptLines,
  type TranscriptChunk,
  withoutTranscripts,
} from "./meetings";

describe("meeting transcripts", () => {
  it("merge chunks in time order, whatever order they arrive in", () => {
    let chunks: TranscriptChunk[] = [];
    chunks = mergeChunk(chunks, { c: 1, t: 30, d: 30, x: "  second  " });
    chunks = mergeChunk(chunks, { c: 0, t: 0, d: 30, x: "first" });
    chunks = mergeChunk(chunks, { c: 2, t: 60, d: 30, gap: true });
    expect(chunks).toEqual([
      { c: 0, t: 0, d: 30, x: "first" },
      { c: 1, t: 30, d: 30, x: "second" },
      { c: 2, t: 60, d: 30, gap: true },
    ]);
    // A retry that came through fills the gap; a late failure never replaces text.
    chunks = mergeChunk(chunks, { c: 2, t: 60, d: 30, x: "third" });
    chunks = mergeChunk(chunks, { c: 0, t: 0, gap: true });
    expect(transcriptLines(chunks)).toEqual(["[00:00] first", "[00:30] second", "[01:00] third"]);
  });

  it("read back what they wrote, dropping anything malformed", () => {
    const chunks: TranscriptChunk[] = [
      { c: 0, t: 0, x: "a" },
      { c: 1, t: 30, gap: true },
    ];
    expect(parseTranscript(serializeTranscript(chunks))).toEqual(chunks);
    expect(parseTranscript('[{"c":0,"t":-1,"x":"a"},{"c":"1","t":0,"x":"b"},null,{"c":2,"t":5}]')).toEqual([]);
    expect(parseTranscript("not json")).toEqual([]);
  });

  it("find the chunk a moment falls in", () => {
    const chunks: TranscriptChunk[] = [
      { c: 0, t: 0, x: "a" },
      { c: 1, t: 30, x: "b" },
      { c: 2, t: 60, x: "c" },
    ];
    expect(chunkAt(chunks, 45)?.c).toBe(1);
    expect(chunkAt(chunks, 60)?.c).toBe(2);
    expect(chunkAt(chunks, 9999)?.c).toBe(2);
    expect(chunkAt([], 3)).toBeNull();
  });
});

describe("timestamps", () => {
  it("write minutes and seconds, hours from an hour on", () => {
    expect(formatStamp(0)).toBe("00:00");
    expect(formatStamp(754.9)).toBe("12:34");
    expect(formatStamp(3 * 3600 + 5)).toBe("3:00:05");
    expect(parseStamp("12:34")).toBe(754);
    expect(parseStamp("3:00:05")).toBe(10805);
    expect(parseStamp("12:75")).toBeNull();
  });
});

describe("takeaways", () => {
  it("read points, action items with assignees, and the moment they cite", () => {
    expect(parseTakeaway("- The launch moves to May [12:34]")).toEqual({ text: "The launch moves to May", assignee: "", done: false, at: 754 });
    expect(parseTakeaway("- [ ] @Ayşe Yılmaz: Send the quote [01:05:00]")).toEqual({ text: "Send the quote", assignee: "Ayşe Yılmaz", done: false, at: 3900 });
    expect(parseTakeaway("* [x] Book the room")).toEqual({ text: "Book the room", assignee: "", done: true, at: null });
    expect(parseTakeaway("- ")).toBeNull();
    expect(parseTakeaways("- one [00:10]\n\nnot a list line\n- two")).toHaveLength(3);
  });

  it("write back what they read", () => {
    const lines: [string, boolean][] = [
      ["- The launch moves to May [12:34]", false],
      ["- [ ] @Ayşe: Send the quote [05:10]", true],
      ["- [x] Done thing", true],
    ];
    for (const [line, action] of lines) expect(takeawayLine(parseTakeaway(line)!, action)).toBe(line);
  });
});

describe("attendees", () => {
  it("drop duplicates and malformed entries", () => {
    expect(parseAttendees('[{"id":"u1","name":"Ayşe"},{"id":"u1","name":"Ayşe"},{"name":"Guest"},{"id":"u2"},7]')).toEqual([
      { id: "u1", name: "Ayşe" },
      { id: "", name: "Guest" },
    ]);
  });
});

describe("stale recordings", () => {
  it("count only a recording whose recorder went quiet", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    expect(isStale({ status: "recording", lastAt: "2026-10-24T11:58:00Z" }, now)).toBe(false);
    expect(isStale({ status: "recording", lastAt: "2026-10-24T11:50:00Z" }, now)).toBe(true);
    expect(isStale({ status: "done", lastAt: "" }, now)).toBe(false);
  });
});

const props = {
  meetingId: "m1",
  title: "Weekly sync",
  startedAt: "2026-10-24T09:00:00.000Z",
  seconds: 1260,
  attendees: JSON.stringify([
    { id: "u1", name: "Ayşe" },
    { id: "u2", name: "Mehmet" },
  ]),
  status: "done",
  transcript: JSON.stringify([
    { c: 0, t: 0, x: "Let's start. The launch moves to May." },
    { c: 1, t: 30, gap: true },
  ]),
  summary: "- The launch moves to May [00:00]",
  decisions: "- Launch in May [00:00]",
  actions: "- [ ] @Ayşe: Tell the customer <!-- leafdesk:/meeting --> [00:00]",
};

describe("meetings in Markdown", () => {
  it("leaves the transcripts out for what shows a body to visitors", () => {
    const markdown = meetingMarkdown({
      meetingId: "m1",
      title: "Board",
      summary: "- Budget approved [00:10]",
      transcript: JSON.stringify([{ c: 0, t: 0, d: 30, text: "SECRET TRANSCRIPT" }]),
    });
    const body = `Before\n\n${markdown}\n\nAfter **Transcript**`;
    const shown = withoutTranscripts(body);
    expect(shown).not.toContain("SECRET");
    expect(shown).toContain("Budget approved");
    expect(shown).toContain("<!-- leafdesk:/meeting -->");
    expect(shown.endsWith("After **Transcript**")).toBe(true);
    // Cut short before its end, a meeting loses the rest of its transcript too.
    expect(withoutTranscripts(body.slice(0, body.indexOf("SECRET") + 3))).not.toContain("SEC");
  });

  it("write a region with the takeaways and the transcript, which can't be closed from inside", () => {
    const markdown = meetingMarkdown(props);
    expect(markdown.split("\n")[0]).toBe("<!-- leafdesk:meeting m1 -->");
    expect(markdown.split("\n").at(-1)).toBe("<!-- leafdesk:/meeting -->");
    expect(markdown).toContain("2026-10-24 09:00 UTC · 21 min · Attendees: Ayşe, Mehmet");
    expect(markdown).toContain("- [00:00] Let's start. The launch moves to May.");
    expect(markdown).toContain("- [00:30] (not transcribed)");
    expect(markdown).toContain("- [ ] @Ayşe: Tell the customer <\\!-- leafdesk:/meeting --\\> [00:00]");
    expect(markdown.match(/leafdesk:\/meeting -->$/gm)).toHaveLength(1);
    expect(meetingMarkdown({ title: "No id" })).toBe("");
  });

  it("restore the page's block, or the region's plain blocks", () => {
    type B = { id?: string; type: string; props?: Record<string, unknown>; children?: B[] };
    const existing: B[] = [{ id: "b1", type: "meeting", props: { ...props } }];
    const parsed: B[] = [
      { type: "meeting", props: { meetingId: "m1" }, children: [{ type: "paragraph", props: {}, children: [] }] },
      { type: "meeting", props: { meetingId: "m1" }, children: [{ type: "heading", props: {}, children: [] }] },
    ];
    expect(restoreMeetings(parsed, existing)).toEqual([
      { id: "b1", type: "meeting", props: { ...props }, children: [] },
      { type: "heading", props: {}, children: [] },
    ]);
    expect(restoreMeetings(parsed.slice(0, 1), [])).toEqual([{ type: "paragraph", props: {}, children: [] }]);
  });

  it("read as text for search: takeaways and transcript", () => {
    const text = blocksToPlainText([{ type: "meeting", props }]);
    expect(text).toContain("Weekly sync");
    expect(text).toContain("Ayşe: Tell the customer");
    expect(text).toContain("The launch moves to May.");
  });
});

describe("meeting speakers", () => {
  const place = { chunk: 2, offset: 60, duration: 30 };

  it("label a piece by its stream, the microphone's as you and the others' as others", () => {
    expect(chunkPieces({ ...place, stream: "mic" }, "hello")).toEqual([{ c: 2, d: 30, t: 60, s: "you", x: "hello" }]);
    expect(chunkPieces({ ...place, stream: "others" }, "hi")).toEqual([{ c: 2, d: 30, t: 60, r: "o", s: "others", x: "hi" }]);
    // A recording of one stream isn't labelled by guesswork; silence is an empty piece without a speaker.
    expect(chunkPieces(place, "hi")).toEqual([{ c: 2, d: 30, t: 60, x: "hi" }]);
    expect(chunkPieces({ ...place, stream: "mic" }, " ")).toEqual([{ c: 2, d: 30, t: 60, x: "" }]);
  });

  it("split a piece by the provider's speakers, joining neighbours and keeping times inside the piece", () => {
    const segments = [
      { speaker: "A", start: 0, end: 4, text: "Hello." },
      { speaker: "A", start: 4, end: 6, text: "Ready?" },
      { speaker: "B", start: 7, end: 40, text: "Yes." },
    ];
    expect(chunkPieces(place, "Hello. Ready? Yes.", segments)).toEqual([
      { c: 2, d: 6, t: 60, s: "d:A", x: "Hello. Ready?" },
      { c: 2, d: 23, t: 67, s: "d:B", x: "Yes." },
    ]);
    expect(chunkPieces({ ...place, stream: "others" }, "Yes.", [segments[2]])[0]).toMatchObject({ s: "o:B", r: "o" });
    // The microphone's pieces are the recorder's whatever the provider heard.
    expect(chunkPieces({ ...place, stream: "mic" }, "x", segments)).toHaveLength(1);
  });

  it("keep both streams of a chunk, replacing only the stream that came again", () => {
    let chunks: TranscriptChunk[] = [];
    chunks = mergeChunk(chunks, chunkPieces({ chunk: 0, offset: 0, duration: 30, stream: "others" }, "them"));
    chunks = mergeChunk(chunks, chunkPieces({ chunk: 0, offset: 0, duration: 30, stream: "mic" }, "me"));
    chunks = mergeChunk(chunks, { c: 1, t: 30, r: "o", gap: true });
    expect(transcriptLines(chunks, "(gap)", (k) => ({ you: "Ann", others: "Others" })[k as "you"] ?? k)).toEqual(["[00:00] Ann: me", "[00:00] Others: them", "[00:30] (gap)"]);
    // A gap never replaces its own stream's text, a retry fills a gap, and the other stream is left alone.
    chunks = mergeChunk(chunks, { c: 0, t: 0, r: "o", gap: true });
    chunks = mergeChunk(chunks, chunkPieces({ chunk: 1, offset: 30, duration: 30, stream: "others" }, "later"));
    expect(chunks.map((c) => ("x" in c ? c.x : "gap"))).toEqual(["me", "them", "later"]);
  });

  it("read speakers back from the prop, dropping what is malformed", () => {
    const chunks: TranscriptChunk[] = [
      { c: 0, t: 0, s: "o:B", r: "o", x: "a" },
      { c: 1, t: 5, s: "you", x: "b" },
      { c: 2, t: 9, s: "o:C", r: "o", x: "c" },
      { c: 3, t: 12, s: "o:B", r: "o", x: "d" },
    ];
    expect(parseTranscript(serializeTranscript(chunks))).toEqual(chunks);
    expect(parseTranscript('[{"c":0,"t":0,"x":"a","s":"bad key!"}]')).toEqual([{ c: 0, t: 0, x: "a" }]);
    expect(speakerKeys(chunks)).toEqual(["o:B", "you", "o:C"]);
    const names = parseSpeakers(serializeSpeakers({ "o:B": { name: " Ayşe ", id: "u1" } }));
    expect(names).toEqual({ "o:B": { name: "Ayşe", id: "u1" } });
    expect(parseSpeakers('{"x y":{"name":"No"},"ok":{"name":" "},"fine":{"name":"Z"}}')).toEqual({ fine: { name: "Z" } });
    expect(parseSpeakers("nope")).toEqual({});
    const nameOf = speakerNamer(chunks, names, ENGLISH_SPEAKER_LABELS("Erhan"));
    expect(["o:B", "you", "o:C"].map(nameOf)).toEqual(["Ayşe", "Erhan", "Speaker 2"]);
    expect(transcriptLines(chunks, undefined, nameOf)[0]).toBe("[00:00] Ayşe: a");
    // Without a namer a transcript reads as it always did.
    expect(transcriptLines(chunks)[0]).toBe("[00:00] a");
  });

  it("write names into the meeting's Markdown, and keep the speakers out of the published feed", () => {
    const transcript = serializeTranscript([{ c: 0, t: 0, s: "you", x: "We ship in May." }, { c: 1, t: 30, s: "o:A", r: "o", x: "Agreed." }]);
    const md = meetingMarkdown({ meetingId: "m1", title: "Sync", recorderName: "Erhan", transcript, speakers: serializeSpeakers({ "o:A": { name: "Ayşe" } }) });
    expect(md).toContain("- [00:00] Erhan: We ship in May.");
    expect(md).toContain("- [00:30] Ayşe: Agreed.");
    expect(withoutTranscripts(md)).not.toContain("Ayşe: Agreed");
  });

  it("find the member a name in a summary points at, only when one fits", () => {
    const people = [
      { id: "u1", name: "Ayşe Yılmaz" },
      { id: "u2", name: "Mehmet Kaya" },
      { id: "u3", name: "Mehmet Demir" },
    ];
    expect(matchPerson("ayşe yılmaz", people)?.id).toBe("u1");
    expect(matchPerson("Ayşe", people)?.id).toBe("u1");
    expect(matchPerson("Mehmet", people)).toBeNull();
    expect(matchPerson("Mehmet Kaya", people)?.id).toBe("u2");
    expect(matchPerson("Zeynep", people)).toBeNull();
    expect(matchPerson("Ayşe", [{ id: "", name: "Ayşe" }])).toBeNull();
    expect(knownPeople({ attendees: JSON.stringify([{ id: "u1", name: "Ayşe" }, { id: "", name: "Guest" }]), speakers: serializeSpeakers({ a: { name: "Ali", id: "u9" }, b: { name: "Free" } }) })).toEqual([
      { id: "u1", name: "Ayşe" },
      { id: "u9", name: "Ali" },
    ]);
  });
});
