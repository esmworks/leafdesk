import { describe, expect, it } from "vitest";
import type { ViewConfig } from "@/db/schema/app";
import { layoutConfigError, LINKED_VIEW_TYPES, openRowsOf, opensRows, VIEW_TYPES, viewDateProperty, withViewSorts } from "./views";

describe("feed views", () => {
  it("are linked views and open rows like the other views of rows", () => {
    expect(VIEW_TYPES).toContain("feed");
    expect(LINKED_VIEW_TYPES).toContain("feed");
    expect(opensRows("feed")).toBe(true);
  });

  it("list the newest post first while the view sorts by nothing", () => {
    expect(withViewSorts({ type: "feed", config: {} as ViewConfig }).sorts).toEqual([{ propertyId: "created_at", direction: "desc" }]);
    expect(withViewSorts({ type: "feed", config: { sorts: [] } }).sorts).toEqual([{ propertyId: "created_at", direction: "desc" }]);
  });

  it("keep the view's own sorts, and leave other views as they are", () => {
    const sorts = [{ propertyId: "due", direction: "asc" as const }];
    expect(withViewSorts({ type: "feed", config: { sorts } }).sorts).toBe(sorts);
    const config: ViewConfig = {};
    expect(withViewSorts({ type: "list", config })).toBe(config);
  });
});

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
    expect(VIEW_TYPES.filter(opensRows)).toEqual(["table", "board", "calendar", "gallery", "list", "feed", "timeline", "map"]);
  });

  it("refuses anything but panel or page", () => {
    expect(layoutConfigError({ openRows: "page" })).toBeNull();
    expect(layoutConfigError({ openRows: "panel" })).toBeNull();
    expect(layoutConfigError({ openRows: "tab" } as unknown as ViewConfig)).toBe("openRows must be one of: panel, page");
  });
});

describe("table lines and a view's own row template", () => {
  it("takes vertical lines on or off", () => {
    expect(layoutConfigError({ showVerticalLines: false })).toBeNull();
    expect(layoutConfigError({ showVerticalLines: "no" } as unknown as ViewConfig)).toBe("showVerticalLines must be true or false");
  });

  it("takes a template id, or null for blank rows", () => {
    expect(layoutConfigError({ defaultTemplateId: "tpl-1" })).toBeNull();
    expect(layoutConfigError({ defaultTemplateId: null })).toBeNull();
    expect(layoutConfigError({ defaultTemplateId: "" })).toMatch(/defaultTemplateId/);
    expect(layoutConfigError({ defaultTemplateId: 3 } as unknown as ViewConfig)).toMatch(/defaultTemplateId/);
  });
});

describe("wrapping card values", () => {
  it("is on or off, and off when missing", () => {
    expect(layoutConfigError({ wrapProperties: true })).toBeNull();
    expect(layoutConfigError({ wrapProperties: false })).toBeNull();
    expect(layoutConfigError({})).toBeNull();
    expect(layoutConfigError({ wrapProperties: "yes" } as unknown as ViewConfig)).toBe("wrapProperties must be true or false");
  });

  it("is checked in a dashboard's widgets too", () => {
    const widget = { id: "w1", span: 2, view: { type: "board", config: { wrapProperties: 1 } } };
    expect(layoutConfigError({ widgets: [widget] } as unknown as ViewConfig)).toBe('Widget "w1": wrapProperties must be true or false');
  });
});
