import { describe, expect, it } from "vitest";
import { cleanRowButtonOptions, MAX_ROW_BUTTON_LABEL, rowButtonColor, rowButtonLabel } from "./row-buttons";

describe("cleanRowButtonOptions", () => {
  it("keeps a one-line label and a palette color", () => {
    expect(cleanRowButtonOptions({ label: "  Mark\n  done ", color: "green" })).toEqual({ label: "Mark done", color: "green" });
    expect(cleanRowButtonOptions({ label: "x".repeat(MAX_ROW_BUTTON_LABEL + 5) }).label).toHaveLength(MAX_ROW_BUTTON_LABEL);
  });

  it("drops what isn't a label or a known color", () => {
    expect(cleanRowButtonOptions({ label: "   ", color: "teal", icon: "x" })).toEqual({});
    expect(cleanRowButtonOptions({ label: 3, color: null })).toEqual({});
    expect(cleanRowButtonOptions(null)).toEqual({});
    expect(cleanRowButtonOptions(["green"])).toEqual({});
  });
});

describe("rowButtonLabel and rowButtonColor", () => {
  it("fall back to the property's name and the plain button", () => {
    expect(rowButtonLabel({ name: "Finish", options: {} })).toBe("Finish");
    expect(rowButtonLabel({ name: "Finish", options: { button: { label: "Mark done" } } })).toBe("Mark done");
    expect(rowButtonColor({ options: {} })).toBeNull();
    expect(rowButtonColor({ options: { button: { color: "red" } } })).toBe("red");
  });
});
