import { describe, expect, it } from "vitest";
import { cleanLegalHoldInput, commentAuthors, LEGAL_HOLD_MAX_PEOPLE, LegalHoldError } from "./legal-hold";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof LegalHoldError ? error.code : "other";
  }
  return null;
};

describe("cleanLegalHoldInput", () => {
  it("trims the name and reason and drops repeated people", () => {
    expect(cleanLegalHoldInput({ name: "  Matter ", reason: " why ", userIds: ["a", "b", "a"] })).toEqual({ name: "Matter", reason: "why", userIds: ["a", "b"] });
  });

  it("refuses what won't do", () => {
    expect(code(() => cleanLegalHoldInput({ name: " ", userIds: ["a"] }))).toBe("nameRequired");
    expect(code(() => cleanLegalHoldInput({ name: "x".repeat(201), userIds: ["a"] }))).toBe("nameTooLong");
    expect(code(() => cleanLegalHoldInput({ name: "x", reason: "x".repeat(2001), userIds: ["a"] }))).toBe("reasonTooLong");
    expect(code(() => cleanLegalHoldInput({ name: "x", userIds: [] }))).toBe("noPeople");
    expect(code(() => cleanLegalHoldInput({ name: "x", userIds: [1] }))).toBe("unknownPerson");
    expect(code(() => cleanLegalHoldInput({ name: "x", userIds: Array.from({ length: LEGAL_HOLD_MAX_PEOPLE + 1 }, (_, i) => `u${i}`) }))).toBe("tooManyPeople");
    expect(code(() => cleanLegalHoldInput(null))).toBe("nameRequired");
  });
});

describe("commentAuthors", () => {
  const map = {
    t1: { comments: [{ id: "c1", userId: "ann" }, { id: "c2", userId: "bob" }] },
    t2: { comments: [{ id: "c3", userId: "cy" }] },
  };

  it("reads the threads map of a page's document", () => {
    expect([...commentAuthors(map)].sort()).toEqual(["ann", "bob", "cy"]);
    expect([...commentAuthors(map, "t1")].sort()).toEqual(["ann", "bob"]);
    expect([...commentAuthors(map, "t1", "c2")]).toEqual(["bob"]);
  });

  it("reads threads as collab lists them", () => {
    const list = [{ id: "t1", comments: [{ id: "c1", userId: "ann" }] }];
    expect([...commentAuthors(list, "t1")]).toEqual(["ann"]);
    expect([...commentAuthors(list, "t2")]).toEqual([]);
  });

  it("takes anything else as no comments", () => {
    expect(commentAuthors(null).size).toBe(0);
    expect(commentAuthors({ t1: null, t2: { comments: "x" } }).size).toBe(0);
  });
});
