import { describe, expect, it } from "vitest";
import { markdownPageIds } from "./mentions";
import { visibleSettingsTabs } from "./settings-tabs";
import {
  DEFAULT_STALE_MONTHS,
  findingCount,
  isEmptyPage,
  isOrphan,
  isStale,
  MAX_FINDINGS,
  parseStaleMonths,
  section,
  similarPairs,
  staleCutoff,
  type CheckedPage,
  type WorkspaceCheck,
} from "./workspace-check";

const at = new Date("2026-10-17T12:00:00Z");

const pageOf = (over: Partial<CheckedPage> = {}): CheckedPage => ({
  id: "p",
  title: "Roadmap",
  kind: "page",
  topLevel: true,
  hasChildren: false,
  linkedTo: false,
  emptyBody: false,
  isSkill: false,
  updatedAt: at,
  ...over,
});

describe("orphans", () => {
  it("are top-level pages with nothing inside that nothing links to", () => {
    expect(isOrphan(pageOf())).toBe(true);
    expect(isOrphan(pageOf({ linkedTo: true }))).toBe(false);
    expect(isOrphan(pageOf({ hasChildren: true }))).toBe(false);
    expect(isOrphan(pageOf({ topLevel: false }))).toBe(false);
  });

  it("leave out databases, rows and skills, which are reached their own ways", () => {
    expect(isOrphan(pageOf({ kind: "database" }))).toBe(false);
    expect(isOrphan(pageOf({ kind: "row", topLevel: false }))).toBe(false);
    expect(isOrphan(pageOf({ isSkill: true }))).toBe(false);
  });

  it("leave out pages with no body, which are listed as empty (or just started)", () => {
    expect(isOrphan(pageOf({ emptyBody: true }))).toBe(false);
    expect(isOrphan(pageOf({ emptyBody: true, title: "" }))).toBe(false);
  });
});

describe("empty pages", () => {
  it("have a title and no body or pages inside", () => {
    expect(isEmptyPage(pageOf({ emptyBody: true }))).toBe(true);
    expect(isEmptyPage(pageOf({ emptyBody: false }))).toBe(false);
    expect(isEmptyPage(pageOf({ emptyBody: true, hasChildren: true }))).toBe(false);
  });

  it("leave out pages without a title (just started) and rows (their values are their content)", () => {
    expect(isEmptyPage(pageOf({ emptyBody: true, title: "  " }))).toBe(false);
    expect(isEmptyPage(pageOf({ emptyBody: true, kind: "row", topLevel: false }))).toBe(false);
    expect(isEmptyPage(pageOf({ emptyBody: true, kind: "database" }))).toBe(false);
  });
});

describe("stale pages", () => {
  it("count calendar months back from now", () => {
    expect(staleCutoff(at, 6).toISOString()).toBe("2026-04-17T12:00:00.000Z");
    expect(staleCutoff(at, 12).toISOString()).toBe("2025-10-17T12:00:00.000Z");
  });

  it("are pages last edited before the cutoff; databases and rows are left out", () => {
    const cutoff = staleCutoff(at, 6);
    expect(isStale(pageOf({ updatedAt: new Date("2026-01-01T00:00:00Z") }), cutoff)).toBe(true);
    expect(isStale(pageOf({ updatedAt: new Date("2026-05-01T00:00:00Z") }), cutoff)).toBe(false);
    expect(isStale(pageOf({ kind: "database", updatedAt: new Date("2020-01-01T00:00:00Z") }), cutoff)).toBe(false);
    expect(isStale(pageOf({ kind: "row", updatedAt: new Date("2020-01-01T00:00:00Z") }), cutoff)).toBe(false);
  });

  it("take only the periods offered, the default otherwise", () => {
    expect(parseStaleMonths("12")).toBe(12);
    expect(parseStaleMonths(["3", "6"])).toBe(3);
    expect(parseStaleMonths("7")).toBe(DEFAULT_STALE_MONTHS);
    expect(parseStaleMonths(undefined)).toBe(DEFAULT_STALE_MONTHS);
    expect(parseStaleMonths("abc")).toBe(DEFAULT_STALE_MONTHS);
  });
});

describe("similarPairs", () => {
  it("pairs vectors at least as alike as asked, most alike first, each pair once", () => {
    const pairs = similarPairs(
      [
        { id: "a", vector: [1, 0, 0] },
        { id: "b", vector: [0.99, 0.1, 0] },
        { id: "c", vector: [0, 1, 0] },
        { id: "d", vector: [2, 0, 0] },
      ],
      0.9,
    );
    // a and d point the same way, so b is as alike to both: the tie goes by id.
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual(["a-d", "a-b", "b-d"]);
    expect(pairs[0].similarity).toBe(1);
    expect(pairs[1].similarity).toBeCloseTo(0.995, 3);
  });

  it("leaves out empty vectors and vectors of another length", () => {
    expect(
      similarPairs(
        [
          { id: "a", vector: [1, 0] },
          { id: "zero", vector: [0, 0] },
          { id: "long", vector: [1, 0, 0] },
          { id: "b", vector: [1, 0] },
        ],
        0.5,
      ),
    ).toEqual([{ a: "a", b: "b", similarity: 1 }]);
    expect(similarPairs([], 0.5)).toEqual([]);
  });
});

describe("sections", () => {
  it("list the first findings and count them all", () => {
    const items = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => i);
    expect(section(items)).toEqual({ items: items.slice(0, MAX_FINDINGS), total: MAX_FINDINGS + 5 });
    expect(section([1, 2])).toEqual({ items: [1, 2], total: 2 });
  });

  it("add up to the report's findings, duplicates only when they were checked", () => {
    const none = { items: [], total: 0 };
    const check: WorkspaceCheck = {
      workspaceId: "ws",
      checkedAt: at.toISOString(),
      pages: 10,
      truncated: false,
      staleMonths: 6,
      brokenLinks: { items: [], total: 2 },
      orphans: { items: [], total: 3 },
      empty: none,
      stale: { items: [], total: 1 },
      expiredVerifications: { items: [], total: 5 },
      duplicates: { status: "skipped", reason: "noEmbeddings" },
      brokenRelations: { items: [], total: 4 },
    };
    expect(findingCount(check)).toBe(15);
    expect(findingCount({ ...check, duplicates: { status: "done", minSimilarity: 0.9, compared: 5, items: [], total: 2 } })).toBe(17);
  });
});

describe("markdownPageIds", () => {
  const A = "3f0c9a4e-1111-4222-8333-444455556666";
  const B = "7a1b2c3d-1111-4222-8333-444455556666";

  it("finds page mentions and page links once each, in order", () => {
    const md = [`See [page](/w/ws/p/${A}) and [page](/w/ws/p/${B}).`, `[page](/w/ws/p/${A}) <!-- leafdesk:page-link -->`].join("\n");
    expect(markdownPageIds(md)).toEqual([A, B]);
  });

  it("skips fenced code and links that aren't to pages", () => {
    const md = ["```", `[page](/w/ws/p/${A})`, "```", "[site](https://example.com/p/x)", `~~~md`, `[page](/w/ws/p/${B})`, "~~~"].join("\n");
    expect(markdownPageIds(md)).toEqual([]);
    expect(markdownPageIds("no links here")).toEqual([]);
  });
});

describe("visibleSettingsTabs: health", () => {
  it("is for owners and members, not guests", () => {
    expect(visibleSettingsTabs({ guest: false, managesGuests: false, owner: true })).toContain("health");
    expect(visibleSettingsTabs({ guest: false, managesGuests: false })).toContain("health");
    expect(visibleSettingsTabs({ guest: true, managesGuests: false })).not.toContain("health");
  });
});
