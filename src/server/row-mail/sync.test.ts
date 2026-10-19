import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { parseHeaderBlock } = await import("./sync");

describe("parseHeaderBlock", () => {
  it("unfolds headers and keeps each occurrence, by lower-case name", () => {
    const fields = parseHeaderBlock(
      Buffer.from(
        "References: <a@x.com>\r\n <b@y.com>\r\nAuto-Submitted: auto-replied\r\nAuthentication-Results: one; dmarc=pass\r\nAuthentication-Results: two; dmarc=fail\r\n\r\n",
      ),
    );
    expect(fields.get("references")).toEqual(["<a@x.com> <b@y.com>"]);
    expect(fields.get("auto-submitted")).toEqual(["auto-replied"]);
    expect(fields.get("authentication-results")).toEqual(["one; dmarc=pass", "two; dmarc=fail"]);
    expect(parseHeaderBlock(undefined).size).toBe(0);
  });
});
