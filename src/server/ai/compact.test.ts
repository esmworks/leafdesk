import { describe, expect, it } from "vitest";
import { dropOldToolResults, KEEP_RECENT_TOOL_RESULTS, READ_ROOM, roomToRead } from "./compact";
import type { AiMessage } from "./index";

const result = (n: number, content = "r".repeat(1_000), isError = false): AiMessage => ({ role: "tool", toolCallId: `c${n}`, name: `tool${n}`, content, isError });

describe("making room in a conversation", () => {
  it("drops all but the newest tool results, saying which tool's", () => {
    const messages: AiMessage[] = [{ role: "user", content: "q" }, ...Array.from({ length: 8 }, (_, i) => result(i))];
    const saved = dropOldToolResults(messages);
    const kept = messages.filter((m) => m.role === "tool" && m.content.length === 1_000);
    expect(kept).toHaveLength(KEEP_RECENT_TOOL_RESULTS);
    expect(messages[1].content).toContain("tool0");
    expect(messages[1].content).toContain("dropped");
    expect(saved).toBeGreaterThan(2_500);
    // Nothing more to drop the second time.
    expect(dropOldToolResults(messages)).toBe(0);
  });

  it("keeps failed calls and short results", () => {
    const messages: AiMessage[] = [result(0, "e".repeat(1_000), true), result(1, "short"), ...Array.from({ length: KEEP_RECENT_TOOL_RESULTS }, (_, i) => result(i + 2))];
    expect(dropOldToolResults(messages)).toBe(0);
    expect(messages[0].content).toBe("e".repeat(1_000));
    expect(messages[1].content).toBe("short");
  });

  it("makes room to read on by dropping all but the newest result when little is left", () => {
    const messages: AiMessage[] = [{ role: "user", content: "q" }, ...Array.from({ length: 3 }, (_, i) => result(i, "r".repeat(20_000)))];
    const left = () => 65_000 - messages.reduce((n, m) => n + m.content.length, 0);
    expect(roomToRead(messages, left)).toBeGreaterThan(READ_ROOM);
    expect(messages.filter((m) => m.content.length === 20_000)).toHaveLength(1);
    expect(messages.at(-1)?.content).toBe("r".repeat(20_000));
    // With room enough, nothing goes.
    const roomy: AiMessage[] = [result(0, "r".repeat(20_000)), result(1, "r".repeat(20_000))];
    expect(roomToRead(roomy, () => 100_000)).toBe(100_000);
    expect(roomy.every((m) => m.content.length === 20_000)).toBe(true);
  });
});
