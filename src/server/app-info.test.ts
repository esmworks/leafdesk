import { describe, expect, it } from "vitest";
import { sourceUrlFrom } from "./app-info";

describe("sourceUrlFrom", () => {
  it("is the release's tag when unset or blank", () => {
    expect(sourceUrlFrom(undefined, "1.2.3")).toBe("https://github.com/esmworks/leafdesk/tree/v1.2.3");
    expect(sourceUrlFrom("  ", "1.2.3")).toBe("https://github.com/esmworks/leafdesk/tree/v1.2.3");
  });

  it("takes an http(s) link, without a trailing slash", () => {
    expect(sourceUrlFrom(" https://git.example.com/you/leafdesk/ ", "1.2.3")).toBe("https://git.example.com/you/leafdesk");
    expect(sourceUrlFrom("http://10.0.0.5:3000/src", "1.2.3")).toBe("http://10.0.0.5:3000/src");
  });

  it("ignores anything else", () => {
    expect(sourceUrlFrom("javascript:alert(1)", "1.2.3")).toBe("https://github.com/esmworks/leafdesk/tree/v1.2.3");
    expect(sourceUrlFrom("git.example.com/you/leafdesk", "1.2.3")).toBe("https://github.com/esmworks/leafdesk/tree/v1.2.3");
  });
});
