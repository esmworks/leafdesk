import { describe, expect, it } from "vitest";
import type { PropertyType } from "./property-types";
import { foldSearchText, rowSearchText, searchRows } from "./row-search";

const prop = (id: string, type: PropertyType, options: { id: string; name: string }[] = []) => ({ id, type, options: { options } });

const props = [
  prop("notes", "text"),
  prop("budget", "number"),
  prop("status", "status", [{ id: "s1", name: "In progress" }]),
  prop("tags", "multi_select", [
    { id: "t1", name: "Urgent" },
    { id: "t2", name: "Backend" },
  ]),
  prop("owner", "person"),
  prop("by", "created_by"),
  prop("client", "relation"),
  prop("steps", "checklist"),
  prop("files", "files"),
  prop("score", "formula"),
  prop("due", "date"),
  prop("done", "checkbox"),
];

const row = (id: string, title: string, properties: Record<string, unknown>) => ({
  id,
  title,
  properties,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const rows = [
  row("a", "Launch plan", {
    notes: "Ship the İstanbul office first",
    budget: 1250,
    status: "s1",
    tags: ["t1", "t2"],
    owner: ["u1"],
    by: ["u2"],
    client: ["c1"],
    steps: [{ id: "x", text: "Book the venue", checked: false }],
    files: [{ name: "brief.pdf", url: "/api/files/abcdefghijklmnopqrstuvwx", type: "application/pdf" }],
    score: "High",
    due: "2026-10-12",
    done: true,
  }),
  row("b", "Hiring", { notes: "Two engineers", tags: ["t2"], score: { error: { message: "Bad", code: "x" } } }),
  row("c", "Işık tasarımı", {}),
];

const context = {
  people: [
    { id: "u1", name: "Ayşe Yılmaz" },
    { id: "u2", name: "Mert Kaya" },
  ],
  relations: { client: { rows: [{ id: "c1", title: "Acme Corp" }] } },
};

const ids = (query: string) => searchRows(rows, query, props, context).map((r) => r.id);

describe("database view search", () => {
  it("keeps every row for an empty or blank query", () => {
    expect(ids("")).toEqual(["a", "b", "c"]);
    expect(ids("   ")).toEqual(["a", "b", "c"]);
  });

  it("finds rows by title and by what their values show", () => {
    expect(ids("launch")).toEqual(["a"]);
    expect(ids("in progress")).toEqual(["a"]);
    expect(ids("backend")).toEqual(["a", "b"]);
    expect(ids("ayşe")).toEqual(["a"]);
    expect(ids("mert")).toEqual(["a"]);
    expect(ids("acme")).toEqual(["a"]);
    expect(ids("venue")).toEqual(["a"]);
    expect(ids("brief.pdf")).toEqual(["a"]);
    expect(ids("1250")).toEqual(["a"]);
    expect(ids("high")).toEqual(["a"]);
  });

  it("needs every word, in any order, anywhere in the row", () => {
    expect(ids("urgent plan")).toEqual(["a"]);
    expect(ids("engineers urgent")).toEqual([]);
  });

  it("ignores case and accents, and reads ı as i", () => {
    expect(ids("istanbul")).toEqual(["a"]);
    expect(ids("AYSE yilmaz")).toEqual(["a"]);
    expect(ids("isik")).toEqual(["c"]);
    expect(ids("IŞIK")).toEqual(["c"]);
    expect(foldSearchText("İstanbul Işık")).toBe("istanbul isik");
  });

  it("leaves out ids, dates, checkboxes and formula errors", () => {
    const text = rowSearchText(rows[0], props, context);
    expect(text).not.toContain("s1");
    expect(text).not.toContain("u1");
    expect(text).not.toContain("c1");
    expect(text).not.toContain("2026");
    expect(text).not.toContain("true");
    expect(ids("bad")).toEqual([]);
  });

  it("skips people and linked rows it can't name", () => {
    expect(searchRows(rows, "acme", props, {}).map((r) => r.id)).toEqual([]);
    expect(searchRows(rows, "ayşe", props, {}).map((r) => r.id)).toEqual([]);
  });
});
