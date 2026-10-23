import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_DATABASES,
  planJson,
  renameDatabase,
  renameProperty,
  validateDatabasePlan,
  withoutDatabase,
  withoutProperty,
  withoutRows,
  withoutView,
  type DatabasePlan,
} from "./database-plan";

/** A plan as a model writes it, before it is checked. */
type RawPlan = {
  intro: { title: string; icon: string; markdown: string } | null;
  databases: {
    key: string;
    title: string;
    icon?: string;
    properties: { name: string; type: string; description?: string; options?: { name: string; color?: string; group?: string }[]; database?: string; two_way?: boolean; paired_name?: string }[];
    views: Record<string, unknown>[];
    rows: { title: string; values: Record<string, unknown> }[];
  }[];
};

/** A hiring plan: candidates linked to interviews, with views and example rows. */
const hiring = (): RawPlan => ({
  intro: { title: "Hiring", icon: "🧑‍💼", markdown: "How we hire." },
  databases: [
    {
      key: "candidates",
      title: "Candidates",
      icon: "🙂",
      properties: [
        { name: "Stage", type: "status", options: [{ name: "Applied" }, { name: "Interviewing" }, { name: "Hired" }] },
        { name: "Role", type: "select", options: [{ name: "Engineer", color: "blue" }, { name: "Designer", color: "pink" }] },
        { name: "Email", type: "email" },
        { name: "Start", type: "date" },
        { name: "Owner", type: "person" },
      ],
      views: [
        { name: "Pipeline", type: "board", group_by: "Stage" },
        { name: "Mine", type: "table", filters: [{ property: "Owner", op: "contains", value: "me" }], sorts: [{ property: "Start", direction: "desc" }] },
        { name: "Starts", type: "calendar", date_by: "Start" },
      ],
      rows: [{ title: "Ada", values: { Stage: "interviewing", Role: "Engineer", Start: "2026-11-02", Owner: "me" } }],
    },
    {
      key: "interviews",
      title: "Interviews",
      icon: "🗓️",
      properties: [
        { name: "Candidate", type: "relation", database: "candidates", two_way: true, paired_name: "Interviews" },
        { name: "When", type: "date" },
        { name: "Passed", type: "checkbox" },
      ],
      views: [],
      rows: [{ title: "Ada, first round", values: { Candidate: ["Ada"], When: "2026-10-30", Passed: true } }],
    },
  ],
});

function valid(raw: unknown): DatabasePlan {
  const checked = validateDatabasePlan(raw);
  if (!checked.ok) throw new Error(checked.problems.join("\n"));
  return checked.plan;
}

function problems(raw: unknown): string[] {
  const checked = validateDatabasePlan(raw);
  return checked.ok ? [] : checked.problems;
}

describe("validateDatabasePlan", () => {
  it("takes a plan of linked databases with views and example rows", () => {
    const plan = valid(hiring());
    expect(plan.intro).toEqual({ title: "Hiring", icon: "🧑‍💼", markdown: "How we hire." });
    const [candidates, interviews] = plan.databases;
    // Options get colors in order, status options their groups by position.
    expect(candidates.properties[0].options).toEqual([
      { name: "Applied", color: "gray", group: "todo" },
      { name: "Interviewing", color: "brown", group: "in_progress" },
      { name: "Hired", color: "orange", group: "done" },
    ]);
    expect(candidates.properties[1].options?.map((o) => o.color)).toEqual(["blue", "pink"]);
    expect(candidates.views.map((v) => v.type)).toEqual(["board", "table", "calendar"]);
    // Values read as the options are written, people as "me".
    expect(candidates.rows[0].values).toEqual({ Stage: "Interviewing", Role: "Engineer", Start: "2026-11-02", Owner: ["me"] });
    expect(interviews.properties[0]).toMatchObject({ type: "relation", database: "candidates", two_way: true, paired_name: "Interviews" });
    // A database given no views gets a table.
    expect(interviews.views).toEqual([{ name: "", type: "table" }]);
    expect(interviews.rows[0].values).toEqual({ Candidate: ["Ada"], When: "2026-10-30", Passed: true });
  });

  it("reads back the plan it gave", () => {
    const plan = valid(hiring());
    expect(valid(planJson(plan))).toEqual(plan);
  });

  it("refuses what isn't a plan", () => {
    expect(problems(null)).toEqual(["The plan must be a JSON object with a databases list."]);
    expect(problems({ databases: [] })).toEqual(["The plan needs at least one database in databases."]);
    const many = { databases: Array.from({ length: MAX_PLAN_DATABASES + 1 }, (_, i) => ({ key: `d${i}`, title: `D${i}`, properties: [] })) };
    expect(problems(many)).toContain(`A plan has at most ${MAX_PLAN_DATABASES} databases.`);
  });

  it("names every problem in words the model can fix", () => {
    const plan = hiring();
    plan.databases[0].properties.push({ name: "Name", type: "text" }, { name: "Score", type: "formula" }, { name: "Email", type: "url" });
    plan.databases[0].properties[1].options![0].color = "teal";
    plan.databases[1].properties[0].database = "people";
    plan.databases[0].views.push({ name: "Wall", type: "chart" } as never);
    const found = problems(plan);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringContaining('property "Name": rows have their name (title) already'),
        expect.stringContaining('property "Score": formula properties can\'t be part of a plan'),
        'Database "Candidates" has two properties named "Email".',
        expect.stringContaining('option "Engineer": unknown color "teal"'),
        expect.stringContaining('property "Candidate": a relation needs database, the key of one of the plan\'s databases (candidates, interviews)'),
        expect.stringContaining('unknown view type "chart"'),
      ]),
    );
  });

  it("checks keys", () => {
    const plan = hiring();
    plan.databases[1].key = "candidates";
    expect(problems(plan)).toContain('Two databases have the key "candidates".');
    plan.databases[1].key = "Bad Key!";
    expect(problems(plan)).toEqual([expect.stringContaining('key "bad key!" must be lowercase letters')]);
  });

  it("needs a status to start and finish", () => {
    const plan = hiring();
    plan.databases[0].properties[0].options = [{ name: "Open", group: "in_progress" } as never, { name: "Closed", group: "done" } as never];
    expect(problems(plan)).toEqual(expect.arrayContaining([expect.stringContaining('a status needs at least one option in the "todo" group')]));
    plan.databases[0].properties[0].options = [{ name: "Open", group: "later" } as never];
    expect(problems(plan)).toEqual(expect.arrayContaining([expect.stringContaining('unknown group "later"')]));
  });

  it("gives a board columns, and checks what views group, date and filter by", () => {
    const plan = hiring();
    plan.databases[0].views = [{ name: "Board", type: "board" } as never];
    expect(valid(plan).databases[0].views[0].group_by).toBe("Stage");
    plan.databases[0].views = [
      { name: "A", type: "board", group_by: "Email" },
      { name: "B", type: "calendar", date_by: "Role" },
      { name: "C", type: "table", filters: [{ property: "Role", op: "equals", value: "Manager" }] },
      { name: "D", type: "table", filters: [{ property: "Start", op: "contains", value: "x" }] },
      { name: "E", type: "list", date_by: "Start" },
    ] as never;
    expect(problems(plan)).toEqual([
      expect.stringContaining('rows can\'t be grouped by "Email", a email property'),
      expect.stringContaining('"Role" is a select property, not a date'),
      expect.stringContaining("needs one of its options (Engineer, Designer)"),
      expect.stringContaining('"Start" (date) filters with equals, not_equals, gt, lt, is_empty, is_not_empty, not "contains"'),
      expect.stringContaining("only calendars and timelines have date_by"),
    ]);
  });

  it("checks example rows' values", () => {
    const plan = hiring();
    plan.databases[0].rows = [{ title: "Bo", values: { Stage: "Gone", Start: "next week", Owner: "Grace", Unknown: 1 } as never }];
    plan.databases[1].rows[0].values.Candidate = ["Nobody"];
    expect(problems(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"Stage": the value must be one of its options'),
        expect.stringContaining('"Start": the value must be a date'),
        expect.stringContaining('"Owner": example rows can only assign "me"'),
        expect.stringContaining('"Unknown" isn\'t one of the database\'s properties'),
        expect.stringContaining('"Candidate": the value must be titles of example rows of the database it links to'),
      ]),
    );
  });

  it("lets a relation name rows of a database that comes later", () => {
    const plan = hiring();
    plan.databases.reverse();
    expect(valid(plan).databases[0].rows[0].values.Candidate).toEqual(["Ada"]);
  });
});

describe("adjusting a plan", () => {
  it("renames a database", () => {
    expect(renameDatabase(valid(hiring()), "interviews", "Calls").databases[1].title).toBe("Calls");
  });

  it("renames a property wherever it is named", () => {
    const plan = renameProperty(valid(hiring()), "candidates", "Start", "Start date");
    const [candidates] = plan.databases;
    expect(candidates.properties[3].name).toBe("Start date");
    expect(candidates.views[1].sorts).toEqual([{ property: "Start date", direction: "desc" }]);
    expect(candidates.views[2].date_by).toBe("Start date");
    expect(candidates.rows[0].values["Start date"]).toBe("2026-11-02");
    expect(validateDatabasePlan(planJson(plan)).ok).toBe(true);
  });

  it("removes a property with what used it", () => {
    let plan = withoutProperty(valid(hiring()), "candidates", "Stage");
    // The board groups by the next select; the calendar keeps its date.
    expect(plan.databases[0].views[0].group_by).toBe("Role");
    expect(plan.databases[0].rows[0].values).not.toHaveProperty("Stage");
    plan = withoutProperty(plan, "candidates", "Role");
    expect(plan.databases[0].views.map((v) => v.type)).toEqual(["table", "calendar"]);
    plan = withoutProperty(plan, "candidates", "Owner");
    expect(plan.databases[0].views[0].filters).toEqual([]);
    plan = withoutProperty(plan, "candidates", "Start");
    // Nothing left to show by date or sort: a table remains.
    expect(plan.databases[0].views).toEqual([{ name: "Mine", type: "table", filters: [], sorts: [] }]);
    expect(validateDatabasePlan(planJson(plan)).ok).toBe(true);
  });

  it("removes a database with the relations to it", () => {
    const plan = withoutDatabase(valid(hiring()), "candidates");
    expect(plan.databases.map((d) => d.key)).toEqual(["interviews"]);
    expect(plan.databases[0].properties.map((p) => p.name)).toEqual(["When", "Passed"]);
    expect(plan.databases[0].rows[0].values).toEqual({ When: "2026-10-30", Passed: true });
    expect(validateDatabasePlan(planJson(plan)).ok).toBe(true);
  });

  it("removes a view but keeps one, and drops the example rows", () => {
    const plan = valid(hiring());
    expect(withoutView(plan, "candidates", 0).databases[0].views.map((v) => v.name)).toEqual(["Mine", "Starts"]);
    expect(withoutView(plan, "interviews", 0).databases[1].views).toHaveLength(1);
    expect(withoutRows(plan).databases.every((d) => d.rows.length === 0)).toBe(true);
  });
});
