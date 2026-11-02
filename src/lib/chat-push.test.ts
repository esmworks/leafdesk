import { describe, expect, it } from "vitest";
import { chatAnsweredPayload } from "./chat-push";

const t = (key: string, values?: Record<string, string | number>) => (values ? `${key}(${JSON.stringify(values)})` : key);

describe("chatAnsweredPayload", () => {
  it("opens the conversation and says nothing of what was asked or answered", () => {
    expect(chatAnsweredPayload({ workspaceId: "w1", conversationId: "c 1" }, t)).toEqual({
      title: "chatAnsweredTitle",
      body: "chatAnswered",
      url: "/w/w1/ai?c=c%201",
      tag: "chat:c 1",
      read: "",
      snooze: "",
    });
  });
});
