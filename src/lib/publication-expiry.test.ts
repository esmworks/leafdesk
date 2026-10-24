import { describe, expect, it } from "vitest";
import { MAX_EXPIRY_MS, parseExpiry } from "./publication-expiry";

const now = new Date("2026-10-24T10:00:00Z");

describe("parseExpiry", () => {
  it("takes null and a time ahead", () => {
    expect(parseExpiry(null, now)).toEqual({ at: null });
    expect(parseExpiry("2026-10-25T10:00:00Z", now)).toEqual({ at: new Date("2026-10-25T10:00:00Z") });
    expect(parseExpiry(new Date(now.getTime() + MAX_EXPIRY_MS).toISOString(), now)).toHaveProperty("at");
  });

  it("refuses the past, now, and too far ahead", () => {
    expect(parseExpiry("2026-10-24T09:59:59Z", now)).toEqual({ problem: "expiryPast" });
    expect(parseExpiry(now.toISOString(), now)).toEqual({ problem: "expiryPast" });
    expect(parseExpiry(new Date(now.getTime() + MAX_EXPIRY_MS + 1).toISOString(), now)).toEqual({ problem: "expiryTooFar" });
  });

  it("refuses what isn't a time", () => {
    for (const junk of [undefined, "", "soon", 1_800_000_000_000, {}, "2".repeat(65)]) {
      expect(parseExpiry(junk, now)).toEqual({ problem: "expiryInvalid" });
    }
  });
});
