import { describe, expect, it } from "vitest";
import {
  flatMapping,
  parseSalesforceQuery,
  queryPage,
  recordRow,
  salesforceErrorMessage,
  salesforceOptionsNeeded,
  salesforceSiteUrl,
  salesforceTypes,
  salesforceValues,
  selectedPaths,
  soqlOf,
  isSalesforceLimit,
  SALESFORCE_FIELD_KEYS,
  SALESFORCE_OBJECT_SPECS,
  SALESFORCE_OBJECTS,
  ENGLISH_SALESFORCE_NAMES,
} from "./salesforce-sync";

describe("salesforceSiteUrl", () => {
  it("takes a name, a host, an address or the Lightning host", () => {
    expect(salesforceSiteUrl("Acme")).toBe("https://acme.my.salesforce.com");
    expect(salesforceSiteUrl("acme.my.salesforce.com")).toBe("https://acme.my.salesforce.com");
    expect(salesforceSiteUrl("https://acme.sandbox.my.salesforce.com/lightning/page/home")).toBe("https://acme.sandbox.my.salesforce.com");
    expect(salesforceSiteUrl("https://acme.lightning.force.com/lightning/o/Account/home")).toBe("https://acme.my.salesforce.com");
    expect(salesforceSiteUrl("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });
  it("refuses what is no address", () => {
    for (const bad of [undefined, "", "a b", "javascript:alert(1)", "https://u:p@acme.my.salesforce.com"]) expect(salesforceSiteUrl(bad)).toBeNull();
  });
});

describe("every object's fields", () => {
  it("are named by the keys the names are made for", () => {
    for (const object of SALESFORCE_OBJECTS) {
      for (const field of SALESFORCE_OBJECT_SPECS[object].fields) expect(SALESFORCE_FIELD_KEYS).toContain(field.key);
    }
    expect(Object.keys(ENGLISH_SALESFORCE_NAMES.fields).sort()).toEqual([...SALESFORCE_FIELD_KEYS].sort());
  });
  it("select what the mapping reads", () => {
    expect(selectedPaths("Opportunity")).toEqual(expect.arrayContaining(["Id", "SystemModstamp", "Name", "IsClosed", "StageName", "Owner.Name", "Owner.Email", "Account.Name"]));
    expect(selectedPaths("Case")).not.toContain("Owner.Email");
  });
});

describe("soqlOf", () => {
  it("reads everything the first time and what changed after, oldest first", () => {
    expect(soqlOf({ object: "Lead", since: null, total: 0 })).toMatch(/^SELECT Id, SystemModstamp, Name, IsConverted, .* FROM Lead ORDER BY SystemModstamp ASC$/);
    expect(soqlOf({ object: "Lead", since: "2026-10-01T10:00:00.123Z", total: 5 })).toContain(" WHERE SystemModstamp >= 2026-10-01T10:00:00Z ORDER BY SystemModstamp ASC");
  });
});

describe("recordRow", () => {
  const account = {
    attributes: { type: "Account" },
    Id: "001A",
    Name: "Acme",
    SystemModstamp: "2026-10-01T10:00:00.000+0000",
    Industry: "Energy",
    Website: "acme.test",
    AnnualRevenue: 1200.5,
    NumberOfEmployees: null,
    Owner: { attributes: {}, Name: "Ada", Email: "ada@x.test" },
  };
  it("maps an account", () => {
    const row = recordRow(account, "Account")!;
    expect(row).toMatchObject({ id: "001A", title: "Acme", modified: "2026-10-01T10:00:00.000Z", closed: false, owner: { name: "Ada", email: "ada@x.test" } });
    expect(row.values).toMatchObject({ industry: "Energy", website: "https://acme.test", revenue: 1200.5, employees: null });
  });
  it("closes a status by the object's flag, and falls back to the case number", () => {
    expect(recordRow({ Id: "006", Name: "Deal", StageName: "Closed Won", IsClosed: true }, "Opportunity")).toMatchObject({ closed: true });
    expect(recordRow({ Id: "500", Subject: null, CaseNumber: "00001" }, "Case")!.title).toBe("00001");
    expect(recordRow({ Name: "no id" }, "Account")).toBeNull();
  });
  it("collects options, closing a status a closed record has", () => {
    const rows = [
      recordRow({ Id: "1", Name: "a", StageName: "Won", IsClosed: true, Type: "New" }, "Opportunity")!,
      recordRow({ Id: "2", Name: "b", StageName: "won", IsClosed: false, Type: "new" }, "Opportunity")!,
      recordRow({ Id: "3", Name: "c", StageName: "Prospect", IsClosed: false }, "Opportunity")!,
    ];
    const needed = salesforceOptionsNeeded("Opportunity", rows);
    expect(needed.stage).toEqual([
      { name: "Won", group: "done" },
      { name: "Prospect", group: "in_progress" },
    ]);
    expect(needed.type).toEqual([{ name: "New" }]);
  });
});

describe("salesforceValues", () => {
  const mapping = flatMapping({ id: "p-id", modified: "p-mod", link: "p-link", fields: { industry: "p-ind", owner: "p-owner", ownerOthers: "p-others", revenue: "p-rev" } });
  const row = recordRow({ Id: "001A", Name: "Acme", Industry: "Energy", AnnualRevenue: 5, SystemModstamp: "2026-10-01T10:00:00Z", Owner: { Name: "Stranger", Email: "s@y.test" } }, "Account")!;
  it("writes the mapped properties only, owners the workspace has as people", () => {
    const values = salesforceValues(row, "Account", "https://acme.my.salesforce.com", mapping, () => null);
    expect(values).toEqual({
      "p-id": "001A",
      "p-mod": "2026-10-01T10:00:00.000Z",
      "p-link": "https://acme.my.salesforce.com/lightning/r/Account/001A/view",
      "p-ind": "Energy",
      "p-rev": 5,
      "p-owner": null,
      "p-others": "Stranger",
    });
    expect(salesforceValues(row, "Account", "https://x", mapping, () => "user-1")["p-owner"]).toEqual(["user-1"]);
    expect(salesforceValues(row, "Account", "https://x", mapping, () => "user-1")["p-others"]).toBeNull();
  });
  it("knows the type each mapped property must keep", () => {
    expect(salesforceTypes("Case")).toMatchObject({ id: "text", status: "status", owner: "person", ownerOthers: "text", created: "date" });
  });
});

describe("answers", () => {
  it("reads a query page and Salesforce's errors", () => {
    expect(queryPage({ done: false, nextRecordsUrl: "/services/data/v62.0/query/01g-2000", records: [{}] })).toEqual({ records: [{}], next: "/services/data/v62.0/query/01g-2000" });
    expect(queryPage({ done: true, nextRecordsUrl: "/x", records: [] })).toEqual({ records: [], next: null });
    expect(queryPage([])).toBeNull();
    expect(salesforceErrorMessage([{ message: "No such column 'X'", errorCode: "INVALID_FIELD" }])).toBe("No such column 'X'");
    expect(isSalesforceLimit([{ errorCode: "REQUEST_LIMIT_EXCEEDED" }])).toBe(true);
    expect(isSalesforceLimit([{ errorCode: "INVALID_FIELD" }])).toBe(false);
  });
  it("keeps a usable state", () => {
    expect(parseSalesforceQuery({ object: "Case", since: "2026-10-01T10:00:00Z", total: 2 })).toEqual({ object: "Case", since: "2026-10-01T10:00:00.000Z", total: 2 });
    expect(parseSalesforceQuery({ object: "Product2" })).toBeNull();
  });
});
