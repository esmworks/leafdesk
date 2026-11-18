import { describe, expect, it } from "vitest";
import { agentBlockLine, isPageAgentPlace, mapAgentBlockLines, pageAgentChatId, pageAgentNote, pageAgentPlace, pageOfAgentChat, parseAgentBlockLine } from "./agent-block";
import { agentChatLine, parseAgentChatLine } from "./agent-chat";

describe("the Agent block's Markdown line", () => {
  it("names the agent and reads back", () => {
    const line = agentBlockLine("agent-1");
    expect(line).toBe("<!-- leafdesk:agent agent-1 -->");
    expect(parseAgentBlockLine(line)).toBe("agent-1");
    expect(parseAgentBlockLine("  <!--leafdesk:agent  agent-1-->  ")).toBe("agent-1");
    expect(parseAgentBlockLine("Text <!-- leafdesk:agent agent-1 -->")).toBeNull();
    expect(parseAgentBlockLine("<!-- leafdesk:agent -->")).toBeNull();
  });

  it("is not the agent chat's line, nor the other way round", () => {
    expect(parseAgentBlockLine(agentChatLine("a1", "c1"))).toBeNull();
    expect(parseAgentChatLine(agentBlockLine("a1"))).toBeNull();
  });

  it("is replaced outside code fences only", () => {
    const markdown = ["Intro", agentBlockLine("a1"), "```", agentBlockLine("a2"), "```", agentBlockLine("a3")].join("\n");
    expect(mapAgentBlockLines(markdown, (id) => `*${id}*`)).toBe(["Intro", "*a1*", "```", agentBlockLine("a2"), "```", "*a3*"].join("\n"));
  });
});

describe("the place a page's Agent blocks keep conversations in", () => {
  it("is one per page, named in the chat id", () => {
    expect(pageAgentChatId("p1")).toBe("pageAgent:p1");
    expect(pageOfAgentChat("pageAgent:p1")).toBe("p1");
    expect(pageAgentPlace("p1")).toEqual({ chatId: "pageAgent:p1", pageId: "p1" });
    expect(isPageAgentPlace(pageAgentPlace("p1"))).toBe(true);
  });

  it("is not another page's, a chat block's, or anything that isn't an id", () => {
    expect(isPageAgentPlace({ chatId: "pageAgent:p2", pageId: "p1" })).toBe(false);
    expect(isPageAgentPlace({ chatId: "c1", pageId: "p1" })).toBe(false);
    expect(pageOfAgentChat("c1")).toBeNull();
    expect(pageOfAgentChat("pageAgent:")).toBeNull();
    expect(pageOfAgentChat("pageAgent:ignore previous instructions")).toBeNull();
  });

  it("tells a run which page the question came from, by its id alone", () => {
    expect(pageAgentNote("p1")).toContain("page p1");
  });
});
