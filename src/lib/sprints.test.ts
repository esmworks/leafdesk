import { describe, expect, it } from "vitest";
import type { PropertyOptions, SprintConfig } from "@/db/schema/app";
import {
  holdsSprints,
  isSprintWeeks,
  planSprintCompletion,
  sortSprints,
  sprintAfter,
  sprintDates,
  sprintDays,
  sprintNumber,
  sprintProperty,
  sprintStateOf,
  sprintTitles,
  tasksToMove,
  type SprintRow,
} from "./sprints";

const config: SprintConfig = {
  datesPropertyId: "dates",
  statePropertyId: "state",
  states: { current: "o-current", next: "o-next", future: "o-future", completed: "o-completed" },
  weeks: 2,
};

const sprint = (id: string, state: keyof SprintConfig["states"] | null, dates?: string, position = 0): SprintRow => ({
  id,
  title: `Sprint ${id}`,
  position,
  properties: { ...(state ? { state: config.states[state] } : {}), ...(dates ? { dates } : {}) },
});

let ids = 0;
const options = { today: "2026-10-24", newId: () => `new-${++ids}`, title: (n: number) => `Sprint ${n}` };

describe("sprint dates", () => {
  it("covers whole weeks from the first day", () => {
    expect(sprintDates("2026-10-26", 1)).toBe("2026-10-26/2026-11-01");
    expect(sprintDates("2026-10-26", 2)).toBe("2026-10-26/2026-11-08");
    expect(sprintDates("2026-12-21", 4)).toBe("2026-12-21/2027-01-17");
  });

  it("starts the next sprint the day after one ends, or today without dates", () => {
    expect(sprintAfter(sprintDays("2026-10-26/2026-11-08"), 2, "2026-01-01")).toBe("2026-11-09/2026-11-22");
    expect(sprintAfter(null, 1, "2026-10-24")).toBe("2026-10-24/2026-10-30");
  });

  it("reads plain days the same in every zone", () => {
    expect(sprintDays("2026-10-26/2026-11-08")).toEqual(sprintDays("2026-10-26/2026-11-08"));
    expect(sprintDays(null)).toBeNull();
  });

  it("knows the lengths it offers", () => {
    expect([0, 1, 2, 3, 4, 5, 1.5, "2"].map(isSprintWeeks)).toEqual([false, true, true, true, true, false, false, false]);
  });
});

describe("sprint titles", () => {
  it("reads the number a title ends with", () => {
    expect(sprintNumber("Sprint 12")).toBe(12);
    expect(sprintNumber("12. Sprint")).toBe(12);
    expect(sprintNumber("Kickoff")).toBeNull();
  });

  it("goes on from the highest-numbered sprint's title, else the fallback", () => {
    const fallback = (n: number) => `Sprint ${n}`;
    expect(sprintTitles(["Iteration 2", "Iteration 10", "Kickoff"], fallback)(11)).toBe("Iteration 11");
    expect(sprintTitles(["Sprint 3 (team A)"], fallback)(4)).toBe("Sprint 4 (team A)");
    expect(sprintTitles(["Kickoff"], fallback)(1)).toBe("Sprint 1");
  });
});

describe("planSprintCompletion", () => {
  it("completes the current sprint, makes the next one current and plans a new next one after it", () => {
    const sprints = [
      sprint("1", "completed", "2026-09-28/2026-10-11"),
      sprint("2", "current", "2026-10-12/2026-10-25"),
      sprint("3", "next", "2026-10-26/2026-11-08"),
    ];
    const plan = planSprintCompletion(sprints, config, options)!;
    expect(plan.completed.id).toBe("2");
    expect(plan.current).toEqual({ row: sprints[2] });
    expect(plan.next).toEqual({ create: { id: expect.any(String), title: "Sprint 4", dates: "2026-11-09/2026-11-22" } });
  });

  it("takes the first future sprint as next before making a new one", () => {
    const sprints = [
      sprint("1", "current", "2026-10-12/2026-10-25"),
      sprint("5", "future", "2026-11-23/2026-12-06"),
      sprint("4", "future", "2026-11-09/2026-11-22"),
      sprint("3", "next", "2026-10-26/2026-11-08"),
    ];
    const plan = planSprintCompletion(sprints, config, options)!;
    expect(plan.current).toEqual({ row: sprints[3] });
    expect(plan.next).toEqual({ row: sprints[2] });
  });

  it("makes a future sprint current when none is next, and a new one right after the completed one when none waits", () => {
    const future = [sprint("1", "current", "2026-10-12/2026-10-25"), sprint("2", "future", "2026-11-02/2026-11-15")];
    expect(planSprintCompletion(future, config, options)!.current).toEqual({ row: future[1] });

    const alone = [sprint("7", "current", "2026-10-12/2026-10-25")];
    const plan = planSprintCompletion(alone, config, options)!;
    expect(plan.current).toEqual({ create: { id: expect.any(String), title: "Sprint 8", dates: "2026-10-26/2026-11-08" } });
    expect(plan.next).toEqual({ create: { id: expect.any(String), title: "Sprint 9", dates: "2026-11-09/2026-11-22" } });
    if ("create" in plan.current && "create" in plan.next) expect(plan.current.create.id).not.toBe(plan.next.create.id);
  });

  it("completes the earliest of several current sprints", () => {
    const sprints = [sprint("b", "current", "2026-10-19/2026-11-01"), sprint("a", "current", "2026-10-12/2026-10-25"), sprint("c", "next")];
    const plan = planSprintCompletion(sprints, config, options)!;
    expect(plan.completed.id).toBe("a");
    // The other current sprint isn't next: it stays as it is.
    expect(plan.current).toEqual({ row: sprints[2] });
  });

  it("starts from today after a sprint without dates", () => {
    const plan = planSprintCompletion([sprint("1", "current")], config, options)!;
    expect(plan.current).toEqual({ create: { id: expect.any(String), title: "Sprint 2", dates: "2026-10-24/2026-11-06" } });
  });

  it("does nothing without a current sprint", () => {
    expect(planSprintCompletion([sprint("1", "next"), sprint("2", null)], config, options)).toBeNull();
  });
});

describe("sprint order and states", () => {
  it("orders sprints by their first day, those without dates last, then by position", () => {
    const rows = [sprint("x", null, undefined, 1), sprint("y", null, "2026-11-01/2026-11-07"), sprint("z", null, undefined, 0), sprint("w", null, "2026-10-01")];
    expect(sortSprints(rows, config).map((r) => r.id)).toEqual(["w", "y", "z", "x"]);
  });

  it("reads a sprint's state by its option", () => {
    expect(sprintStateOf(sprint("1", "future"), config)).toBe("future");
    expect(sprintStateOf({ id: "2", title: "", properties: { state: "other" } }, config)).toBeNull();
  });
});

describe("tasksToMove", () => {
  const tasks = [
    { id: "t1", properties: { sprint: ["s1"], status: "todo" } },
    { id: "t2", properties: { sprint: ["s1"], status: "done" } },
    { id: "t3", properties: { sprint: ["s0"], status: "todo" } },
    { id: "t4", properties: { status: "todo" } },
    { id: "t5", properties: { sprint: ["s1", "s2", "x"], status: "doing" } },
  ];
  const isDone = (task: (typeof tasks)[number]) => task.properties.status === "done";

  it("moves the unfinished tasks of the completed sprint to the new current one", () => {
    const moves = tasksToMove(tasks, "sprint", "s1", "s2", isDone);
    expect(moves.map((m) => [m.task.id, m.sprints])).toEqual([
      ["t1", ["s2"]],
      ["t5", ["s2", "x"]],
    ]);
  });
});

describe("telling the two databases apart", () => {
  const relation = (id: string, databaseId: string, options: PropertyOptions["relation"]) => ({
    id,
    databaseId,
    type: "relation",
    options: { relation: options },
  });

  it("finds the sprint property of a task database", () => {
    const sprintProp = relation("p1", "tasks", { databaseId: "sprints", pairedPropertyId: "p2", role: "sprint", sprints: config });
    expect(sprintProperty([relation("p0", "tasks", { databaseId: "other" }), sprintProp])).toBe(sprintProp);
    // Turned off: the config stays, the role goes.
    expect(sprintProperty([relation("p1", "tasks", { databaseId: "sprints", sprints: config })])).toBeNull();
    // A relation of the database with itself never holds sprints.
    expect(sprintProperty([relation("p1", "tasks", { databaseId: "tasks", role: "sprint", sprints: config })])).toBeNull();
  });

  it("knows a sprints database by the property its relation pairs with", () => {
    const tasksSide = relation("p1", "tasks", { databaseId: "sprints", pairedPropertyId: "p2", role: "sprint", sprints: config });
    const sprintsSide = relation("p2", "sprints", { databaseId: "tasks", pairedPropertyId: "p1" });
    expect(holdsSprints([sprintsSide], { p2: { properties: [tasksSide] } })).toBe(true);
    expect(holdsSprints([sprintsSide], { p2: { properties: [{ ...tasksSide, options: { relation: { databaseId: "sprints" } } }] } })).toBe(false);
    expect(holdsSprints([sprintsSide], {})).toBe(false);
  });
});
