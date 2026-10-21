/**
 * Drafting an agent from a description (draft.ts): only owners, only with AI on, over the pages
 * the owner may share, with the request counted as the agents' AI usage; and creating the agent
 * from a draft, taken back when a step fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/server/ai";
import { installFauxAi, resetAi } from "@/server/ai/testing";
import { memoryAiUsageLedger } from "@/server/ai/usage";

const access = vi.hoisted(() => ({ owners: new Set<string>() }));
const aiOn = vi.hoisted(() => ({ value: true }));
const made = vi.hoisted(() => ({ calls: [] as string[], failAutomation: false }));

class NotAllowed extends Error {}

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", () => ({
  requireMembership: async (userId: string, _workspaceId: string, role?: string) => {
    if (role === "owner" && !access.owners.has(userId)) throw new NotAllowed("Not an owner");
  },
}));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: async () => aiOn.value }));
vi.mock("@/server/pages", () => ({
  // The tree as the owner sees it: a page they may only view, and a row-free sidebar.
  getTree: async () => [
    { id: "weekly", parentId: null, kind: "page", title: "Weekly", icon: null, level: "full" },
    { id: "tasks", parentId: null, kind: "database", title: "Tasks", icon: "✅", level: "full" },
    { id: "salaries", parentId: null, kind: "database", title: "Salaries", icon: null, level: "view" },
    { id: "notes", parentId: "weekly", kind: "page", title: "Old notes", icon: null, level: "full" },
  ],
  fullTextSearch: async () => [{ id: "tasks" }, { id: "salaries" }, { id: "a-row" }],
  recentPages: async () => [{ id: "notes" }],
}));
vi.mock("@/server/databases", () => ({
  knownProperties: async (_userId: string, id: string) => (id === "tasks" ? [{ id: "due", name: "Due", type: "date" }] : []),
}));
vi.mock("./manage", () => ({
  AgentError: class extends Error {},
  createAgent: async (_userId: string, _workspaceId: string, input: { name: string }) => {
    made.calls.push(`agent:${input.name}`);
    return { id: "agent-1", name: input.name };
  },
  setAgentAccess: async (_userId: string, _agentId: string, pageId: string, level: string) => void made.calls.push(`share:${pageId}:${level}`),
  archiveAgent: async () => void made.calls.push("archive"),
}));
vi.mock("./schedules", () => ({
  setAgentSchedule: async (_userId: string, _agentId: string, _id: null, input: { timeZone: string }) => {
    made.calls.push(`schedule:${input.timeZone}`);
    return { id: "schedule-1" };
  },
  removeAgentSchedule: async (_userId: string, _agentId: string, id: string) => void made.calls.push(`unschedule:${id}`),
}));
vi.mock("@/server/automations/manage", () => ({
  createAutomation: async (_userId: string, databaseId: string, input: { name: string; trigger: { type: string } }) => {
    if (made.failAutomation) throw new Error("No full access");
    made.calls.push(`automation:${databaseId}:${input.trigger.type}:${input.name}`);
    return { id: "automation-1" };
  },
  deleteAutomation: async () => void made.calls.push("unautomate"),
}));

const { createAgentFromDraft, draftAgent, draftCandidates } = await import("./draft");

const reply = {
  name: "Weekly summary",
  instructions: "1. Read last week's new rows in Tasks.\n2. Comment a summary on Weekly.",
  access: "comment",
  pages: [{ id: "tasks", access: "view" }, { id: "weekly", access: "full" }, { id: "salaries", access: "view" }, { id: "nowhere" }],
  schedules: [{ frequency: "weekly", weekdays: [1], time: "09:00", task: "Summarize last week." }],
  automations: [{ database_id: "salaries", trigger: "row_created", task: "Look at it." }],
};

let ledger: ReturnType<typeof memoryAiUsageLedger>;
let prompts: string[];
let answer: string;

beforeEach(() => {
  access.owners = new Set(["owner"]);
  aiOn.value = true;
  made.calls = [];
  made.failAutomation = false;
  prompts = [];
  answer = JSON.stringify(reply);
  ledger = memoryAiUsageLedger();
  installFauxAi(
    ({ prompt }) => {
      prompts.push(prompt);
      return answer;
    },
    { usage: ledger },
  );
});

afterEach(() => resetAi());

describe("draftCandidates", () => {
  it("offers only pages and databases the owner may share, search hits first", async () => {
    const found = await draftCandidates("owner", "ws", "summarize tasks");
    expect(found.map((c) => c.id)).toEqual(["tasks", "notes", "weekly"]);
    expect(found[0]).toMatchObject({ kind: "database", properties: [{ id: "due", name: "Due", type: "date" }] });
  });
});

describe("draftAgent", () => {
  it("drafts for an owner, keeping only candidates and clamping access", async () => {
    const draft = await draftAgent("owner", "ws", "Every Monday summarize last week's new rows in Tasks and comment it on the Weekly page");
    expect(draft.name).toBe("Weekly summary");
    expect(draft.pages.map((p) => [p.pageId, p.level])).toEqual([
      ["tasks", "view"],
      ["weekly", "edit"],
    ]);
    expect(draft.schedules).toHaveLength(1);
    // The owner can only view Salaries: no automation on it.
    expect(draft.automations).toEqual([]);
    expect(prompts[0]).toContain("Every Monday summarize");
    expect(prompts[0]).not.toContain("Salaries");
  });

  it("records the request on the workspace's AI usage as the agents'", async () => {
    await draftAgent("owner", "ws", "Summarize the week");
    expect(ledger.rows).toEqual([expect.objectContaining({ workspaceId: "ws", feature: "agent.draft", requests: 1 })]);
  });

  it("is refused to anyone who may not create agents, before asking the AI", async () => {
    await expect(draftAgent("member", "ws", "Summarize the week")).rejects.toBeInstanceOf(NotAllowed);
    expect(prompts).toEqual([]);
    expect(ledger.rows).toEqual([]);
  });

  it("needs AI on in the workspace and a description", async () => {
    aiOn.value = false;
    await expect(draftAgent("owner", "ws", "Summarize the week")).rejects.toMatchObject({ code: "disabled" });
    aiOn.value = true;
    await expect(draftAgent("owner", "ws", "   ")).rejects.toMatchObject({ code: "invalid" });
    expect(prompts).toEqual([]);
  });

  it("fails with a short error when the answer holds no agent", async () => {
    answer = "Sorry, I can't do that.";
    const error = await draftAgent("owner", "ws", "Summarize the week").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ code: "empty" });
    // The request was made, so it counts all the same.
    expect(ledger.rows).toHaveLength(1);
  });

  it("passes on the AI's own failures", async () => {
    installFauxAi(() => {
      throw new Error("overloaded");
    });
    await expect(draftAgent("owner", "ws", "Summarize the week")).rejects.toMatchObject({ code: "provider" });
  });
});

describe("createAgentFromDraft", () => {
  const input = {
    name: "Weekly summary",
    instructions: "Do it.",
    pages: [{ pageId: "weekly", level: "comment" }],
    schedules: [{ rule: { frequency: "weekly", interval: 1, weekdays: [1], time: "09:00" }, task: "Summarize.", databaseId: null }],
    automations: [{ databaseId: "tasks", trigger: { type: "row_created" as const }, task: "Triage." }],
    timeZone: "Europe/Istanbul",
  };
  const name = (agent: string) => `Run ${agent}`;

  it("creates the agent, then its shares, schedules and automations", async () => {
    await createAgentFromDraft("owner", "ws", input, { automationName: name });
    expect(made.calls).toEqual(["agent:Weekly summary", "share:weekly:comment", "schedule:Europe/Istanbul", "automation:tasks:row_created:Run Weekly summary"]);
  });

  it("takes everything back when a step fails", async () => {
    made.failAutomation = true;
    await expect(createAgentFromDraft("owner", "ws", input, { automationName: name })).rejects.toThrow("No full access");
    expect(made.calls).toEqual(["agent:Weekly summary", "share:weekly:comment", "schedule:Europe/Istanbul", "unschedule:schedule-1", "archive"]);
  });

  it("refuses an access level an agent can't have before making anything", async () => {
    await expect(createAgentFromDraft("owner", "ws", { ...input, pages: [{ pageId: "weekly", level: "full" }] }, { automationName: name })).rejects.toThrow();
    expect(made.calls).toEqual([]);
  });
});
