import { describe, expect, it } from "vitest";
import { ANSWER_CHARS, answerEvents, shownText, type AnswerEvent } from "./answer-text";

/** What a follower of the events shows, and the events it got. */
function follower() {
  const state = { text: "", events: [] as AnswerEvent[] };
  const writer = answerEvents((event) => {
    state.events.push(event);
    state.text = event.type === "reset" ? "" : state.text + event.text;
  });
  return { state, writer };
}

describe("shownText", () => {
  it("holds back the last word while the turn is written", () => {
    expect(shownText("Hello wor", false)).toBe("Hello ");
    expect(shownText("Hello world ", false)).toBe("Hello world ");
    expect(shownText("Hello wor", true)).toBe("Hello wor");
  });

  it("masks credentials, and shows a token only once it is whole", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(shownText(`Use ${token.slice(0, 20)}`, false)).toBe("Use ");
    expect(shownText(`Use ${token} now`, false)).not.toContain(token);
    expect(shownText(`Use ${token}`, true)).not.toContain(token);
  });

  it("keeps as much as a run keeps", () => {
    expect(shownText("a ".repeat(ANSWER_CHARS), false)).toHaveLength(ANSWER_CHARS);
  });
});

describe("answerEvents", () => {
  it("sends what is added, word by word, and the last word once the turn is whole", () => {
    const { state, writer } = follower();
    writer.write("Orders sh");
    writer.write("Orders ship on Tue");
    writer.write("Orders ship on Tuesdays");
    writer.write("Orders ship on Tuesdays", true);
    expect(state.events).toEqual([
      { type: "text", text: "Orders " },
      { type: "text", text: "ship on " },
      { type: "text", text: "Tuesdays" },
    ]);
    expect(state.text).toBe("Orders ship on Tuesdays");
  });

  it("starts over with a new turn, telling the follower only when something was shown", () => {
    const { state, writer } = follower();
    writer.clear();
    expect(state.events).toEqual([]);
    writer.write("Let me look ");
    writer.clear();
    writer.write("Found it ");
    expect(state.text).toBe("Found it ");
    expect(state.events.filter((e) => e.type === "reset")).toHaveLength(1);
  });

  it("takes back what masking changes, and never shows a credential", () => {
    const { state, writer } = follower();
    const key = `sk-ant-api03-${"b".repeat(40)}`;
    writer.write("Use ");
    writer.write(`Use ${key} `);
    writer.write(`Use ${key} and more`, true);
    expect(state.events.some((e) => e.type === "text" && e.text.includes(key))).toBe(false);
    expect(state.text).toBe(shownText(`Use ${key} and more`, true));
    // A value shown word by word, masked once its JSON pair closes: the follower starts over.
    const json = follower();
    json.writer.write('Send {"password": "hunter2 ');
    json.writer.write('Send {"password": "hunter2 now"} ok', true);
    expect(json.state.events.map((e) => e.type)).toEqual(["text", "reset", "text"]);
    expect(json.state.text).not.toContain("hunter2");
    expect(json.state.text).toBe(shownText('Send {"password": "hunter2 now"} ok', true));
  });
});
