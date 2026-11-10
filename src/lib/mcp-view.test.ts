import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import type { ViewColumn } from "./mcp-view";
import { viewCell } from "./mcp-view-cells";
import { viewColumn } from "./mcp-view-columns";

const prop = (type: PropertyType, options: PropertyOptions = {}) => ({ name: "P", type, options });
const tr = { locale: "tr", timeZone: "Europe/Istanbul" };
const en = { locale: "en", timeZone: "UTC" };

describe("viewColumn", () => {
  it("draws options in their colors and names of what values point at", () => {
    const options = { options: [{ id: "a", name: "Open", color: "green" }] };
    expect(viewColumn(prop("status", options))).toEqual({ name: "P", kind: "options", colors: { Open: "green" } });
    for (const type of ["person", "relation", "files", "created_by"] as const) expect(viewColumn(prop(type))?.kind).toBe("names");
  });

  it("keeps a number's format, also a formula's, and shows rollup shares as percentages", () => {
    const money = { number: { format: "currency" as const, currency: "TRY" } };
    expect(viewColumn(prop("number", money))).toEqual({ name: "P", kind: "number", format: money.number });
    expect(viewColumn(prop("formula", { formula: { expression: "1", type: "number" }, ...money }))?.format).toEqual(money.number);
    expect(viewColumn(prop("rollup", { rollup: { relationPropertyId: "r", targetPropertyId: "p", function: "percent_checked" } }))?.format).toEqual({ format: "percent" });
    expect(viewColumn(prop("rollup", { rollup: { relationPropertyId: "r", targetPropertyId: "p", function: "show_original" } }))?.kind).toBe("names");
  });

  it("shows formulas by their result and leaves buttons out", () => {
    expect(viewColumn(prop("formula", { formula: { expression: "now()", type: "date" } }))?.kind).toBe("date");
    expect(viewColumn(prop("formula", { formula: { expression: "true", type: "checkbox" } }))?.kind).toBe("checkbox");
    expect(viewColumn(prop("formula", { formula: { expression: "'a'" } }))?.kind).toBe("text");
    expect(viewColumn(prop("button"))).toBeNull();
  });
});

describe("viewCell", () => {
  const column = (kind: ViewColumn["kind"], extra: Partial<ViewColumn> = {}): ViewColumn => ({ name: "P", kind, ...extra });

  it("writes numbers in the reader's language and the property's format", () => {
    expect(viewCell(column("number", { format: { format: "currency", currency: "TRY" } }), 1234.5, tr)).toEqual({ kind: "text", text: "₺1.234,50", number: true });
    expect(viewCell(column("number", { format: { format: "percent" } }), 0.25, en)).toMatchObject({ text: "25%" });
    expect(viewCell(column("number", { format: { format: "duration" } }), 90, en)).toMatchObject({ text: "1:30" });
  });

  it("writes days as days and instants in the reader's zone", () => {
    expect(viewCell(column("date"), "2026-10-12", en)).toEqual({ kind: "text", text: "Oct 12, 2026" });
    expect(viewCell(column("date"), "2026-10-12T09:30:00.000Z", tr)).toMatchObject({ text: expect.stringContaining("12:30") });
  });

  it("turns options and named values into chips", () => {
    const options = column("options", { colors: { Open: "green" } });
    expect(viewCell(options, ["Open", "Other"], en)).toEqual({ kind: "chips", chips: [{ text: "Open", color: "green" }, { text: "Other", color: undefined }] });
    expect(viewCell(column("names"), [{ id: "1", title: "Acme" }, { id: "2", name: "Ada" }], en)).toEqual({
      kind: "chips",
      chips: [{ text: "Acme" }, { text: "Ada" }],
    });
  });

  it("shows checkboxes, checklists, places and failed formulas", () => {
    expect(viewCell(column("checkbox"), true, en)).toEqual({ kind: "check", checked: true });
    expect(viewCell(column("checklist"), [{ text: "a", checked: true }, { text: "b", checked: false }], en)).toMatchObject({ text: "1/2" });
    expect(viewCell(column("text"), { address: "Kadıköy, İstanbul", lat: 41, lng: 29 }, en)).toMatchObject({ text: "Kadıköy, İstanbul" });
    expect(viewCell(column("number"), { error: "Division by zero" }, en)).toMatchObject({ text: "#ERROR" });
  });

  it("shows nothing for empty values", () => {
    expect(viewCell(column("text"), null, en)).toBeNull();
    expect(viewCell(column("text"), "", en)).toBeNull();
    expect(viewCell(column("names"), [], en)).toBeNull();
  });
});
