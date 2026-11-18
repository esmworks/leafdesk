import { describe, expect, it } from "vitest";
import { exportPage, parseZendeskQuery, ticketRow, ticketValues, usersOf, zendeskOptionsNeeded, zendeskSiteUrl, ENGLISH_ZENDESK_NAMES } from "./zendesk-sync";

const SITE = "https://acme.zendesk.com";

describe("zendeskSiteUrl", () => {
  it("takes a subdomain, a host or an address", () => {
    expect(zendeskSiteUrl("Acme")).toBe(SITE);
    expect(zendeskSiteUrl("acme.zendesk.com")).toBe(SITE);
    expect(zendeskSiteUrl("https://acme.zendesk.com/agent/tickets/1")).toBe(SITE);
    expect(zendeskSiteUrl("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080");
  });
  it("refuses what is no address", () => {
    for (const bad of [undefined, "", "a b", "ftp://acme.zendesk.com", "https://user:pw@acme.zendesk.com", "-acme"]) expect(zendeskSiteUrl(bad)).toBeNull();
  });
});

describe("ticketRow", () => {
  it("maps a ticket of the export", () => {
    const row = ticketRow(
      { id: 35436, subject: "Help", status: "open", priority: "high", type: "incident", requester_id: 7, assignee_id: 8, tags: ["a", "b", "a"], created_at: "2026-01-02T03:04:05Z", updated_at: "2026-02-02T03:04:05Z" },
      SITE,
    );
    expect(row).toEqual({
      id: 35436,
      title: "Help",
      status: "open",
      priority: "high",
      type: "incident",
      requesterId: 7,
      assigneeId: 8,
      tags: ["a", "b"],
      created: "2026-01-02T03:04:05.000Z",
      updated: "2026-02-02T03:04:05.000Z",
      link: `${SITE}/agent/tickets/35436`,
    });
  });
  it("copes with missing fields and refuses a ticket without an id", () => {
    expect(ticketRow({ id: 3, status: "weird", assignee_id: null }, SITE)).toMatchObject({ title: "#3", status: null, assigneeId: null, tags: [] });
    expect(ticketRow({ subject: "x" }, SITE)).toBeNull();
    expect(ticketRow("nope", SITE)).toBeNull();
  });
});

describe("export pages and users", () => {
  it("reads a page", () => {
    expect(exportPage({ tickets: [{}], after_cursor: "c", end_of_stream: false })).toEqual({ tickets: [{}], cursor: "c", end: false });
    expect(exportPage({ error: "x" })).toBeNull();
  });
  it("reads users by id, named by email when nameless", () => {
    const users = usersOf({ users: [{ id: 1, name: "Ada", email: "ada@x.test" }, { id: 2, email: "b@x.test" }, { name: "no id" }] });
    expect(users.get(1)).toEqual({ name: "Ada", email: "ada@x.test" });
    expect(users.get(2)).toEqual({ name: "b@x.test", email: "b@x.test" });
    expect(users.size).toBe(2);
  });
  it("keeps a usable state", () => {
    expect(parseZendeskQuery({ since: 12.7, total: 3 })).toEqual({ since: 12, total: 3 });
    expect(parseZendeskQuery({ since: -1, total: "x" })).toEqual({ since: null, total: 0 });
    expect(parseZendeskQuery(null)).toEqual({ since: null, total: 0 });
  });
});

describe("ticketValues", () => {
  const mapping = {
    id: "p-id",
    status: "p-status",
    priority: "p-priority",
    requester: "p-req",
    requesterOthers: "p-req-others",
    assignee: "p-asg",
    assigneeOthers: "p-asg-others",
    tags: "p-tags",
    link: "p-link",
    statuses: ENGLISH_ZENDESK_NAMES.statuses,
  };
  const users = new Map([
    [7, { name: "Ada", email: "ada@x.test" }],
    [8, { name: "Stranger", email: "s@y.test" }],
  ]);
  const row = ticketRow({ id: 1, subject: "S", status: "pending", priority: "low", requester_id: 7, assignee_id: 8, tags: ["t"] }, SITE)!;
  it("writes people the workspace has as people and others as text", () => {
    const values = ticketValues(row, mapping, users, (u) => (u.email === "ada@x.test" ? "user-ada" : null));
    expect(values["p-id"]).toBe(1);
    expect(values["p-status"]).toBe("Pending");
    expect(values["p-req"]).toEqual(["user-ada"]);
    expect(values["p-req-others"]).toBeNull();
    expect(values["p-asg"]).toBeNull();
    expect(values["p-asg-others"]).toBe("Stranger");
    expect(values["p-tags"]).toEqual(["t"]);
  });
  it("collects the options a run needs", () => {
    expect(zendeskOptionsNeeded([row, { ...row, priority: "LOW", tags: ["T", "u"] }])).toEqual({ priority: ["low"], type: [], tags: ["t", "u"] });
  });
});
