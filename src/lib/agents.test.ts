import { describe, expect, it } from "vitest";
import {
  accessSource,
  AGENT_EMAIL_DOMAIN,
  agentEmail,
  agentRunPath,
  callToSend,
  INBOX_CALL_CHARS,
  inboxCallInput,
  isAgentEmail,
  isMentionRun,
  isScheduleRun,
  mailRun,
  mayCallAfterMail,
  MAX_AGENT_WRITES,
  MAX_SCHEDULED_WRITES,
  ownerSeesRun,
  readEmail,
  runPageOf,
  skillStepsToAdd,
  type AgentRunSource,
  type AgentSkillRecord,
  type AgentStepRecord,
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
  const mentioned: AgentRunSource = { kind: "mention", pageId: "page", threadId: "th", commentId: "c1", mentionedBy: "m1" };

  it("decides by the row, the schedule's database, or the page a mention's comment is on", () => {
    expect([row, scheduled, asked, askedOnRow, ownSchedule, event, mentioned].map(runPageOf)).toEqual(["row", "db", null, "row", null, null, "page"]);
  });

  it("is a mention's run for the owners who can open its page, the member who mentioned the agent aside", () => {
    expect(isMentionRun(mentioned)).toBe(true);
    expect([row, asked, event].some(isMentionRun)).toBe(false);
    expect(ownerSeesRun(mentioned, "o1", true)).toBe(true);
    expect(ownerSeesRun(mentioned, "o1", false)).toBe(false);
    expect(ownerSeesRun(mentioned, "m1", false)).toBe(false);
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

  it("is a helper's run for whoever the run that asked it is for", () => {
    const handoff = (parent: Exclude<AgentRunSource, { kind: "handoff" }>): AgentRunSource => ({
      kind: "handoff",
      parentRunId: "r",
      fromAgentId: "a",
      callId: "c",
      boundTo: null,
      trusted: true,
      parent,
    });
    expect([row, scheduled, asked, event].map((p) => runPageOf(handoff(p)))).toEqual(["row", "db", null, null]);
    expect(accessSource(handoff(asked))).toBe(asked);
    expect(ownerSeesRun(handoff(row), "o2", true)).toBe(true);
    expect(ownerSeesRun(handoff(row), "o2", false)).toBe(false);
    expect(ownerSeesRun(handoff(asked), "o1", false)).toBe(true);
    expect(ownerSeesRun(handoff(asked), "o2", false)).toBe(false);
    expect(ownerSeesRun(handoff(event), "o2", false)).toBe(true);
  });

  it("is a chat's run the chatting person's alone", () => {
    const chat: AgentRunSource = { kind: "chat", userId: "o1", conversationId: "c" };
    expect(runPageOf(chat)).toBeNull();
    expect(ownerSeesRun(chat, "o1", false)).toBe(true);
    expect(ownerSeesRun(chat, "o2", true)).toBe(false);
  });

  it("is a run on new email its mailbox owner's alone", () => {
    const mail: AgentRunSource = { kind: "mail", mailboxId: "b1", userId: "o1", threadId: "t1", messageId: "m1" };
    expect(runPageOf(mail)).toBeNull();
    expect(ownerSeesRun(mail, "o1", false)).toBe(true);
    expect(ownerSeesRun(mail, "o2", true)).toBe(false);
  });
});

describe("mailRun", () => {
  it("lets only runs that show to their person alone and stay in the app read their email", () => {
    expect(mailRun({ kind: "chat", userId: "u1", conversationId: "c1" })).toBe(true);
    expect(mailRun({ kind: "schedule", scheduleId: "s1", scheduledBy: "u1" })).toBe(true);
    expect(mailRun({ kind: "mail", mailboxId: "b1", userId: "u1", threadId: "t1", messageId: "m1" })).toBe(true);
    expect(mailRun({ kind: "chat", userId: "u1", conversationId: "c1", fromApp: true })).toBe(false);
    expect(mailRun({ kind: "schedule", scheduleId: "s1", scheduledBy: "u1", databaseId: "db1" })).toBe(false);
    expect(mailRun({ kind: "request", requestedBy: "u1", via: "mcp" })).toBe(false);
    expect(mailRun({ kind: "mention", pageId: "p1", threadId: "t1", commentId: "c1", mentionedBy: "u1" })).toBe(false);
    expect(mailRun({ kind: "automation", automationId: "a1", automationRunId: "r1", databaseId: "db1", rowId: "row1" })).toBe(false);
    const parent = { kind: "chat" as const, userId: "u1", conversationId: "c1" };
    expect(mailRun({ kind: "handoff", parentRunId: "r1", fromAgentId: "a1", callId: "k1", boundTo: "u1", trusted: true, parent })).toBe(false);
  });
});

describe("after reading email", () => {
  it("knows a run that read email, or went on from a chat that had, but not one that only drafted", () => {
    const steps = (s: AgentStepRecord[]) => s;
    expect(readEmail(steps([{ kind: "mail", action: "search", query: "x", results: 1 }]))).toBe(true);
    expect(readEmail(steps([{ kind: "mail", action: "read", subject: "x", url: "/m" }]))).toBe(true);
    expect(readEmail(steps([{ kind: "mail", action: "earlier" }]))).toBe(true);
    expect(readEmail(steps([{ kind: "mail", action: "draft", subject: "x", to: [], url: null, outcome: "done" }]))).toBe(false);
    // Sorting and summarizing come after reading: on their own they read nothing.
    expect(readEmail(steps([{ kind: "mail", action: "sort", subject: "x", did: "archive", folder: null, url: "/m" }]))).toBe(false);
    expect(readEmail(steps([{ kind: "mail", action: "summary", subject: "x", url: "/m" }]))).toBe(false);
    expect(readEmail(steps([{ kind: "memory", action: "remember", text: "x" }]))).toBe(false);
    expect(readEmail(undefined)).toBe(false);
  });

  it("lets such a run only read pages, find and use tools, and use the mail tools", () => {
    for (const name of ["read_page", "search_pages", "query_database", "find_tools", "use_tool", "search_mail", "read_mail", "draft_mail"]) expect(mayCallAfterMail(name, false)).toBe(true);
    for (const name of ["edit_page", "create_page", "update_row", "add_comment", "send_email", "remember", "ask_agent", "read_web_page", "search_web", "leave_note"]) expect(mayCallAfterMail(name, false)).toBe(false);
    // A connected service's tool, even one that only reads and shares a page tool's name.
    expect(mayCallAfterMail("read_page", true)).toBe(false);
  });
});
