import { describe, expect, it } from "vitest";
import { blocksToPlainText } from "./blocks";
import {
  chunkAt,
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
