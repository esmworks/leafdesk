import { describe, expect, it } from "vitest";
import { canBeUnique, repeatedValues, uniqueValueKey } from "./unique-values";

describe("uniqueValueKey", () => {
  it("folds text, emails and links by case and outer spaces", () => {
    expect(uniqueValueKey("text", "  Ada Lovelace ")).toBe("ada lovelace");
    expect(uniqueValueKey("email", "ADA@example.test")).toBe(uniqueValueKey("email", "ada@example.test "));
    expect(uniqueValueKey("url", "https://Example.test/A")).toBe("https://example.test/a");
  });

  it("compares phone numbers by their digits and +", () => {
    expect(uniqueValueKey("phone", "+90 (555) 123-45-67")).toBe("+905551234567");
  });

  it("compares numbers by amount", () => {
    expect(uniqueValueKey("number", 1)).toBe(uniqueValueKey("number", 1.0));
    expect(uniqueValueKey("number", 1.5)).not.toBe(uniqueValueKey("number", 1));
  });

  it("gives empty values no key", () => {
    expect(uniqueValueKey("text", "   ")).toBeNull();
    expect(uniqueValueKey("text", null)).toBeNull();
    expect(uniqueValueKey("phone", "-")).toBeNull();
    expect(uniqueValueKey("number", "x")).toBeNull();
  });
});

describe("repeatedValues", () => {
  const value = (row: number, key: string | null, rowId?: string, propertyId = "email") => ({ row, rowId, propertyId, key });

  it("refuses a value an earlier row of the batch takes", () => {
    expect(repeatedValues([value(0, "a@x.test"), value(1, "b@x.test"), value(2, "a@x.test")], [])).toEqual([{ row: 2, propertyId: "email" }]);
  });

  it("refuses a value another row holds, and lets a row keep its own", () => {
    const taken = [
      { rowId: "r1", propertyId: "email", key: "a@x.test" },
      { rowId: "r9", propertyId: "email", key: "b@x.test" },
    ];
    expect(repeatedValues([value(0, "a@x.test", "r1"), value(1, "b@x.test", "r2"), value(2, "b@x.test")], taken)).toEqual([
      { row: 1, propertyId: "email" },
      { row: 2, propertyId: "email" },
    ]);
  });

  it("refuses a row's own value to the rows after it", () => {
    const taken = [{ rowId: "r1", propertyId: "email", key: "a@x.test" }];
    expect(repeatedValues([value(1, "a@x.test", "r1"), value(0, "a@x.test")], taken)).toEqual([{ row: 0, propertyId: "email" }]);
  });

  it("compares each property on its own and lets empty values be", () => {
    expect(repeatedValues([value(0, "7", undefined, "code"), value(0, "7"), value(1, null), value(2, null)], [])).toEqual([]);
  });
});

describe("canBeUnique", () => {
  it("takes the types whose values compare as one", () => {
    expect(["text", "number", "email", "url", "phone"].every(canBeUnique)).toBe(true);
    expect(canBeUnique("select")).toBe(false);
    expect(canBeUnique("date")).toBe(false);
  });
});
