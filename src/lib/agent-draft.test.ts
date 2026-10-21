import { describe, expect, it } from "vitest";
import { clampAccessLevel, MAX_DRAFT_PAGES, readDraftJson, validateAgentDraft, type DraftCandidate } from "./agent-draft";
import { MAX_AGENT_NAME } from "./agents";

const candidates: DraftCandidate[] = [
  {
    id: "tasks",
    title: "Tasks",
    icon: "✅",
    kind: "database",
    properties: [
      { id: "status", name: "Status", type: "status" },
      { id: "due", name: "Due", type: "date" },
    ],
  },
  { id: "weekly", title: "Weekly", icon: null, kind: "page" },
];

const answer = {
  name: "Weekly summary",
  icon: "📊",
  description: "Summarizes the week's new tasks.",
  instructions: "1. Read the rows of Tasks added last week.\n2. Write a short summary as a comment on the Weekly page.",
  access: "comment",
  pages: [{ id: "tasks", access: "view" }, { id: "weekly", access: "comment" }],
  schedules: [{ frequency: "weekly", interval: 1, weekdays: [1], time: "09:00", database_id: null, task: "Summarize last week's new tasks." }],
  automations: [{ database_id: "tasks", trigger: "date_passed", date: "due", days: 1, task: "Comment that the task is late." }],
};

describe("readDraftJson", () => {
  it("reads the object on its own, in code fences or with text around it", () => {
    expect(readDraftJson('{"name":"A"}')).toEqual({ name: "A" });
    expect(readDraftJson('```json\n{"name":"A"}\n```')).toEqual({ name: "A" });
    expect(readDraftJson('Here is the agent: {"name":"A"} Hope it helps.')).toEqual({ name: "A" });
  });

  it("is null without one, or for one cut off", () => {
    expect(readDraftJson("I can't help with that.")).toBeNull();
    expect(readDraftJson('{"name":"A", "instructions": "1. Re')).toBeNull();
    expect(readDraftJson("")).toBeNull();
  });
});

describe("clampAccessLevel", () => {
  it("keeps an agent's levels, brings full down to edit and anything else to the fallback", () => {
    expect(clampAccessLevel("comment")).toBe("comment");
    expect(clampAccessLevel(" Edit ")).toBe("edit");
    expect(clampAccessLevel("full")).toBe("edit");
    expect(clampAccessLevel("admin")).toBe("view");
    expect(clampAccessLevel(undefined, "comment")).toBe("comment");
  });
});

describe("validateAgentDraft", () => {
  it("keeps a valid draft as it is", () => {
    expect(validateAgentDraft(answer, candidates)).toEqual({
      name: "Weekly summary",
      icon: "📊",
      description: "Summarizes the week's new tasks.",
      instructions: answer.instructions,
      pages: [
        { pageId: "tasks", title: "Tasks", icon: "✅", kind: "database", level: "view" },
        { pageId: "weekly", title: "Weekly", icon: null, kind: "page", level: "comment" },
      ],
      schedules: [{ rule: { frequency: "weekly", interval: 1, weekdays: [1], time: "09:00" }, task: "Summarize last week's new tasks.", databaseId: null, databaseTitle: null }],
      automations: [
        { databaseId: "tasks", databaseTitle: "Tasks", trigger: { type: "date_passed", date: "due", days: 1 }, propertyName: "Due", task: "Comment that the task is late." },
      ],
    });
  });

  it("drops pages and databases that aren't candidates (unknown, or ones the owner can't share)", () => {
    const draft = validateAgentDraft(
      {
        ...answer,
        pages: ["weekly", { id: "secret-page", access: "edit" }, { id: "made-up" }, { id: "weekly", access: "edit" }],
        schedules: [{ ...answer.schedules[0], database_id: "secret-db" }],
        automations: [{ ...answer.automations[0], database_id: "secret-db" }, { database_id: "weekly", trigger: "row_created", task: "x" }],
      },
      candidates,
    );
    expect(draft!.pages.map((p) => p.pageId)).toEqual(["weekly"]);
    expect(draft!.schedules).toEqual([expect.objectContaining({ databaseId: null })]);
    // A page isn't a database.
    expect(draft!.automations).toEqual([]);
  });

  it("clamps access levels: full to edit, unknown ones to the draft's own level, and that to view", () => {
    const draft = validateAgentDraft({ ...answer, access: "owner", pages: [{ id: "tasks", access: "full" }, { id: "weekly", access: "superuser" }] }, candidates);
    expect(draft!.pages.map((p) => p.level)).toEqual(["edit", "edit"]);
    const fallback = validateAgentDraft({ ...answer, access: "nonsense", pages: [{ id: "weekly" }] }, candidates);
    expect(fallback!.pages[0].level).toBe("view");
  });

  it("shares a database a schedule looks after, at the draft's level", () => {
    const draft = validateAgentDraft({ ...answer, access: "edit", pages: [], schedules: [{ ...answer.schedules[0], database_id: "tasks" }] }, candidates);
    expect(draft!.pages).toEqual([expect.objectContaining({ pageId: "tasks", level: "edit" })]);
    expect(draft!.schedules[0]).toMatchObject({ databaseId: "tasks", databaseTitle: "Tasks" });
  });

  it("drops schedules with a rule or task that doesn't hold, and reads day names and short times", () => {
    const draft = validateAgentDraft(
      {
        ...answer,
        schedules: [
          { frequency: "weekly", weekdays: ["monday", "Fri"], time: "9:30", task: "Go through the week." },
          { frequency: "weekly", weekdays: [], time: "09:00", task: "No days" },
          { frequency: "hourly", time: "09:00", task: "Not a frequency" },
          { frequency: "daily", time: "25:00", task: "Not a time" },
          { frequency: "daily", time: "08:00", task: "  " },
        ],
      },
      candidates,
    );
    expect(draft!.schedules).toEqual([{ rule: { frequency: "weekly", interval: 1, weekdays: [1, 5], time: "09:30" }, task: "Go through the week.", databaseId: null, databaseTitle: null }]);
  });

  it("keeps only triggers that exist, with properties of their database", () => {
    const draft = validateAgentDraft(
      {
        ...answer,
        automations: [
          { database_id: "tasks", trigger: "row_created", task: "Triage it." },
          { database_id: "tasks", trigger: "property_changed", property_id: "status", task: "Check it." },
          { database_id: "tasks", trigger: "property_changed", property_id: "made-up", task: "Any change." },
          { database_id: "tasks", trigger: "date_passed", date: "status", days: 1, task: "Not a date property" },
          { database_id: "tasks", trigger: "date_passed", date: "created_time", days: -2, task: "Negative days" },
          { database_id: "tasks", trigger: "button_clicked", task: "No such trigger" },
        ],
      },
      candidates,
    );
    expect(draft!.automations.map((a) => [a.trigger, a.propertyName])).toEqual([
      [{ type: "row_created" }, null],
      [{ type: "property_changed", propertyId: "status" }, "Status"],
      [{ type: "property_changed", propertyId: null }, null],
    ]);
  });

  it("cuts texts to their limits and bounds the lists", () => {
    const many = Array.from({ length: MAX_DRAFT_PAGES + 5 }, (_, i) => ({ id: `p${i}`, title: `P${i}`, icon: null, kind: "page" as const }));
    const draft = validateAgentDraft({ ...answer, name: "x".repeat(500), icon: "not an emoji at all", pages: many.map((p) => p.id) }, many);
    expect(draft!.name).toHaveLength(MAX_AGENT_NAME);
    expect(draft!.icon).toBeNull();
    expect(draft!.pages).toHaveLength(MAX_DRAFT_PAGES);
  });

  it("handles malformed answers: no object, wrong types, no agent in it", () => {
    expect(validateAgentDraft(null, candidates)).toBeNull();
    expect(validateAgentDraft(["a list"], candidates)).toBeNull();
    expect(validateAgentDraft({ pages: ["weekly"] }, candidates)).toBeNull();
    const odd = validateAgentDraft({ name: 42, instructions: "Do the thing.", pages: "weekly", schedules: "daily", automations: [null, 3] }, candidates, "Summarize the week's tasks for me");
    expect(odd).toMatchObject({ name: "Summarize the week's tasks for me", instructions: "Do the thing.", schedules: [], automations: [] });
    expect(odd!.pages.map((p) => p.pageId)).toEqual(["weekly"]);
  });
});
