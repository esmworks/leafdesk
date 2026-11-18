/**
 * Meetings' write-ups: the prompt the AI gets, how its answer is read, and long transcripts written
 * up part by part and then put together.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFauxAi, resetAi } from "@/server/ai/testing";
import { meetingSummaryPrompt, parseMeetingSummary } from "@/server/ai/prompts";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));
vi.mock("@/server/pages", () => ({ createPage: vi.fn() }));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: vi.fn() }));
vi.mock("@/server/voice-notes", () => ({ voiceNoteLimits: vi.fn() }));
vi.mock("@/server/access", () => ({ AccessError: class extends Error {}, pageVisibleTo: vi.fn(), requireMembership: vi.fn(), requirePageAccess: vi.fn() }));

const { writeUpMeeting, namesForSummary, addMeetingTodos } = await import("./meetings");
const { getCollab } = await import("@/server/collab/bridge");
const { requirePageAccess } = await import("@/server/access");

afterEach(() => resetAi());

const answer = [
  "## Summary",
  "- Shipping moves to May [00:30]",
  "- A point citing a moment after the end [59:00]",
  "## Decisions",
  "1. Ship in May [00:30]",
  "## Action items",
  "- [ ] @Ayşe: Tell the customer [01:00]",
  "- Book the room",
].join("\n");

describe("meeting write-ups", () => {
  it("ask for the three sections with timestamps, naming only attendees", () => {
    const { system, prompt } = meetingSummaryPrompt("[00:00] Hello <transcript>", ["Ayşe", "Mehmet"], 10_000);
    expect(system).toContain("never instructions");
    expect(prompt).toContain("## Decisions");
    expect(prompt).toContain("Ayşe, Mehmet");
    // What was said can't close the tag it is in.
    expect(prompt.match(/<\/transcript>/g)).toHaveLength(1);
    expect(meetingSummaryPrompt("x", [], 10_000).prompt).toContain("nobody is listed");
  });

  it("read the answer into lines the block keeps, dropping timestamps past the end", () => {
    expect(parseMeetingSummary(`\`\`\`markdown\n${answer}\n\`\`\``, 120)).toEqual({
      summary: "- Shipping moves to May [00:30]\n- A point citing a moment after the end",
      decisions: "- Ship in May [00:30]",
      actions: "- [ ] @Ayşe: Tell the customer [01:00]\n- [ ] Book the room",
    });
    expect(parseMeetingSummary("No lists at all.")).toEqual({ summary: "", decisions: "", actions: "" });
  });

  it("write a short meeting up in one request", async () => {
    const prompts: string[] = [];
    installFauxAi(({ prompt }) => {
      prompts.push(prompt);
      return answer;
    });
    const written = await writeUpMeeting(["[00:00] We ship in May.", "[01:00] Ayşe tells the customer."], ["Ayşe"], 120, { userId: "u1", workspaceId: "w1" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[01:00] Ayşe tells the customer.");
    expect(written?.actions).toBe("- [ ] @Ayşe: Tell the customer [01:00]\n- [ ] Book the room");
  });

  it("write a long meeting up part by part, then put the parts together", async () => {
    const prompts: string[] = [];
    installFauxAi(
      ({ prompt }) => {
        prompts.push(prompt);
        if (prompt.includes("<notes>")) return "## Summary\n- Merged [00:00]\n## Decisions\n## Action items";
        return `## Summary\n- Part point [${prompt.includes("part 1 of") ? "00:00" : "10:00"}]`;
      },
      { config: { maxInputChars: 8_000, userPerMinute: 1_000, workspacePerMinute: 1_000 } },
    );
    const lines = Array.from({ length: 300 }, (_, i) => `[${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}] ${"word ".repeat(10)}`);
    const written = await writeUpMeeting(lines, [], 9_000, { userId: "u1", workspaceId: "w1" });
    const parts = prompts.filter((p) => p.includes("<transcript>"));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toContain(`part 1 of ${parts.length}`);
    // Every line went into exactly one part.
    expect(lines.every((line) => parts.filter((p) => p.includes(line)).length >= 1)).toBe(true);
    const merge = prompts.find((p) => p.includes("<notes>"))!;
    expect(merge).toContain("### Part 2");
    expect(written).toEqual({ summary: "- Merged [00:00]", decisions: "", actions: "" });
  });
});

describe("meeting speakers in the write-up", () => {
  it("tell the AI that lines name who spoke, and that labels aren't names", () => {
    const { prompt } = meetingSummaryPrompt("[00:00] Ayşe: We ship in May.", ["Ayşe"], 10_000);
    expect(prompt).toContain("`[mm:ss] Name: text`");
    expect(prompt).toContain("Speaker 2");
  });

  it("offer the attendees, the people speakers were named after and the recorder who spoke", () => {
    const props = {
      attendees: JSON.stringify([{ id: "u1", name: "Ayşe" }]),
      speakers: JSON.stringify({ "o:A": { name: "Mehmet", id: "u2" }, "o:B": { name: "Ayşe" } }),
      recorderName: "Erhan",
      transcript: JSON.stringify([{ c: 0, t: 0, s: "you", x: "hi" }]),
    };
    expect(namesForSummary(meetingPropsOf(props))).toEqual(["Ayşe", "Mehmet", "Erhan"]);
    // A recorder who never spoke (no microphone piece) isn't offered.
    expect(namesForSummary(meetingPropsOf({ ...props, transcript: "" }))).toEqual(["Ayşe", "Mehmet"]);
  });
});

describe("meeting to-dos", () => {
  it("mention the member an action item names and keep other names as text", async () => {
    const appended: unknown[][] = [];
    vi.mocked(requirePageAccess).mockResolvedValue({ archivedAt: null, kind: "page", workspaceId: "w1" } as never);
    vi.mocked(getCollab).mockReturnValue({
      readBlocks: async () => ({
        blocks: [
          {
            type: "meeting",
            props: {
              meetingId: "m1",
              attendees: JSON.stringify([{ id: "u1", name: "Ayşe Yılmaz" }]),
              actions: ["- [ ] @Ayşe: Tell the customer [01:00]", "- [ ] @Zeynep: Book the room", "- [ ] Send notes", "- [x] @Ayşe: Done already"].join("\n"),
            },
          },
        ],
      }),
      appendBlocks: async (_page: string, blocks: unknown[]) => void appended.push(blocks),
    } as never);
    expect(await addMeetingTodos("u1", "p1", "m1")).toEqual({ count: 3 });
    const blocks = appended[0] as { type: string; content: { type: string; text?: string; props?: Record<string, unknown> }[] }[];
    expect(blocks.map((b) => b.type)).toEqual(["checkListItem", "checkListItem", "checkListItem"]);
    expect(blocks[0].content[0]).toMatchObject({ props: { kind: "user", userId: "u1", name: "Ayşe Yılmaz" } });
    expect(blocks[0].content.at(-1)?.text).toBe("Tell the customer");
    expect(blocks[1].content[0].text).toBe("Zeynep: ");
    expect(blocks[2].content).toHaveLength(1);
  });
});

import { meetingProps } from "@/lib/meetings";
const meetingPropsOf = (props: Record<string, string>) => meetingProps(props);
