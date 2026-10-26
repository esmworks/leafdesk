import { describe, expect, it } from "vitest";
import { scriptString } from "./site-analytics";

describe("scriptString", () => {
  it("writes a string an inline script can't be closed by", () => {
    const written = scriptString('G-1</script><script>alert("x")</script>');
    expect(written).not.toContain("<");
    expect(JSON.parse(written)).toBe('G-1</script><script>alert("x")</script>');
  });

  it("leaves a measurement ID as it is", () => {
    expect(scriptString("G-ABC123")).toBe('"G-ABC123"');
  });
});
