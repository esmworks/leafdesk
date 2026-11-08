import { describe, expect, it } from "vitest";
import type { AssistantRunSource } from "./agents";
import { conversationRuleFor } from "./triggers";

const assistant: AssistantRunSource = { kind: "assistant", userId: "u1", conversationId: "c1", scope: null, skillId: null, model: null, thinking: "balanced", mode: "read", timeZone: "UTC", files: [], replaced: 0 };

describe("conversationRuleFor", () => {
  it("keeps a row's runs, a schedule's, a comment thread's and an email thread's in one conversation each", () => {
    expect(conversationRuleFor({ kind: "automation", automationId: "a", automationRunId: "ar", databaseId: "d", rowId: "r1" })).toEqual({ rule: "keyed", key: "row:r1" });
    expect(conversationRuleFor({ kind: "request", requestedBy: "u1", via: "api", rowId: "r1", databaseId: "d" })).toEqual({ rule: "keyed", key: "row:r1" });
    expect(conversationRuleFor({ kind: "schedule", scheduleId: "s1", scheduledBy: "u1" })).toEqual({ rule: "keyed", key: "schedule:s1" });
    expect(conversationRuleFor({ kind: "mention", pageId: "p", threadId: "t1", commentId: "c", mentionedBy: "u1" })).toEqual({ rule: "keyed", key: "thread:t1" });
    expect(conversationRuleFor({ kind: "mail", mailboxId: "m", userId: "u1", threadId: "th1", messageId: "msg" })).toEqual({ rule: "keyed", key: "mail:th1" });
    expect(conversationRuleFor({ kind: "channel", channelId: "ch", threadId: "root1", messageId: "msg", mentionedBy: "u1" })).toEqual({ rule: "keyed", key: "thread:root1" });
  });

  it("starts a fresh conversation for an event, a request on no row and another agent's task", () => {
    expect(conversationRuleFor({ kind: "connection", connectionId: "c", triggerId: "t", eventId: "e" })).toEqual({ rule: "new" });
    expect(conversationRuleFor({ kind: "request", requestedBy: "u1", via: "mcp" })).toEqual({ rule: "new" });
    const parent = { kind: "request" as const, requestedBy: "u1", via: "api" as const };
    expect(conversationRuleFor({ kind: "handoff", parentRunId: "r", fromAgentId: "a", callId: "c", boundTo: "u1", trusted: true, parent })).toEqual({ rule: "new" });
  });

  it("answers a chat in its own conversation, and a person's scheduled question in the schedule's", () => {
    expect(conversationRuleFor({ kind: "chat", userId: "u1", conversationId: "c9" })).toEqual({ rule: "fixed", conversationId: "c9" });
    expect(conversationRuleFor(assistant)).toEqual({ rule: "fixed", conversationId: "c1" });
    expect(conversationRuleFor({ ...assistant, scheduleId: "s2" })).toEqual({ rule: "keyed", key: "schedule:s2" });
  });
});
