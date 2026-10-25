import { describe, expect, it } from "vitest";
import { canSwitchLayout, layoutDefaults } from "./view-layouts";

const props = [
  { id: "n", type: "number" as const },
  { id: "s", type: "status" as const },
  { id: "d", type: "date" as const },
  { id: "p", type: "place" as const },
];

describe("canSwitchLayout", () => {
  it("switches between the layouts that show rows", () => {
    expect(canSwitchLayout("table", "board")).toBe(true);
    expect(canSwitchLayout("map", "feed")).toBe(true);
  });

  it("keeps forms, dashboards and charts as they were made", () => {
    expect(canSwitchLayout("table", "form")).toBe(false);
    expect(canSwitchLayout("dashboard", "table")).toBe(false);
    expect(canSwitchLayout("table", "chart")).toBe(false);
  });
});

describe("layoutDefaults", () => {
  it("places a view by the first property that fits", () => {
    expect(layoutDefaults("board", props, {})).toEqual({ groupBy: "s" });
    expect(layoutDefaults("calendar", props, {})).toEqual({ dateBy: "d" });
    expect(layoutDefaults("timeline", props, {})).toEqual({ dateBy: "d" });
    expect(layoutDefaults("map", props, {})).toEqual({ placeBy: "p" });
    expect(layoutDefaults("chart", props, {})).toEqual({ groupBy: "s" });
    expect(layoutDefaults("table", props, {})).toEqual({});
  });

  it("keeps what the view already says", () => {
    expect(layoutDefaults("board", props, { groupBy: "x" })).toEqual({});
    expect(layoutDefaults("calendar", props, { dateBy: "x" })).toEqual({});
    expect(layoutDefaults("map", props, { placeBy: "x" })).toEqual({});
  });

  it("leaves a setting empty without a property for it", () => {
    expect(layoutDefaults("map", [], {})).toEqual({ placeBy: undefined });
  });
});
