import { describe, expect, it } from "vitest";
import type { ViewConfig } from "@/db/schema/app";
import { layoutConfigError, openRowsOf, opensRows, VIEW_TYPES, viewDateProperty } from "./views";

const props = [
  { id: "created", type: "created_time" },
  { id: "due", type: "date" },
  { id: "start", type: "date" },
];
const timeline = (p: { type: string }) => p.type === "date" || p.type === "created_time";

describe("viewDateProperty", () => {
  it("takes the property the view names, else the first date", () => {
    expect(viewDateProperty({ dateBy: "start" }, props)?.id).toBe("start");
    expect(viewDateProperty({}, props)?.id).toBe("due");
    expect(viewDateProperty({ dateBy: "gone" }, props)?.id).toBe("due");
  });

  it("names only what the view accepts: a calendar no created time, a timeline one", () => {
    expect(viewDateProperty({ dateBy: "created" }, props)?.id).toBe("due");
    expect(viewDateProperty({ dateBy: "created" }, props, timeline)?.id).toBe("created");
    expect(viewDateProperty({}, props, timeline)?.id).toBe("due");
  });
});

describe("where a view opens its rows", () => {
  it("opens them beside the view unless set to open pages, so views saved before the setting open the panel", () => {
    expect(openRowsOf({})).toBe("panel");
    expect(openRowsOf({ openRows: "panel" })).toBe("panel");
    expect(openRowsOf({ openRows: "page" })).toBe("page");
    expect(openRowsOf({ openRows: "sideways" } as unknown as ViewConfig)).toBe("panel");
  });

  it("is a setting of every view with rows to open: not forms or charts", () => {
    expect(VIEW_TYPES.filter(opensRows)).toEqual(["table", "board", "calendar", "gallery", "list", "timeline", "map"]);
  });

  it("refuses anything but panel or page", () => {
    expect(layoutConfigError({ openRows: "page" })).toBeNull();
    expect(layoutConfigError({ openRows: "panel" })).toBeNull();
    expect(layoutConfigError({ openRows: "tab" } as unknown as ViewConfig)).toBe("openRows must be one of: panel, page");
  });
});
