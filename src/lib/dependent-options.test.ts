import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import {
  availableOptions,
  cleanParentOptions,
  dependencyProblem,
  dependentsOf,
  fitsParent,
  followDependencies,
  parentOf,
  withoutParentOptions,
} from "./dependent-options";

type P = { id: string; name: string; type: PropertyType; options: PropertyOptions };

const country: P = {
  id: "country",
  name: "Country",
  type: "select",
  options: {
    options: [
      { id: "tr", name: "Türkiye", color: "red" },
      { id: "de", name: "Germany", color: "yellow" },
    ],
  },
};
const city: P = {
  id: "city",
  name: "City",
  type: "select",
  options: {
    dependsOn: "country",
    options: [
      { id: "ist", name: "Istanbul", color: "blue", parentOptionIds: ["tr"] },
      { id: "ber", name: "Berlin", color: "blue", parentOptionIds: ["de"] },
      { id: "other", name: "Other", color: "gray" },
    ],
  },
};
const district: P = {
  id: "district",
  name: "District",
  type: "multi_select",
  options: {
    dependsOn: "city",
    options: [
      { id: "kad", name: "Kadıköy", color: "green", parentOptionIds: ["ist"] },
      { id: "bes", name: "Beşiktaş", color: "green", parentOptionIds: ["ist"] },
      { id: "mit", name: "Mitte", color: "green", parentOptionIds: ["ber"] },
      { id: "any", name: "Anywhere", color: "gray" },
    ],
  },
};
const props = [country, city, district];

describe("dependent selects", () => {
  it("finds the parent only while the dependency holds", () => {
    expect(parentOf(city, props)?.id).toBe("country");
    expect(parentOf(city, [city])).toBeNull();
    expect(parentOf(city, [{ ...country, type: "text" }, city])).toBeNull();
    expect(parentOf({ ...city, options: { ...city.options, dependsOn: "city" } }, props)).toBeNull();
    expect(parentOf({ ...city, type: "status" }, props)).toBeNull();
    expect(dependentsOf("country", props).map((p) => p.id)).toEqual(["city"]);
  });

  it("offers the options that fit the row's parent value", () => {
    expect(fitsParent({ parentOptionIds: [] }, null)).toBe(true);
    expect(fitsParent({ parentOptionIds: ["tr"] }, null)).toBe(false);
    expect(availableOptions(city, props, { country: "tr" }).map((o) => o.id)).toEqual(["ist", "other"]);
    expect(availableOptions(city, props, {}).map((o) => o.id)).toEqual(["other"]);
    expect(availableOptions(country, props, {}).map((o) => o.id)).toEqual(["tr", "de"]);
  });

  it("refuses an option the write adds that doesn't fit", () => {
    const out = followDependencies(props, { country: "de" }, { city: "ist" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.prop.id).toBe("city");
      expect(out.option.name).toBe("Istanbul");
      expect(out.parentValue?.name).toBe("Germany");
    }
    expect(followDependencies(props, { country: "tr" }, { city: "ist" })).toEqual({ ok: true, follow: {} });
    expect(followDependencies(props, {}, { country: "tr", city: "ist" })).toEqual({ ok: true, follow: {} });
  });

  it("keeps what a row already held while its parent stays", () => {
    // Set before the options were sorted out: a write elsewhere doesn't clear or refuse it.
    expect(followDependencies(props, { country: "de", city: "ist" }, { city: "ist" })).toEqual({ ok: true, follow: {} });
    expect(followDependencies(props, { country: "de", city: "ist" }, { other: 1 })).toEqual({ ok: true, follow: {} });
  });

  it("clears values a parent change makes unfit, down the chain", () => {
    const before = { country: "tr", city: "ist", district: ["kad", "any"] };
    expect(followDependencies(props, before, { country: "de" })).toEqual({
      ok: true,
      follow: { city: null, district: ["any"] },
    });
    expect(followDependencies(props, before, { country: null })).toEqual({ ok: true, follow: { city: null, district: ["any"] } });
    expect(followDependencies(props, { country: "tr", city: "other" }, { country: "de" })).toEqual({ ok: true, follow: {} });
    expect(followDependencies(props, { country: "de", city: "ist", district: ["kad"] }, { city: "ber" })).toEqual({
      ok: true,
      follow: { district: null },
    });
  });

  it("refuses dependencies that can't hold", () => {
    expect(dependencyProblem(city, "country", props)).toBeNull();
    expect(dependencyProblem(country, "district", props)).toBe("notParent");
    expect(dependencyProblem(country, "city", props)).toBe("loop");
    expect(dependencyProblem({ ...country, type: "text" }, "city", props)).toBe("notDependent");
    expect(dependencyProblem(city, "city", props)).toBe("notParent");
    expect(dependencyProblem(city, "missing", props)).toBe("notParent");
  });

  it("stores only parent ids that exist, once each", () => {
    const cleaned = cleanParentOptions(
      [
        { id: "a", name: "A", color: "gray", parentOptionIds: ["tr", "tr", "gone"] },
        { id: "b", name: "B", color: "gray", parentOptionIds: ["gone"] },
      ],
      country,
    );
    expect(cleaned).toEqual([
      { id: "a", name: "A", color: "gray", parentOptionIds: ["tr"] },
      { id: "b", name: "B", color: "gray" },
    ]);
    expect(cleanParentOptions(city.options.options!, null).every((o) => !("parentOptionIds" in o))).toBe(true);
    expect(withoutParentOptions(city.options.options!).some((o) => "parentOptionIds" in o)).toBe(false);
  });
});
