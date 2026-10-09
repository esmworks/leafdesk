import { describe, expect, it } from "vitest";
import { viewDateProperty } from "./views";

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
