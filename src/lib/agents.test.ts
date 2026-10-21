import { describe, expect, it } from "vitest";
import {
  AGENT_EMAIL_DOMAIN,
  agentEmail,
  agentRunPath,
  callToSend,
  INBOX_CALL_CHARS,
  inboxCallInput,
  isAgentEmail,
  isScheduleRun,
  MAX_AGENT_WRITES,
  MAX_SCHEDULED_WRITES,
  ownerSeesRun,
  runPageOf,
  skillStepsToAdd,
  type AgentRunSource,
  type AgentSkillRecord,
} from "./agents";
import { redactValue } from "./redact";

describe("agents' addresses", () => {
  it("are in a domain that can't receive mail", () => {
    expect(agentEmail("abc")).toBe(`agent-abc@${AGENT_EMAIL_DOMAIN}`);
    expect(AGENT_EMAIL_DOMAIN.endsWith(".invalid")).toBe(true);
  });

  it("are told apart from people's, whatever the case or spacing", () => {
    expect(isAgentEmail(agentEmail("abc"))).toBe(true);
    expect(isAgentEmail(" Agent-X@Agents.Leafdesk.Invalid ")).toBe(true);
    expect(isAgentEmail("agent@leafdesk.invalid")).toBe(false);
    expect(isAgentEmail("someone@agents.leafdesk.invalid.example.com")).toBe(false);
    expect(isAgentEmail(null)).toBe(false);
    expect(isAgentEmail(undefined)).toBe(false);
  });
});

describe("a waiting call, as approvers see it", () => {
  const queue = [
    { id: "call-1", name: "crm__search", arguments: { query: "first" } },
    { id: "call-2", name: "crm__fetch", arguments: { url: "https://example.test/?sig=abc" } },
  ];

  it("is the call the run will send, from its saved queue", () => {
    expect(callToSend({ callId: "call-2" }, queue)).toEqual({ url: "https://example.test/?sig=abc" });
    expect(callToSend({ callId: "gone" }, queue)).toBeNull();
    expect(callToSend({ callId: "call-1" }, null)).toBeNull();
  });

  it("may be approved in the inbox when what it shows is all of what would be sent", () => {
    const args = { title: "A lead", tags: ["new"] };
    expect(inboxCallInput(redactValue(args), args)).toEqual({ input: JSON.stringify(args, null, 2), whole: true });
  });

  it("isn't, when a value is masked there: the masked text could hide what is sent", () => {
    const args = { url: "https://example.test/hook?api_key=secret-data-here", note: "ok" };
    const shown = redactValue(args);
    const { input, whole } = inboxCallInput(shown, args);
    expect(input).toContain("[redacted]");
    expect(input).not.toContain("secret-data-here");
    expect(whole).toBe(false);
  });

  it("isn't, when it is cut short", () => {
    const args = { body: `${"x".repeat(INBOX_CALL_CHARS)} hidden tail` };
    const { input, whole } = inboxCallInput(args, args);
    expect(input).toHaveLength(INBOX_CALL_CHARS);
    expect(input).not.toContain("hidden tail");
    expect(whole).toBe(false);
  });

  it("isn't, when the run no longer holds the call", () => {
    expect(inboxCallInput({ a: 1 }, null).whole).toBe(false);
  });
});

describe("a run's skill steps", () => {
  const used = (pageId: string): AgentSkillRecord => ({ kind: "skill", pageId, title: pageId.toUpperCase(), outcome: "used" });
  const skipped = (pageId: string, reason: "editable" | "hidden" | "notASkill"): AgentSkillRecord => ({ kind: "skill", pageId, title: pageId.toUpperCase(), outcome: "skipped", reason });

  it("names every skill when the run starts", () => {
    expect(skillStepsToAdd([], [used("a"), skipped("b", "editable")])).toEqual([used("a"), skipped("b", "editable")]);
  });

  it("adds nothing when a run goes on and its skills stand as they did", () => {
    const before = [used("a"), { kind: "thought" as const, text: "Thinking" }, skipped("b", "editable")];
    expect(skillStepsToAdd(before, [used("a"), skipped("b", "editable")])).toEqual([]);
  });

  it("says when a skill is left out now, back, or left out for another reason", () => {
    const before = [used("a"), skipped("b", "editable"), skipped("c", "hidden")];
    expect(skillStepsToAdd(before, [skipped("a", "editable"), used("b"), skipped("c", "notASkill")])).toEqual([
      skipped("a", "editable"),
      used("b"),
      skipped("c", "notASkill"),
    ]);
  });

  it("compares with the latest step of each skill", () => {
    expect(skillStepsToAdd([used("a"), skipped("a", "editable")], [skipped("a", "editable")])).toEqual([]);
  });

  it("says a skill it followed was taken from the agent meanwhile, once", () => {
    const removed: AgentSkillRecord = { kind: "skill", pageId: "a", title: "A", outcome: "skipped", reason: "removed" };
    expect(skillStepsToAdd([used("a"), skipped("b", "editable")], [])).toEqual([removed]);
    expect(skillStepsToAdd([used("a"), removed], [])).toEqual([]);
  });
});

describe("scheduled runs", () => {
  it("are told apart by their source", () => {
    expect(isScheduleRun({ kind: "schedule", scheduleId: "s1", scheduledBy: "u1", databaseId: "d1" })).toBe(true);
    expect(isScheduleRun({ kind: "schedule", scheduleId: "s1", scheduledBy: "u1" })).toBe(true);
    expect(isScheduleRun({ kind: "request", requestedBy: "u1" } as Parameters<typeof isScheduleRun>[0])).toBe(false);
  });

  it("may change more rows than a run on one row, to go through a database", () => {
    expect(MAX_SCHEDULED_WRITES).toBeGreaterThan(MAX_AGENT_WRITES);
  });

  it("are linked to in the agent's settings", () => {
    expect(agentRunPath("ws1", "a1", "r1")).toBe("/w/ws1/settings?tab=agents&agent=a1&run=r1");
  });
});

describe("who a run is for (sees its work and answers its call)", () => {
  const row: AgentRunSource = { kind: "automation", automationId: "au", automationRunId: "ar", databaseId: "db", rowId: "row" };
  const scheduled: AgentRunSource = { kind: "schedule", scheduleId: "s", scheduledBy: "o1", databaseId: "db" };
  const asked: AgentRunSource = { kind: "request", requestedBy: "o1", via: "api" };
  const askedOnRow: AgentRunSource = { ...asked, rowId: "row", databaseId: "db" };
  const ownSchedule: AgentRunSource = { kind: "schedule", scheduleId: "s", scheduledBy: "o1" };
  const event: AgentRunSource = { kind: "connection", connectionId: "c", triggerId: "t", eventId: "e" };

  it("decides by the row, or the schedule's database", () => {
    expect([row, scheduled, asked, askedOnRow, ownSchedule, event].map(runPageOf)).toEqual(["row", "db", null, "row", null, null]);
  });

  it("is a row's or a database's run for the owners who can open it", () => {
    expect(ownerSeesRun(row, "o2", true)).toBe(true);
    expect(ownerSeesRun(row, "o2", false)).toBe(false);
    expect(ownerSeesRun(scheduled, "o2", true)).toBe(true);
    expect(ownerSeesRun(scheduled, "o1", false)).toBe(false);
  });

  it("is a run an owner asked for, or set a schedule without a database for, theirs alone", () => {
    expect(ownerSeesRun(asked, "o1", false)).toBe(true);
    expect(ownerSeesRun(asked, "o2", false)).toBe(false);
    expect(ownerSeesRun(askedOnRow, "o1", false)).toBe(false);
    expect(ownerSeesRun(askedOnRow, "o2", true)).toBe(false);
    expect(ownerSeesRun(ownSchedule, "o1", false)).toBe(true);
    expect(ownerSeesRun(ownSchedule, "o2", false)).toBe(false);
  });

  it("is a connection's event's run every owner's", () => {
    expect(ownerSeesRun(event, "o2", false)).toBe(true);
  });

  it("is a chat's run the chatting person's alone", () => {
    const chat: AgentRunSource = { kind: "chat", userId: "o1", conversationId: "c" };
    expect(runPageOf(chat)).toBeNull();
    expect(ownerSeesRun(chat, "o1", false)).toBe(true);
    expect(ownerSeesRun(chat, "o2", true)).toBe(false);
  });
});
