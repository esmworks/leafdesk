import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { presentationText } from "./pptx";
import { deck, run, slideXml } from "./pptx-fixtures";

const LIMITS = { chars: 200_000, unpackedBytes: 64 * 1024 * 1024 };

describe("presentationText", () => {
  it("reads the slides in the presentation's order, a paragraph a line, with their notes", () => {
    const bytes = deck({
      order: [2, 1],
      slides: {
        1: slideXml("sld", [run("Second")]),
        2: slideXml("sld", [run("Plan &amp; budget")], [run("Q3 ") + run("goals"), "", `${run("one")}<a:br/>${run("two")}`]),
      },
      notes: { 2: slideXml("notes", [`<a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld>`], [run("Say hello")]) },
    });
    expect(presentationText(bytes, LIMITS)).toEqual({
      slides: [
        { text: "Plan & budget\nQ3 goals\none\ntwo", notes: "Say hello" },
        { text: "Second", notes: "" },
      ],
      total: 2,
      partial: false,
    });
  });

  it("leaves out fields such as the slide number", () => {
    const bytes = deck({ order: [1], slides: { 1: slideXml("sld", [`${run("Page ")}<a:fld id="{2}" type="slidenum"><a:t>7</a:t></a:fld>`]) } });
    expect(presentationText(bytes, LIMITS).slides).toEqual([{ text: "Page", notes: "" }]);
  });

  it("falls back to the slides' part numbers when the list names none", () => {
    const bytes = deck({ order: [], slides: { 10: slideXml("sld", [run("Ten")]), 2: slideXml("sld", [run("Two")]) } });
    expect(presentationText(bytes, LIMITS).slides.map((s) => s.text)).toEqual(["Two", "Ten"]);
  });

  it("stops once there's text enough, and says slides were left out", () => {
    const bytes = deck({ order: [1, 2, 3], slides: { 1: slideXml("sld", [run("x".repeat(30))]), 2: slideXml("sld", [run("y")]), 3: slideXml("sld", [run("z")]) } });
    expect(presentationText(bytes, { ...LIMITS, chars: 10 })).toMatchObject({ slides: [{ text: "x".repeat(30) }], total: 3, partial: true });
  });

  it("refuses what isn't a presentation, and parts that unpack past the budget", () => {
    expect(() => presentationText(strToU8("not a zip"), LIMITS)).toThrow();
    expect(() => presentationText(zipSync({ "a.txt": strToU8("hi") }), LIMITS)).toThrow();
    const big = deck({ order: [1], slides: { 1: slideXml("sld", [run("x".repeat(5000))]) } });
    expect(() => presentationText(big, { ...LIMITS, unpackedBytes: 2000 })).toThrow();
  });
});
