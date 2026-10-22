import { describe, expect, it } from "vitest";
import { galleryAutomations } from "@/lib/automation-gallery";
import { actionsInput, defaultSchedule, draftProblem, newAction, toDraft, type Automation, type Draft, type DraftAction } from "./automations-shared";
import type { Property } from "./types";

const props = [
  { id: "stage", name: "Stage", type: "status", options: { options: [{ id: "review", name: "In review", color: "gray" }, { id: "won", name: "Won", color: "green" }] } },
  { id: "owner", name: "Owner", type: "person", options: {} },
] as unknown as Property[];

const draftWith = (action: DraftAction, trigger: Draft["trigger"] = { type: "row_created" }): Draft => ({ name: "Ask", enabled: true, trigger, actions: [action] });
const problem = (draft: Draft) => draftProblem(draft, props, () => undefined, "db")?.problem ?? null;

describe("an approval step as edited", () => {
  const fresh = () => newAction("approval", [], { type: "row_created" }, "db") as Extract<DraftAction, { type: "approval" }>;

  it("starts asking nobody, for 30 days, stopping without an answer", () => {
    expect(fresh()).toMatchObject({ id: "approval", type: "approval", people: [], properties: [], message: "", timeoutDays: "30", onTimeout: "stop" });
  });

  it("needs someone to ask and 1 to 30 days", () => {
    expect(problem(draftWith(fresh()))).toBe("needApprovers");
    expect(problem(draftWith({ ...fresh(), people: ["u1"] }))).toBeNull();
    expect(problem(draftWith({ ...fresh(), properties: ["owner"] }))).toBeNull();
    for (const days of ["0", "31", "2.5", ""]) expect(problem(draftWith({ ...fresh(), people: ["u1"], timeoutDays: days }))).toBe("needTimeout");
    expect(problem(draftWith({ ...fresh(), people: ["u1"], message: "Close {{trigger[}}?" }))).toBe("badTemplate");
  });

  it("can't ask a row's people when the automation has no row", () => {
    const schedule: Draft["trigger"] = { type: "schedule", schedule: defaultSchedule() };
    expect(problem(draftWith({ ...fresh(), properties: ["owner"] }, schedule))).toBe("needForEach");
    expect(problem(draftWith({ ...fresh(), people: ["u1"] }, schedule))).toBeNull();
  });

  it("is saved with its settings", () => {
    const action: DraftAction = { ...fresh(), people: ["u1"], properties: ["owner"], message: " Close {{trigger.title}}? ", timeoutDays: "7", onTimeout: "continue" };
    const [input] = actionsInput(draftWith(action), props, () => undefined, "db");
    expect(input).toEqual({ id: "approval", type: "approval", people: ["u1"], properties: ["owner"], message: "Close {{trigger.title}}?", timeoutDays: 7, onTimeout: "continue" });
  });
});

describe("the approval template", () => {
  it("makes a draft ready to save once it has its message", () => {
    const [item] = galleryAutomations(props);
    const actions = item.actions.map((a) => (a.type === "approval" ? { ...a, message: "Can {{trigger.title}} be closed?" } : a));
    const draft = toDraft({ name: "Ask before closing", enabled: true, trigger: item.trigger, actions, draft: null } as unknown as Automation, props);
    expect(draft.actions.map((a) => a.type)).toEqual(["approval", "set_properties"]);
    expect(problem(draft)).toBeNull();
  });
});
