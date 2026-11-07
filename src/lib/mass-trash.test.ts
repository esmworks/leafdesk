import { describe, expect, it } from "vitest";
import { massTrashMessage, parseMassTrash } from "./mass-trash";

describe("mass trash messages", () => {
  it("reads back what it writes", () => {
    expect(parseMassTrash(massTrashMessage({ what: "rows", count: 57 }))).toEqual({ what: "rows", count: 57 });
    expect(parseMassTrash(massTrashMessage({ what: "database", count: 350 }))).toEqual({ what: "database", count: 350 });
  });

  it("refuses anything else", () => {
    expect(parseMassTrash(null)).toBeNull();
    expect(parseMassTrash("rows:")).toBeNull();
    expect(parseMassTrash("pages:3")).toBeNull();
    expect(parseMassTrash("rows:12 more")).toBeNull();
  });
});
