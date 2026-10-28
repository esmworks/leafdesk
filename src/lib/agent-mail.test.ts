import { describe, expect, it } from "vitest";
import { MAX_AGENT_MAIL_RECIPIENTS, parseMailRecipients } from "./agent-mail";

describe("parseMailRecipients", () => {
  it("reads a list or typed text, lower case, once each", () => {
    expect(parseMailRecipients(["Planning@Example.com", " sales@example.com "])).toEqual(["planning@example.com", "sales@example.com"]);
    expect(parseMailRecipients("planning@example.com; Sales@example.com,\nplanning@example.com")).toEqual(["planning@example.com", "sales@example.com"]);
    expect(parseMailRecipients("")).toEqual([]);
    expect(parseMailRecipients(" , ")).toEqual([]);
  });

  it("refuses anything that isn't an address, and too many", () => {
    expect(parseMailRecipients("planning@example.com, not an address")).toBeNull();
    expect(parseMailRecipients([42])).toBeNull();
    expect(parseMailRecipients({ to: "a@example.com" })).toBeNull();
    const many = Array.from({ length: MAX_AGENT_MAIL_RECIPIENTS + 1 }, (_, i) => `p${i}@example.com`);
    expect(parseMailRecipients(many)).toBeNull();
    expect(parseMailRecipients(many.slice(1))).toHaveLength(MAX_AGENT_MAIL_RECIPIENTS);
  });
});
