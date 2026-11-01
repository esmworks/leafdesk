import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@/lib/ai-chat";
import { liveTextAfter } from "@/lib/agent-chat";
import { answeringIn, stopRunsIn } from "@/server/ai-chat-runs";
import { ANSWER_CHARS, followLiveText, shownText, startLiveText, stopLiveText } from "./live-text";

let n = 0;
const runId = () => `live-test-${Date.now()}-${n++}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Follows a run as `userId`, keeping its events and the text they make; `stop` ends the follow. */
function follower(id: string, userId = "person") {
  const controller = new AbortController();
  const state = { text: "", events: [] as ChatEvent[], done: false };
  const finished = (async () => {
    for await (const event of followLiveText(userId, id, controller.signal)) {
      state.events.push(event);
      state.text = liveTextAfter(state.text, event);
    }
    state.done = true;
  })();
  return {
    state,
    finished,
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

describe("startLiveText", () => {
  it("publishes the text as the AI chat's answer events, starting over with a reset", async () => {
    const id = runId();
    const live = startLiveText(id, "person", "ws")!;
    const f = follower(id);
    live.write("Looking at ");
    await tick();
    live.write("Looking at the page ");
    await tick();
    expect(f.state.text).toBe("Looking at the page ");
    live.clear();
    live.write("The answer is", true);
    await tick();
    expect(f.state.text).toBe("The answer is");
    expect(f.state.events).toEqual([
      { type: "text", text: "Looking at " },
      { type: "text", text: "the page " },
      { type: "reset" },
      { type: "text", text: "The answer is" },
    ]);
    live.end();
    await f.finished;
    expect(f.state.done).toBe(true);
  });

  it("sends the text again whole when what is shown no longer begins with what was sent", async () => {
    const id = runId();
    const live = startLiveText(id, "person", "ws")!;
    const f = follower(id);
    live.write("First try ");
    live.write("Second ");
    await tick();
    expect(f.state.events.slice(-2)).toEqual([{ type: "reset" }, { type: "text", text: "Second " }]);
    expect(f.state.text).toBe("Second ");
    live.end();
    await f.stop();
  });

  it("is followed only by the person chatting, and not before it answers", async () => {
    const id = runId();
    const early = follower(id);
    await early.finished;
    expect(early.state.events).toEqual([]);
    const live = startLiveText(id, "person", "ws")!;
    live.write("Mine ");
    const other = follower(id, "someone-else");
    await other.finished;
    expect(other.state.events).toEqual([]);
    live.end();
  });

  it("gives a follower arriving after the end the turn's text all at once", async () => {
    const id = runId();
    const live = startLiveText(id, "person", "ws")!;
    live.write("Thinking it over ");
    live.clear();
    live.write("All of it", true);
    live.end();
    // Writes after the end change nothing.
    live.write("More", true);
    const f = follower(id);
    await f.finished;
    expect(f.state.events).toEqual([{ type: "text", text: "All of it" }]);
  });

  it("is under way once at a time, and may go on again after it ended (an approval)", () => {
    const id = runId();
    const live = startLiveText(id, "person", "ws")!;
    expect(startLiveText(id, "person", "ws")).toBeNull();
    live.end();
    const again = startLiveText(id, "person", "ws");
    expect(again).not.toBeNull();
    again!.end();
  });
});

describe("stopLiveText", () => {
  it("stops the person's answer under way, never another's", () => {
    const id = runId();
    const live = startLiveText(id, "person", "ws")!;
    expect(stopLiveText("someone-else", id, false)).toBe(false);
    expect(live.signal.aborted).toBe(false);
    expect(stopLiveText("person", id, false)).toBe(true);
    expect(live.signal.aborted).toBe(true);
    live.end();
    expect(stopLiveText("person", id, true)).toBe(false);
  });

  it("stops a run taken but not answering yet as it starts, and only such a one", () => {
    const waiting = runId();
    expect(stopLiveText("person", waiting, false)).toBe(false);
    const notStopped = startLiveText(waiting, "person", "ws")!;
    expect(notStopped.signal.aborted).toBe(false);
    notStopped.end();
    const taken = runId();
    expect(stopLiveText("person", taken, true)).toBe(true);
    const live = startLiveText(taken, "person", "ws")!;
    expect(live.signal.aborted).toBe(true);
    live.end();
  });
});

describe("the answers' store", () => {
  it("leaves an agent's run out of the AI chat's own conversations", () => {
    const id = runId();
    const live = startLiveText(id, "person", "ws-agents")!;
    expect(answeringIn("person", "ws-agents").size).toBe(0);
    stopRunsIn("person", "ws-agents", "all");
    expect(live.signal.aborted).toBe(false);
    live.end();
  });
});
