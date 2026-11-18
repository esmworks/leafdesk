/**
 * Suggest skills (skill-suggestions.ts): reads only the person's own questions (the conversation
 * query is theirs, the workspace's, with no agent) and the titles of pages they edited, frames
 * them as data, needs AI on, asks no model without anything to read, and creates a skill only
 * through createSkill, as the model's writing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/server/ai";
import { installFauxAi, resetAi } from "@/server/ai/testing";

const state = vi.hoisted(() => ({
  ai: true,
  conversations: [] as { messages: unknown[] }[],
  titles: [] as { title: string }[],
  skills: [] as { title: string }[],
  created: [] as unknown[],
  queries: [] as unknown[],
}));

vi.mock("@/db", () => {
  const chain = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const name of ["from", "where", "orderBy"]) q[name] = (...args: unknown[]) => (state.queries.push([name, args.length]), q);
    q.limit = async () => rows();
    return q;
  };
  return {
    db: {
      select: (fields: Record<string, unknown>) => chain(() => ("messages" in fields ? state.conversations : state.titles)),
    },
  };
});
vi.mock("@/server/access", () => ({ requireMembership: async () => undefined, pageVisibleTo: () => ({}) }));
vi.mock("@/server/page-outdated", () => ({ listedPage: () => ({}) }));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: async () => state.ai }));
vi.mock("@/server/skills", () => ({
  listSkills: async () => state.skills,
  createSkill: async (...args: unknown[]) => {
    state.created.push(args);
    return { id: "s1", workspaceId: "ws", databaseId: "db1" };
  },
}));

import { createSuggestedSkill, suggestSkills } from "./skill-suggestions";

const now = new Date("2026-11-19T12:00:00Z");
const message = (role: string, content: string, at: string) => ({ role, content, at });

describe("suggestSkills", () => {
  beforeEach(() => {
    state.ai = true;
    state.conversations = [
      {
        messages: [
          message("user", "Write release notes for v2", "2026-11-10T09:00:00Z"),
          message("assistant", "ANSWER-SECRET", "2026-11-10T09:01:00Z"),
          message("user", "Ancient question", "2026-08-01T09:00:00Z"),
        ],
      },
    ];
    state.titles = [{ title: "Weekly report" }, { title: "  " }];
    state.skills = [{ title: "Existing skill" }];
    state.created = [];
  });
  afterEach(() => resetAi());

  it("reads the person's recent questions and edited page titles, not answers or old questions, and proposes skills", async () => {
    let prompt = "";
    installFauxAi((request) => {
      prompt = request.prompt;
      return JSON.stringify({ skills: [{ name: "Release notes", when: "Before a release", instructions: "List the changes." }, { name: "Existing skill", instructions: "dup" }] });
    });
    const found = await suggestSkills("me", "ws", "tr", now);
    expect(prompt).toContain("Turkish");
    expect(prompt).toMatch(/<<<EXTERNAL DATA [0-9a-f]{12}\n/);
    expect(prompt).toContain("- Write release notes for v2");
    expect(prompt).toContain("- Weekly report");
    expect(prompt).not.toContain("ANSWER-SECRET");
    expect(prompt).not.toContain("Ancient question");
    expect(prompt).toContain('"Existing skill"');
    expect(found.suggestions.map((s) => s.title)).toEqual(["Release notes"]);
    expect([found.questions, found.pages]).toEqual([1, 1]);
  });

  it("asks no model when there is nothing to read", async () => {
    state.conversations = [];
    state.titles = [];
    installFauxAi(() => {
      throw new Error("no model call expected");
    });
    expect(await suggestSkills("me", "ws", undefined, now)).toEqual({ suggestions: [], questions: 0, pages: 0 });
  });

  it("is refused where AI is off", async () => {
    state.ai = false;
    installFauxAi(() => "{}");
    await expect(suggestSkills("me", "ws", undefined, now)).rejects.toMatchObject({ code: "disabled" } satisfies Partial<AiError>);
  });
});

describe("createSuggestedSkill", () => {
  beforeEach(() => {
    state.created = [];
  });

  it("makes the skill with createSkill as the model's writing, cut to the limits", async () => {
    const result = await createSuggestedSkill("me", "ws", { title: "T".repeat(200), description: "when", instructions: "Do it." }, "en");
    expect(result).toEqual({ id: "s1", workspaceId: "ws", databaseId: "db1" });
    const [userId, workspaceId, input, locale] = state.created[0] as [string, string, Record<string, unknown>, string];
    expect([userId, workspaceId, locale]).toEqual(["me", "ws", "en"]);
    expect(input).toMatchObject({ markdown: "Do it.", description: "when", byModel: true });
    expect((input.title as string).length).toBe(80);
  });

  it("refuses a suggestion without a title or instructions", async () => {
    await expect(createSuggestedSkill("me", "ws", { title: "x", instructions: " " })).rejects.toThrow();
    expect(state.created).toEqual([]);
  });
});
