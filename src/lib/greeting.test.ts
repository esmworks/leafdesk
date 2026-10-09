import { describe, expect, it } from "vitest";
import { greetingFor } from "./greeting";

describe("greetingFor", () => {
  it("greets by the time of day", () => {
    expect(greetingFor(5)).toBe("morning");
    expect(greetingFor(11)).toBe("morning");
    expect(greetingFor(12)).toBe("afternoon");
    expect(greetingFor(17)).toBe("afternoon");
    expect(greetingFor(18)).toBe("evening");
    expect(greetingFor(23)).toBe("evening");
  });

  it("keeps the small hours as evening", () => {
    expect(greetingFor(0)).toBe("evening");
    expect(greetingFor(4)).toBe("evening");
  });
});
