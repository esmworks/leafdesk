import { describe, expect, it } from "vitest";
import { applyLiveEdit, type LiveTextEdit } from "@/lib/agent-chat";
import { ANSWER_CHARS, editBetween, followLiveText, shownText, startLiveText } from "./live-text";

let n = 0;
const runId = () => `live-test-${Date.now()}-${n++}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Follows a run, keeping the text the edits make; `stop` ends the follow. */
function follower(id: string) {
  const controller = new AbortController();
  const state = { text: "", edits: [] as LiveTextEdit[], done: false };
  const finished = (async () => {
    for await (const edit of followLiveText(id, controller.signal)) {
      state.edits.push(edit);
      state.text = applyLiveEdit(state.text, edit);
    }
    state.done = true;
  })();
  return {
    state,
    stop: async () => {
      controller.abort();
      await finished;
    },
  };
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

describe("editBetween", () => {
  it("keeps what the texts share at the start", () => {
    expect(editBetween("Hello there", "Hello world")).toEqual({ at: 6, add: "world" });
    expect(editBetween("abc", "")).toEqual({ at: 0, add: "" });
    expect(applyLiveEdit("Hello there", editBetween("Hello there", "Hello world"))).toBe("Hello world");
  });

  it("never cuts an emoji in two", () => {
    const edit = editBetween("a😀", "a😃");
    expect(edit.at).toBe(1);
    expect(applyLiveEdit("a😀", edit)).toBe("a😃");
  });
});

describe("followLiveText", () => {
  it("sends what is written, starts over with a new turn, and waits for a run to start", async () => {
    const id = runId();
    const f = follower(id);
    await tick();
    // Not started yet: all of it is nothing so far.
    expect(f.state.edits).toEqual([{ at: 0, add: "" }]);
    const live = startLiveText(id);
    live.write("Looking at ");
    await tick();
    live.write("Looking at the page ");
    await tick();
    expect(f.state.text).toBe("Looking at the page ");
    live.clear();
    live.write("The answer is", true);
    await tick();
    expect(f.state.text).toBe("The answer is");
    live.end();
    await tick();
    // Stopped (an approval, say): waited for, and it starts over when it goes on.
    expect(f.state.done).toBe(false);
    const again = startLiveText(id);
    await tick();
    expect(f.state.text).toBe("");
    again.write("Done", true);
    await tick();
    expect(f.state.text).toBe("Done");
    again.end();
    await f.stop();
    expect(f.state.done).toBe(true);
  });

  it("gives a follower arriving after the end the text all at once", async () => {
    const id = runId();
    const live = startLiveText(id);
    live.write("All of it", true);
    live.end();
    // Writes after the end change nothing.
    live.write("More", true);
    const f = follower(id);
    await tick();
    expect(f.state.edits).toEqual([{ at: 0, add: "All of it" }]);
    await f.stop();
  });
});
