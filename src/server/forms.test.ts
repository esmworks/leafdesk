import { describe, expect, it, vi } from "vitest";
import type { ResolvedQuestion } from "@/lib/forms";

vi.mock("@/db", () => ({ db: {} }));

const { followAnswers, FormError, takeBytes } = await import("./forms");
const { SlidingWindowLimiter } = await import("@/lib/rate-limit");

describe("takeBytes (public form uploads per IP address)", () => {
  const MIB = 1024 * 1024;

  it("takes uploads while their mebibytes fit the budget, and refuses one that doesn't without taking it", () => {
    const limiter = new SlidingWindowLimiter(10, 60_000);
    expect(takeBytes(limiter, "1.2.3.4", 6 * MIB, 0)).toBe(true);
    expect(takeBytes(limiter, "1.2.3.4", 5 * MIB, 0)).toBe(false);
    expect(limiter.count("1.2.3.4", 0)).toBe(6);
    expect(takeBytes(limiter, "1.2.3.4", 4 * MIB, 0)).toBe(true);
    expect(takeBytes(limiter, "5.6.7.8", 10 * MIB, 0)).toBe(true);
  });

  it("counts a small file as a whole mebibyte, and gives the budget back after the window", () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    expect(takeBytes(limiter, "ip", 10, 0)).toBe(true);
    expect(takeBytes(limiter, "ip", MIB + 1, 0)).toBe(false);
    expect(takeBytes(limiter, "ip", MIB + 1, 60_001)).toBe(true);
  });
});
type Property = import("@/server/databases").DatabaseProperty;

const country = {
  id: "country",
  name: "Country",
  type: "select",
  options: {
    options: [
      { id: "tr", name: "Türkiye", color: "red" },
      { id: "de", name: "Germany", color: "yellow" },
    ],
  },
} as unknown as Property;
const city = {
  id: "city",
  name: "Internal city code",
  type: "select",
  options: {
    dependsOn: "country",
    options: [
      { id: "ist", name: "Istanbul", color: "blue", parentOptionIds: ["tr"] },
      { id: "ber", name: "Berlin", color: "green", parentOptionIds: ["de"] },
    ],
  },
} as unknown as Property;
const question = (prop: Property, label = ""): ResolvedQuestion<Property> => ({ propertyId: prop.id, prop, required: false, label, description: "" });

describe("followAnswers (public forms)", () => {
  it("refuses an answer that doesn't fit the select it depends on, as an answer to its question", () => {
    let caught: unknown;
    try {
      followAnswers([country, city], [question(country), question(city, "City")], {}, { country: "de", city: "ist" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FormError);
    expect((caught as InstanceType<typeof FormError>).answers).toEqual([
      { propertyId: "city", code: "optionUnavailable", params: { value: "Istanbul", property: "City" } },
    ]);
  });

  it("takes answers that fit, over the form's defaults", () => {
    expect(followAnswers([country, city], [question(country), question(city)], { country: "tr" }, { country: "de", city: "ber" })).toEqual({
      country: "de",
      city: "ber",
    });
  });

  it("drops a default that no longer fits the answer it depends on", () => {
    expect(followAnswers([country, city], [question(country)], { city: "ist" }, { country: "de" })).toEqual({ country: "de", city: null });
  });
});
