import { describe, expect, it } from "vitest";
import { MAX_ROW_ACCESS_RULES, parseRowAccess, readRowAccess, remapRowAccess, rowAccessInUse } from "./row-access";

const properties = [
  { id: "owner", type: "person" },
  { id: "reviewer", type: "person" },
  { id: "status", type: "select" },
];

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return null;
};

describe("parseRowAccess", () => {
  it("keeps rules naming person properties and the creator", () => {
    expect(
      parseRowAccess(
        {
          restricted: true,
          rules: [
            { kind: "person", propertyId: "owner", level: "edit", extra: 1 },
            { kind: "creator", level: "full" },
          ],
        },
        properties,
      ),
    ).toEqual({
      restricted: true,
      rules: [
        { kind: "person", propertyId: "owner", level: "edit" },
        { kind: "creator", level: "full" },
      ],
    });
  });

  it("refuses what isn't a rule of this database", () => {
    const bad = [
      null,
      { rules: [] },
      { restricted: "yes", rules: [] },
      { restricted: false, rules: [{ kind: "person", propertyId: "status", level: "edit" }] },
      { restricted: false, rules: [{ kind: "person", propertyId: "elsewhere", level: "edit" }] },
      { restricted: false, rules: [{ kind: "person", propertyId: "owner", level: "owner" }] },
      { restricted: false, rules: [{ kind: "group", propertyId: "owner", level: "edit" }] },
      {
        restricted: false,
        rules: [
          { kind: "person", propertyId: "owner", level: "edit" },
          { kind: "person", propertyId: "owner", level: "view" },
        ],
      },
      { restricted: false, rules: [{ kind: "creator", level: "edit" }, { kind: "creator", level: "view" }] },
      { restricted: false, rules: Array.from({ length: MAX_ROW_ACCESS_RULES + 1 }, () => ({ kind: "creator", level: "view" })) },
    ];
    for (const input of bad) expect(code(() => parseRowAccess(input, properties)), JSON.stringify(input)).toBe("invalidRowAccess");
  });
});

describe("readRowAccess", () => {
  it("reads what is stored, leaving out rules that make no sense", () => {
    expect(readRowAccess(null)).toEqual({ restricted: false, rules: [] });
    expect(
      readRowAccess({
        restricted: false,
        rules: [{ kind: "person", propertyId: "owner", level: "view" }, { kind: "person", level: "view" }, { level: "edit" }, null],
      }),
    ).toEqual({ restricted: false, rules: [{ kind: "person", propertyId: "owner", level: "view" }] });
  });
});

describe("rowAccessInUse and remapRowAccess", () => {
  it("knows a setting that changes nothing", () => {
    expect(rowAccessInUse({ restricted: false, rules: [] })).toBe(false);
    expect(rowAccessInUse({ restricted: true, rules: [] })).toBe(true);
    expect(rowAccessInUse({ restricted: false, rules: [{ kind: "creator", level: "view" }] })).toBe(true);
  });

  it("names a copy's properties and drops rules whose property wasn't copied", () => {
    expect(
      remapRowAccess(
        {
          restricted: true,
          rules: [
            { kind: "person", propertyId: "owner", level: "edit" },
            { kind: "person", propertyId: "reviewer", level: "view" },
            { kind: "creator", level: "comment" },
          ],
        },
        new Map([["owner", "owner-copy"]]),
      ),
    ).toEqual({
      restricted: true,
      rules: [
        { kind: "person", propertyId: "owner-copy", level: "edit" },
        { kind: "creator", level: "comment" },
      ],
    });
  });
});
