import { describe, expect, it } from "vitest";
import { massExportMessage, massExportPath, parseMassExport } from "./mass-export";

describe("pages exported in bulk", () => {
  it("writes and reads the notice's message", () => {
    const message = massExportMessage({ count: 24, actorId: "u_Ab-3" });
    expect(message).toBe("pages:24:u_Ab-3");
    expect(parseMassExport(message)).toEqual({ count: 24, actorId: "u_Ab-3" });
  });

  it("reads nothing else", () => {
    expect(parseMassExport("rows:24")).toBeNull();
    expect(parseMassExport("pages:24")).toBeNull();
    expect(parseMassExport("pages:x:u1")).toBeNull();
    expect(parseMassExport(null)).toBeNull();
  });

  it("opens the audit log at that person's exports", () => {
    expect(massExportPath("ws", { count: 20, actorId: "u1" })).toBe("/w/ws/settings?tab=audit&category=exports&actor=u%3Au1");
    expect(massExportPath("ws", null)).toBe("/w/ws/settings?tab=audit&category=exports");
  });
});
