import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { themeAnswer } = await import("./pdf-theme-ai");

describe("themeAnswer", () => {
  it("reads a theme from the whole answer, a fence, or around a sentence", () => {
    expect(themeAnswer('{"title":false}')).toEqual({ title: false });
    expect(themeAnswer('Here it is:\n```json\n{"font_size":9}\n```\nDone.')).toEqual({ font_size: 9 });
    expect(themeAnswer('Sure. {"title":true} That is all.')).toEqual({ title: true });
  });

  it("is null when the answer holds no JSON object", () => {
    expect(themeAnswer("I can't do that.")).toBeNull();
    expect(themeAnswer("{not json}")).toBeNull();
  });
});
