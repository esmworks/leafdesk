import { describe, expect, it } from "vitest";
import { dateMarker, namesMe, resolveMarkers } from "./template-values";

const types = { who: "person", due: "date", at: "date", name: "text" };
// 23:30 UTC on 24 October: already the 25th in Auckland, still the 24th in Los Angeles.
const now = new Date("2026-10-24T23:30:00.000Z");

describe("template markers", () => {
  it("reads date markers whatever their case", () => {
    expect(dateMarker("today")).toBe("today");
    expect(dateMarker(" NOW ")).toBe("now");
    expect(dateMarker("2026-10-24")).toBeNull();
    expect(dateMarker(null)).toBeNull();
    expect(namesMe(["u1", "me"])).toBe(true);
    expect(namesMe("me")).toBe(false);
  });

  it("works out today in the maker's time zone", () => {
    const values = { due: "today" };
    expect(resolveMarkers(values, types, { userId: "u1", now, timeZone: "Pacific/Auckland" })).toEqual({ due: "2026-10-25" });
    expect(resolveMarkers(values, types, { userId: "u1", now, timeZone: "America/Los_Angeles" })).toEqual({ due: "2026-10-24" });
    expect(resolveMarkers(values, types, { userId: "u1", now, timeZone: "Europe/Istanbul" })).toEqual({ due: "2026-10-25" });
    // Unknown or missing zones count in UTC.
    expect(resolveMarkers(values, types, { userId: "u1", now, timeZone: "Mars/Olympus" })).toEqual({ due: "2026-10-24" });
    expect(resolveMarkers(values, types, { userId: "u1", now })).toEqual({ due: "2026-10-24" });
  });

  it("makes now the moment, as a time", () => {
    expect(resolveMarkers({ at: "now" }, types, { userId: "u1", now, timeZone: "Asia/Tokyo" })).toEqual({ at: "2026-10-24T23:30:00.000Z" });
  });

  it("puts the person in place of me, once", () => {
    expect(resolveMarkers({ who: ["me", "u2"] }, types, { userId: "u1", now })).toEqual({ who: ["u1", "u2"] });
    expect(resolveMarkers({ who: ["u1", "me"] }, types, { userId: "u1", now })).toEqual({ who: ["u1"] });
  });

  it("names no one for an agent, clearing a property left empty", () => {
    expect(resolveMarkers({ who: ["me", "u2"] }, types, { userId: null, now })).toEqual({ who: ["u2"] });
    expect(resolveMarkers({ who: ["me"], name: "x" }, types, { userId: null, now })).toEqual({ name: "x" });
  });

  it("leaves other values alone and returns the same object without markers", () => {
    const values = { who: ["u2"], due: "2026-01-01", name: "today" };
    expect(resolveMarkers(values, types, { userId: "u1", now })).toBe(values);
  });
});
