import { describe, expect, it } from "vitest";
import type { AiTool } from "@/server/ai";
import { ASK_QUESTIONS_TOOL, endPlanTurn, PLAN_TOOLS, planningTools, PROPOSE_PLAN_TOOL } from "./ai-chat-plan";

const tool = (name: string): AiTool => ({ name, description: name, parameters: { type: "object", properties: {} } });
const DROPPED = new Set(["remind_person", "change_reminder"]);

describe("what each mode of the chat is offered", () => {
  // What a chat that changes nothing has (ai-chat.ts forces `read` for a planning turn): reads only.
  const reads = ["search_pages", "read_page", "query_database", "find_tools", "use_tool", "list_reminders", "remind_person", "change_reminder"].map(tool);

  it("a planning turn gets the reads and the two tools that end it, never reminders", () => {
    const names = planningTools(reads, DROPPED).map((t) => t.name);
    expect(names).toEqual(["search_pages", "read_page", "query_database", "find_tools", "use_tool", "list_reminders", "ask_questions", "propose_plan"]);
  });

  it("the two tools are only for planning: other turns are not given them", () => {
    expect(reads.some((t) => PLAN_TOOLS.includes(t))).toBe(false);
    expect(PLAN_TOOLS).toEqual([ASK_QUESTIONS_TOOL, PROPOSE_PLAN_TOOL]);
  });
});

describe("what ends a planning turn", () => {
  it("is its card and words", () => {
    const ended = endPlanTurn({ name: "propose_plan", arguments: { title: "Tidy", steps: [{ what: "Archive done tasks", where: "Tasks" }], risks: [] } });
    expect("card" in ended && ended.card.kind).toBe("proposal");
    expect("text" in ended && ended.text).toContain("Archive done tasks");
  });

  it("goes on, with the reason, when the arguments don't do", () => {
    const bad = endPlanTurn({ name: "ask_questions", arguments: { questions: [{ question: "a", options: ["only"] }] } });
    expect("card" in bad).toBe(false);
    expect(bad).toMatchObject({ isError: true });
  });
});
