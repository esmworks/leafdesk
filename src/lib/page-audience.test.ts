import { describe, expect, it } from "vitest";
import { pageAudienceOf, parseAudience } from "./page-audience";

const base = { published: false, teamspace: null, everyone: null, people: 1, groups: 0 };

describe("pageAudienceOf", () => {
  it("puts the web first", () => {
    expect(pageAudienceOf({ ...base, published: true, teamspace: { name: "Sales", everyoneIn: false } })).toEqual({ kind: "web" });
  });

  it("names the teamspace, or the whole workspace for one everyone is in", () => {
    expect(pageAudienceOf({ ...base, teamspace: { name: "Sales", everyoneIn: false } })).toEqual({ kind: "teamspace", teamspace: "Sales" });
    expect(pageAudienceOf({ ...base, teamspace: { name: "General", everyoneIn: true } })).toEqual({ kind: "workspace", teamspace: "General" });
  });

  it("narrows a teamspace page closed to everyone to the people it is shared with", () => {
    const closed = { ...base, teamspace: { name: "Sales", everyoneIn: false }, everyone: "none" };
    expect(pageAudienceOf(closed)).toEqual({ kind: "private" });
    expect(pageAudienceOf({ ...closed, people: 3 })).toEqual({ kind: "people", people: 3, groups: 0 });
  });

  it("opens a private page to the workspace only through an everyone entry", () => {
    expect(pageAudienceOf({ ...base, everyone: "view" })).toEqual({ kind: "workspace" });
    expect(pageAudienceOf({ ...base, everyone: "none" })).toEqual({ kind: "private" });
  });

  it("counts people and groups a private page is shared with", () => {
    expect(pageAudienceOf(base)).toEqual({ kind: "private" });
    expect(pageAudienceOf({ ...base, people: 0 })).toEqual({ kind: "private" });
    expect(pageAudienceOf({ ...base, people: 2 })).toEqual({ kind: "people", people: 2, groups: 0 });
    expect(pageAudienceOf({ ...base, groups: 1 })).toEqual({ kind: "people", people: 1, groups: 1 });
  });
});

describe("parseAudience", () => {
  it("keeps what was stored and drops anything else", () => {
    expect(parseAudience({ kind: "web" })).toEqual({ kind: "web" });
    expect(parseAudience({ kind: "workspace" })).toEqual({ kind: "workspace" });
    expect(parseAudience({ kind: "workspace", teamspace: "General" })).toEqual({ kind: "workspace", teamspace: "General" });
    expect(parseAudience({ kind: "teamspace", teamspace: 4 })).toEqual({ kind: "teamspace", teamspace: "" });
    expect(parseAudience({ kind: "people", people: "2", groups: null })).toEqual({ kind: "people", people: 2, groups: 0 });
    expect(parseAudience({ kind: "private", extra: true })).toEqual({ kind: "private" });
    for (const junk of [null, undefined, "web", [], { kind: "everyone" }]) expect(parseAudience(junk)).toBeNull();
  });
});
