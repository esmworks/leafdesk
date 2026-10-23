import { describe, expect, it } from "vitest";
import { badTemplates, formatPath, idsOf, parsePath, resolveText, resolveValue, templateFor, templateRoots, textOf } from "./automation-templates";

const scope = {
  trigger: {
    title: "Order 12",
    Amount: 40,
    "Due date": "2026-10-30",
    Owner: { id: "u1", name: "Ayşe" },
    Tags: ["a", "b"],
    changes: { Status: { before: "New", after: "Done" } },
  },
  find: { count: 2, rows: [{ id: "r1", title: "One" }, { id: "r2", title: "Two" }] },
  http: { status: 200, body: { customer: { "e-mail": "x@example.test" }, ok: true } },
};

describe("parsePath and formatPath", () => {
  it("reads dots, spaces, positions and quoted names", () => {
    expect(parsePath("trigger.Due date")).toEqual({ root: "trigger", path: ["Due date"] });
    expect(parsePath("find.rows[0].title")).toEqual({ root: "find", path: ["rows", 0, "title"] });
    expect(parsePath('http.body.customer["e-mail"]')).toEqual({ root: "http", path: ["body", "customer", "e-mail"] });
    expect(parsePath("trigger.")).toBeNull();
    expect(parsePath("trigger[x]")).toBeNull();
  });
  it("writes back what it reads", () => {
    for (const path of [["Due date"], ["rows", 0, "title"], ["customer", "e-mail"], ["a.b"]]) {
      expect(parsePath(formatPath("trigger", path))).toEqual({ root: "trigger", path });
    }
    expect(templateFor("find", ["count"])).toBe("{{find.count}}");
  });
});

describe("resolveText", () => {
  it("writes values as text and reports missing paths as empty", () => {
    const out = resolveText("{{trigger.title}}: {{trigger.Owner}} {{trigger.Tags}} {{find.count}} {{trigger.Nope}}!", scope);
    expect(out.value).toBe("Order 12: Ayşe a, b 2 !");
    expect(out.missing).toEqual(["trigger.Nope"]);
  });
  it("reads before and after of a change and is case-insensitive", () => {
    expect(resolveText("{{trigger.changes.status.before}}→{{trigger.changes.Status.after}}", scope).value).toBe("New→Done");
  });
  it("reaches quoted names in a step's output", () => {
    expect(resolveText('{{http.body.customer["e-mail"]}}', scope).value).toBe("x@example.test");
  });
});

describe("resolveValue", () => {
  it("keeps a whole template's type", () => {
    expect(resolveValue("{{trigger.Amount}}", scope).value).toBe(40);
    expect(resolveValue("{{http.body.ok}}", scope).value).toBe(true);
    expect(resolveValue("{{find.rows}}", scope).value).toEqual(scope.find.rows);
  });
  it("gives null for a whole template that leads nowhere", () => {
    const missing: string[] = [];
    expect(resolveValue("{{find.rows.5.id}}", scope, missing).value).toBeNull();
    expect(missing).toEqual(["find.rows.5.id"]);
  });
  it("resolves inside objects and lists", () => {
    expect(resolveValue({ a: ["{{find.count}}", "n={{find.count}}"] }, scope).value).toEqual({ a: [2, "n=2"] });
  });
});

describe("an approval's output", () => {
  const approved = { approval: { approved: true, approved_by: { id: "u2", name: "Deniz" }, answered_at: "2026-10-22T09:30:00.000Z" } };
  it("writes who approved by name, and their id where people are set", () => {
    expect(resolveText("Approved by {{approval.approved_by}} at {{approval.answered_at}}", approved).value).toBe(
      "Approved by Deniz at 2026-10-22T09:30:00.000Z",
    );
    expect(idsOf(resolveValue("{{approval.approved_by}}", approved).value)).toEqual(["u2"]);
  });
  it("is empty in a test run, which asks nobody", () => {
    const test = { approval: { approved: null, approved_by: null, answered_at: null } };
    expect(resolveText("by {{approval.approved_by}}", test)).toEqual({ value: "by ", missing: [] });
  });
});

describe("helpers", () => {
  it("finds roots and bad templates", () => {
    expect([...templateRoots({ x: "{{trigger.a}} {{find.b}}" })].sort()).toEqual(["find", "trigger"]);
    expect(badTemplates("{{trigger[}} {{ok.path}}")).toEqual(["{{trigger[}}"]);
  });
  it("turns rows and people into ids", () => {
    expect(idsOf(scope.find.rows)).toEqual(["r1", "r2"]);
    expect(idsOf(scope.trigger.Owner)).toEqual(["u1"]);
    expect(idsOf("a, b")).toEqual(["a", "b"]);
    expect(idsOf(null)).toEqual([]);
  });
  it("writes objects as JSON", () => {
    expect(textOf({ x: 1 })).toBe('{"x":1}');
    expect(textOf(null)).toBe("");
  });
});
