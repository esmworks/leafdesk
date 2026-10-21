import { describe, expect, it } from "vitest";
import { agentChatLine, agentLinkRef, agentPath, chatFailure, mapAgentChatLines, parseAgentChatLine } from "./agent-chat";

describe("the agent chat's Markdown line", () => {
  it("names the agent and the block's conversations, and reads back", () => {
    const line = agentChatLine("agent-1", "chat-1");
    expect(line).toBe("<!-- leafdesk:agent-chat agent-1 chat-1 -->");
    expect(parseAgentChatLine(line)).toEqual({ agentId: "agent-1", chatId: "chat-1" });
    expect(parseAgentChatLine("<!-- leafdesk:agent-chat agent-1 -->")).toEqual({ agentId: "agent-1", chatId: "" });
    expect(parseAgentChatLine("Text <!-- leafdesk:agent-chat agent-1 -->")).toBeNull();
    expect(parseAgentChatLine("<!-- leafdesk:database agent-1 -->")).toBeNull();
  });

  it("is replaced outside code fences only", () => {
    const markdown = ["Intro", agentChatLine("a1", "c1"), "```", agentChatLine("a2", "c2"), "```", agentChatLine("a3", "")].join("\n");
    expect(mapAgentChatLines(markdown, ({ agentId }) => `*${agentId}*`)).toBe(["Intro", "*a1*", "```", agentChatLine("a2", "c2"), "```", "*a3*"].join("\n"));
  });
});

describe("a pasted agent link", () => {
  const origin = "https://leafdesk.example";

  it("names a workspace's agent when it is this app's", () => {
    expect(agentLinkRef(`${origin}${agentPath("ws1", "a1")}`, origin)).toEqual({ workspaceId: "ws1", agentId: "a1" });
    expect(agentLinkRef(` ${origin}/w/ws1/settings?agent=a1&tab=agents&run=r1 `, origin)).toEqual({ workspaceId: "ws1", agentId: "a1" });
  });

  it("is nothing on another origin, another tab or another page", () => {
    expect(agentLinkRef(`https://elsewhere.example${agentPath("ws1", "a1")}`, origin)).toBeNull();
    expect(agentLinkRef(`${origin}/w/ws1/settings?tab=members&agent=a1`, origin)).toBeNull();
    expect(agentLinkRef(`${origin}/w/ws1/p/page?tab=agents&agent=a1`, origin)).toBeNull();
    expect(agentLinkRef("just some words", origin)).toBeNull();
  });
});

describe("a chat's failed turn", () => {
  it("says why when the chat knows the reason, else that it failed", () => {
    expect(chatFailure("limitReached")).toBe("limitReached");
    expect(chatFailure("approvalTimeout")).toBe("approvalTimeout");
    expect(chatFailure(null)).toBe("error");
  });
});
