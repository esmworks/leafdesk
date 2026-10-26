import { describe, expect, it } from "vitest";
import { MAX_VERSION_NAME, unchangedSince, versionName } from "./page-versions";

describe("versionName", () => {
  it("trims a name and makes its whitespace single spaces", () => {
    expect(versionName("  Sent to legal ")).toBe("Sent to legal");
    expect(versionName("Draft\n\n2\tfinal")).toBe("Draft 2 final");
  });

  it("reads an empty name as none, which saves unnamed or clears the name", () => {
    expect(versionName("")).toBeNull();
    expect(versionName("   \n")).toBeNull();
    expect(versionName(null)).toBeNull();
    expect(versionName(undefined)).toBeNull();
  });

  it("refuses what isn't text and names that are too long", () => {
    expect(versionName(42)).toBeUndefined();
    expect(versionName({ name: "x" })).toBeUndefined();
    expect(versionName("a".repeat(MAX_VERSION_NAME))).toBe("a".repeat(MAX_VERSION_NAME));
    expect(versionName("a".repeat(MAX_VERSION_NAME + 1))).toBeUndefined();
  });

  it("counts characters, not UTF-16 units", () => {
    expect(versionName("📄".repeat(MAX_VERSION_NAME))).toBe("📄".repeat(MAX_VERSION_NAME));
  });
});

describe("unchangedSince", () => {
  const latest = { title: "Plan", contentMarkdown: "# Goals" };

  it("is true only when both the title and the body are as the newest version has them", () => {
    expect(unchangedSince(latest, { title: "Plan", markdown: "# Goals" })).toBe(true);
    expect(unchangedSince(latest, { title: "Plan 2", markdown: "# Goals" })).toBe(false);
    expect(unchangedSince(latest, { title: "Plan", markdown: "# Goals\n\nMore" })).toBe(false);
  });

  it("is false when the page has no version yet", () => {
    expect(unchangedSince(null, { title: "", markdown: "" })).toBe(false);
    expect(unchangedSince(undefined, { title: "Plan", markdown: "" })).toBe(false);
  });
});
