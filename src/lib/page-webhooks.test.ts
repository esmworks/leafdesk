import { describe, expect, it } from "vitest";
import { isPageWebhookEvent, isPageWebhookScope, normalizeEvents, PAGE_WEBHOOK_EVENTS, retriableCode } from "./page-webhooks";

describe("page webhook events", () => {
  it("keeps known events once each, in the catalog's order", () => {
    expect(normalizeEvents(["comment.created", "page.created", "page.created", "page.renamed", 3])).toEqual(["page.created", "comment.created"]);
    expect(normalizeEvents([...PAGE_WEBHOOK_EVENTS].reverse())).toEqual([...PAGE_WEBHOOK_EVENTS]);
  });

  it("has nothing left when no event is known", () => {
    expect(normalizeEvents([])).toBeNull();
    expect(normalizeEvents(["ping", "row.created"])).toBeNull();
  });

  it("tells events and scopes from anything else", () => {
    expect(isPageWebhookEvent("page.moved")).toBe(true);
    expect(isPageWebhookEvent("ping")).toBe(false);
    expect(isPageWebhookScope("teamspace")).toBe(true);
    expect(isPageWebhookScope("database")).toBe(false);
  });
});

describe("retriableCode", () => {
  it("tries again where the address may answer another time", () => {
    for (const code of ["unreachable", "timeout", "http"] as const) expect(retriableCode(code)).toBe(true);
    for (const code of ["invalidUrl", "blocked", "redirect", "noAccess", "exportOff"] as const) expect(retriableCode(code)).toBe(false);
  });
});
