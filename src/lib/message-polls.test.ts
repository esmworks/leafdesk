import { describe, expect, it } from "vitest";
import { pollClosed, pollInputError, pollShare, readPollInput, withVote, type PollCounts } from "./message-polls";

const NOW = Date.parse("2026-11-09T12:00:00Z");

describe("pollInputError", () => {
  it("wants a question and two different options", () => {
    expect(pollInputError({ question: " ", options: ["a", "b"] }, NOW)).toBe("question");
    expect(pollInputError({ question: "Lunch?", options: ["Pizza", " "] }, NOW)).toBe("tooFewOptions");
    expect(pollInputError({ question: "Lunch?", options: ["Pizza", "pizza "] }, NOW)).toBe("duplicateOptions");
    expect(pollInputError({ question: "Lunch?", options: ["Pizza", "Soup"] }, NOW)).toBeNull();
  });

  it("holds questions, options and closing times to their limits", () => {
    expect(pollInputError({ question: "x".repeat(301), options: ["a", "b"] }, NOW)).toBe("questionTooLong");
    expect(pollInputError({ question: "q", options: ["a", "x".repeat(101)] }, NOW)).toBe("optionTooLong");
    expect(pollInputError({ question: "q", options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, NOW)).toBe("tooManyOptions");
    expect(pollInputError({ question: "q", options: ["a", "b"], closesAt: new Date(NOW - 1000) }, NOW)).toBe("closesAt");
    expect(pollInputError({ question: "q", options: ["a", "b"], closesAt: new Date(NOW + 400 * 86_400_000) }, NOW)).toBe("closesAt");
    expect(pollInputError({ question: "q", options: ["a", "b"], closesAt: new Date(NOW + 86_400_000) }, NOW)).toBeNull();
  });
});

describe("readPollInput", () => {
  it("drops empty options, gives ids and keeps the switches", () => {
    let n = 0;
    const read = readPollInput({ question: "  Where   to? ", options: ["Here", "", "There "], multiple: true, closesAt: new Date(NOW + 3600_000).toISOString() }, NOW, () => `id${n++}`);
    expect(read).toEqual({
      question: "Where to?",
      options: [
        { id: "id0", text: "Here" },
        { id: "id1", text: "There" },
      ],
      multiple: true,
      anonymous: false,
      closesAt: new Date(NOW + 3600_000),
    });
  });

  it("refuses what isn't a poll", () => {
    expect(readPollInput(null, NOW)).toBe("question");
    expect(readPollInput({ question: "q", options: "a,b" }, NOW)).toBe("question");
    expect(readPollInput({ question: "q", options: ["a", 2] }, NOW)).toBe("tooFewOptions");
    expect(readPollInput({ question: "q", options: ["a", "b"], anonymous: "yes" }, NOW)).toBe("question");
    expect(readPollInput({ question: "q", options: ["a", "b"], closesAt: 5 }, NOW)).toBe("closesAt");
    expect(readPollInput({ question: "q", options: ["a", "b"], closesAt: "soon" }, NOW)).toBe("closesAt");
  });
});

describe("pollClosed", () => {
  it("is closed when someone closed it or its time passed", () => {
    expect(pollClosed({ closesAt: null, closedAt: null }, NOW)).toBe(false);
    expect(pollClosed({ closesAt: null, closedAt: new Date(NOW).toISOString() }, NOW)).toBe(true);
    expect(pollClosed({ closesAt: new Date(NOW + 1).toISOString(), closedAt: null }, NOW)).toBe(false);
    expect(pollClosed({ closesAt: new Date(NOW).toISOString(), closedAt: null }, NOW)).toBe(true);
  });
});

describe("withVote", () => {
  const poll = (multiple: boolean, anonymous = false): PollCounts => ({
    options: [
      { id: "a", text: "A", count: 1, voters: anonymous ? null : ["ann"] },
      { id: "b", text: "B", count: 0, voters: anonymous ? null : [] },
    ],
    multiple,
    anonymous,
    voters: 1,
    mine: [],
  });

  it("moves a single choice and takes it back", () => {
    const first = withVote(poll(false), "me", "a", true);
    expect(first.mine).toEqual(["a"]);
    expect(first.options[0]).toMatchObject({ count: 2, voters: ["ann", "me"] });
    expect(first.voters).toBe(2);
    const moved = withVote(first, "me", "b", true);
    expect(moved.mine).toEqual(["b"]);
    expect(moved.options.map((o) => o.count)).toEqual([1, 1]);
    expect(moved.voters).toBe(2);
    const back = withVote(moved, "me", "b", false);
    expect(back.mine).toEqual([]);
    expect(back.voters).toBe(1);
  });

  it("adds choices when several are allowed, and counts the person once", () => {
    const two = withVote(withVote(poll(true), "me", "a", true), "me", "b", true);
    expect(two.mine).toEqual(["a", "b"]);
    expect(two.options.map((o) => o.count)).toEqual([2, 1]);
    expect(two.voters).toBe(2);
  });

  it("keeps an anonymous poll's voters unknown", () => {
    const voted = withVote(poll(false, true), "me", "a", true);
    expect(voted.options[0].voters).toBeNull();
    expect(voted.options[0].count).toBe(2);
  });

  it("leaves the poll alone for an option it doesn't have", () => {
    const p = poll(false);
    expect(withVote(p, "me", "zzz", true)).toBe(p);
  });
});

describe("pollShare", () => {
  it("is a whole percent of those who voted", () => {
    expect(pollShare(1, 3)).toBe(33);
    expect(pollShare(0, 0)).toBe(0);
  });
});
