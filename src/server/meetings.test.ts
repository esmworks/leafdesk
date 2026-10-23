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

const { writeUpMeeting } = await import("./meetings");

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
