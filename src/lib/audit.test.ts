import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en";
import trSettings from "@/i18n/messages/tr/settings.json";
import {
  AUDIT_ACTIONS,
  AUDIT_MAX_PAGE,
  auditActorName,
  auditCategoryOf,
  auditAudience,
  auditCsvRows,
  auditDateRange,
  auditFilterQuery,
  describeAuditEvent,
  encodeActorFilter,
  parseActorFilter,
  parseAuditFilters,
  startOfDayIn,
  type AuditEvent,
  type AuditTranslator,
} from "./audit";
import { toCsv } from "./csv";
import { AUDIT_RETENTION_DAYS, auditCutoff } from "./retention";
import { visibleSettingsTabs } from "./settings-tabs";

const t = createTranslator({ locale: "en", messages: en, namespace: "settings" }) as unknown as AuditTranslator;
const tTr = createTranslator({ locale: "tr", messages: { settings: trSettings }, namespace: "settings" }) as unknown as AuditTranslator;

const at = new Date("2026-09-20T12:00:00Z");
const event = (action: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "e1",
  action,
  actorKind: "user",
  actorUserId: "u1",
  actorName: "Ayşe",
  actorEmail: "ayse@example.test",
  actorVia: null,
  targetType: null,
  targetId: null,
  targetLabel: "",
  details: {},
  ip: null,
  userAgent: null,
  createdAt: at,
  ...extra,
});

describe("audit actions", () => {
  it("puts every action in one category", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const action of AUDIT_ACTIONS) expect(auditCategoryOf(action)).not.toBeNull();
    expect(auditCategoryOf("member.role_changed")).toBe("members");
    expect(auditCategoryOf("scim.token_created")).toBe("security");
    expect(auditCategoryOf("something.else")).toBeNull();
  });

  it("has a description for every action in every language", () => {
    for (const translate of [t, tTr]) {
      for (const action of AUDIT_ACTIONS) {
        const text = describeAuditEvent(event(action, { targetLabel: "X", details: { role: "member", kind: "join" } }), translate);
        expect(text, action).not.toBe(action);
        expect(text, action).not.toMatch(/[{}]/);
      }
    }
  });
});

describe("describeAuditEvent", () => {
  it("lists the approved networks set, and says when they went", () => {
    const names = ["192.0.2.0/24 (Office)", "2001:db8::/32"];
    expect(describeAuditEvent(event("workspace.networks_changed", { details: { names, count: 2 } }), t)).toBe(
      "Set the approved networks to 192.0.2.0/24 (Office), 2001:db8::/32",
    );
    expect(describeAuditEvent(event("workspace.networks_changed", { details: { names: [], count: 0 } }), t)).toBe("Removed the approved networks");
    expect(describeAuditEvent(event("workspace.networks_changed", { details: { names, count: 2 } }), tTr)).toBe(
      "Onaylı ağları şöyle ayarladı: 192.0.2.0/24 (Office), 2001:db8::/32",
    );
    expect(describeAuditEvent(event("workspace.networks_cleared", { details: { names: [], count: 0 } }), t)).toBe(
      "Cleared the approved networks as an instance administrator",
    );
  });

  it("names roles, levels and subjects", () => {
    expect(
      describeAuditEvent(event("member.role_changed", { targetLabel: "Deniz", details: { from: "member", to: "owner" } }), t),
    ).toBe("Changed the role of Deniz from member to owner");
    expect(
      describeAuditEvent(
        event("page.permission_changed", { targetLabel: "Roadmap", details: { subjectType: "user", subject: "Deniz", level: "edit" } }),
        t,
      ),
    ).toBe("Set the access of Deniz to Roadmap: Can edit");
    expect(
      describeAuditEvent(event("page.permission_changed", { targetLabel: "Roadmap", details: { subjectType: "everyone", level: "view" } }), t),
    ).toBe("Set the access of everyone in the workspace to Roadmap: Can view");
  });

  it("falls back for people and things that are gone", () => {
    expect(describeAuditEvent(event("page.permission_removed", { details: { subjectType: "user" } }), t)).toBe(
      "Removed Deleted user from the sharing of Untitled",
    );
    expect(describeAuditEvent(event("page.permission_removed", { details: { subjectType: "user", subjectEmail: "x@example.test" } }), t)).toBe(
      "Removed x@example.test from the sharing of Untitled",
    );
  });

  it("names whose app or token an owner took away, and not when it was the person's own", () => {
    const owners = { subjectType: "user", subject: "Mert", scopes: ["pages:read"] };
    expect(describeAuditEvent(event("connected_app.revoked", { targetLabel: "Claude", details: owners }), t)).toBe("Disconnected Mert's app Claude");
    expect(describeAuditEvent(event("connected_app.revoked", { targetLabel: "Claude", details: { scopes: [] } }), t)).toBe("Disconnected the app Claude");
    expect(describeAuditEvent(event("api_token.revoked", { targetLabel: "Reports", details: owners }), t)).toBe("Revoked Mert's API token Reports");
    expect(describeAuditEvent(event("api_token.revoked", { targetLabel: "Reports", details: {} }), t)).toBe("Revoked the API token Reports");
    expect(describeAuditEvent(event("connected_app.revoked", { targetLabel: "Claude", details: owners }), tTr)).toBe(
      "Mert kişisinin uygulamasının bağlantısı kesildi: Claude",
    );
    expect(describeAuditEvent(event("api_token.revoked", { targetLabel: "Reports", details: {} }), tTr)).toBe("API anahtarı iptal edildi: Reports");
  });

  it("names the agent an owner asked for a run", () => {
    expect(describeAuditEvent(event("agent.run_requested", { targetLabel: "Router", details: { name: "Router", runId: "run-1" } }), t)).toBe("Asked the agent “Router” for a run");
    expect(describeAuditEvent(event("agent.run_requested", { targetLabel: "Router", details: { name: "Router", runId: "run-1" } }), tTr)).toBe("“Router” ajanından bir çalışma istedi");
  });

  it("tells a join request from an invite request", () => {
    expect(describeAuditEvent(event("join_request.approved", { targetLabel: "Can", details: { kind: "join", role: "member" } }), t)).toBe(
      "Approved the request of Can to join as member",
    );
    expect(
      describeAuditEvent(event("join_request.declined", { targetLabel: "new@example.test", details: { kind: "invite", role: "member" } }), t),
    ).toBe("Declined the request to invite new@example.test");
  });

  it("lists changed settings with before and after", () => {
    const changes = {
      publishing: { from: "members", to: "owners" },
      export: { from: true, to: false },
      trashRetentionDays: { from: 30, to: 0 },
      allowedDomains: { from: [], to: ["example.test", "example.org"] },
      somethingNew: { from: "a", to: "b" },
    };
    expect(describeAuditEvent(event("workspace.settings_changed", { details: { changes } }), t)).toBe(
      "Changed settings: Who can publish to the web: Owners and members → Owners only; Allow export: On → Off; " +
        "Delete pages in the trash after: 30 days → Never; Allowed email domains: None → example.test, example.org; somethingNew: a → b",
    );
  });

  it("names the changed teamspace fields, workspace export counts and formats", () => {
    expect(
      describeAuditEvent(event("teamspace.updated", { targetLabel: "Design", details: { changes: { name: {}, access: {} } } }), t),
    ).toBe("Changed the name, access of the teamspace Design");
    expect(describeAuditEvent(event("export.workspace", { details: { format: "zip", pages: 1 } }), t)).toBe("Exported the workspace (1 page)");
    expect(describeAuditEvent(event("export.page", { targetLabel: "Tasks", details: { format: "csv" } }), t)).toBe("Exported Tasks as CSV");
  });

  it("names the automation and its database, and tells turning it on or off from other changes", () => {
    const details = { name: "Notify on done", enabled: true, trigger: "row_updated", actions: "notify" };
    expect(describeAuditEvent(event("automation.created", { targetLabel: "Tasks", details }), t)).toBe(
      "Created the automation “Notify on done” in Tasks",
    );
    expect(describeAuditEvent(event("automation.deleted", { targetLabel: "Tasks", details }), tTr)).toBe(
      "Tasks içindeki “Notify on done” otomasyonu silindi",
    );
    const updated = (previous: Record<string, unknown>, now: Record<string, unknown> = {}) =>
      describeAuditEvent(
        event("automation.updated", { targetLabel: "Tasks", details: { ...details, ...now, previous: { ...details, ...previous } } }),
        t,
      );
    expect(updated({ enabled: true }, { enabled: false })).toBe("Turned off the automation “Notify on done” in Tasks");
    expect(updated({ enabled: false })).toBe("Turned on the automation “Notify on done” in Tasks");
    expect(updated({ name: "Old name" })).toBe("Changed the automation “Notify on done” in Tasks");
  });

  it("shows an action this version doesn't know as stored", () => {
    expect(describeAuditEvent(event("future.thing"), t)).toBe("future.thing");
  });
});

describe("auditActorName", () => {
  it("names the person, the program they acted through, the identity provider or the server", () => {
    expect(auditActorName(event("member.added"), t)).toBe("Ayşe");
    expect(auditActorName(event("member.added", { actorKind: "api_token", actorVia: "CI" }), t)).toBe("Ayşe (API token CI)");
    expect(auditActorName(event("member.added", { actorKind: "connected_app", actorVia: "Claude" }), t)).toBe("Ayşe (through Claude)");
    expect(auditActorName(event("member.added", { actorKind: "scim", actorName: "", actorEmail: null, actorVia: "Okta" }), t)).toBe(
      "Identity provider (SCIM token Okta)",
    );
    expect(auditActorName(event("page.deleted", { actorKind: "system", actorName: "", actorEmail: null }), t)).toBe("System");
    expect(auditActorName(event("member.left", { actorName: "", actorEmail: null }), t)).toBe("Deleted user");
  });

  it("marks an agent as one", () => {
    expect(auditActorName(event("page.permission_changed", { actorKind: "agent", actorName: "Ticket triager", actorEmail: null }), t)).toBe(
      "Ticket triager (agent)",
    );
  });
});

describe("audit filters", () => {
  it("reads the URL, ignoring what is malformed", () => {
    expect(parseAuditFilters({ actor: "u:abc", category: "members", from: "2026-09-01", to: "2026-09-10", page: "3" })).toEqual({
      actor: { userId: "abc" },
      category: "members",
      from: "2026-09-01",
      to: "2026-09-10",
      page: 3,
    });
    expect(parseAuditFilters(new URLSearchParams("actor=x&category=nope&from=2026-02-30&to=soon&page=-1"))).toEqual({
      actor: null,
      category: null,
      from: null,
      to: null,
      page: 1,
    });
    expect(parseAuditFilters({ page: "99999" }).page).toBe(AUDIT_MAX_PAGE);
    expect(parseAuditFilters({ page: "1.5" }).page).toBe(1);
  });

  it("turns a backwards range around", () => {
    const filters = parseAuditFilters({ from: "2026-09-10", to: "2026-09-01" });
    expect([filters.from, filters.to]).toEqual(["2026-09-01", "2026-09-10"]);
  });

  it("encodes actors both ways", () => {
    for (const actor of [{ userId: "u-1" }, { kind: "agent" as const }, { kind: "scim" as const }, { kind: "system" as const }]) {
      expect(parseActorFilter(encodeActorFilter(actor))).toEqual(actor);
    }
    expect(parseActorFilter("k:admin")).toBeNull();
    expect(parseActorFilter("u:")).toBeNull();
  });

  it("writes the query back, leaving out page 1 and what isn't set", () => {
    const filters = parseAuditFilters({ actor: "k:scim", category: "security", from: "2026-09-01" });
    expect(auditFilterQuery(filters, { tab: "audit" })).toBe("actor=k%3Ascim&category=security&from=2026-09-01&tab=audit");
    expect(parseAuditFilters(new URLSearchParams(auditFilterQuery({ ...filters, page: 4 })))).toEqual({ ...filters, page: 4 });
    expect(auditFilterQuery(parseAuditFilters({}))).toBe("");
  });

  it("takes whole days in the viewer's time zone, the last one included", () => {
    expect(auditDateRange({ from: "2026-09-01", to: "2026-09-01" })).toEqual({
      since: new Date("2026-09-01T00:00:00Z"),
      until: new Date("2026-09-02T00:00:00Z"),
    });
    expect(auditDateRange({ from: "2026-09-01", to: null }, "Europe/Istanbul")).toEqual({
      since: new Date("2026-08-31T21:00:00Z"),
      until: null,
    });
    // Across a change of clocks: midnight in New York is 04:00 UTC in summer, 05:00 in winter.
    expect(startOfDayIn("2026-11-01", "America/New_York")).toEqual(new Date("2026-11-01T04:00:00Z"));
    expect(startOfDayIn("2026-11-02", "America/New_York")).toEqual(new Date("2026-11-02T05:00:00Z"));
    expect(startOfDayIn("2026-03-08", "America/New_York")).toEqual(new Date("2026-03-08T05:00:00Z"));
  });
});

describe("audit CSV", () => {
  it("has a header and a row per event, formula-safe", () => {
    const rows = auditCsvRows(
      [
        event("group.renamed", {
          actorName: "=cmd()",
          ip: "203.0.113.5",
          userAgent: "Mozilla/5.0",
          details: { from: "Design", to: "Product" },
        }),
      ],
      t,
    );
    expect(rows[0]).toEqual([
      "time",
      "actor",
      "actor_email",
      "actor_type",
      "via",
      "action",
      "category",
      "description",
      "target",
      "ip",
      "user_agent",
      "details",
      "audience",
    ]);
    expect(rows[1]).toEqual([
      at,
      "=cmd()",
      "ayse@example.test",
      "user",
      null,
      "group.renamed",
      "groups",
      "Renamed the group Design to Product",
      null,
      "203.0.113.5",
      "Mozilla/5.0",
      '{"from":"Design","to":"Product"}',
      null,
    ]);
    const csv = toCsv(rows);
    expect(csv).toContain("2026-09-20T12:00:00.000Z,'=cmd(),ayse@example.test,user,,group.renamed,groups,");
    expect(csv).toContain('"{""from"":""Design"",""to"":""Product""}"');
  });

  it("ends with the audience of page events", () => {
    const rows = auditCsvRows([event("page.created", { targetType: "page", details: { audience: { kind: "teamspace", teamspace: "Sales" } } })], t);
    expect(rows[0].at(-1)).toBe("audience");
    expect(rows[1].at(-1)).toBe("Teamspace Sales");
  });

  it("describes events in the viewer's language", () => {
    const [, row] = auditCsvRows([event("member.left")], tTr);
    expect(row[7]).toBe("Çalışma alanından ayrıldı");
  });
});

describe("audit retention", () => {
  it("keeps events for a year", () => {
    expect(AUDIT_RETENTION_DAYS).toBe(365);
    expect(auditCutoff(new Date("2026-09-20T12:00:00Z"))).toEqual(new Date("2025-09-20T12:00:00Z"));
  });
});

describe("visibleSettingsTabs: audit", () => {
  it("is for owners only", () => {
    expect(visibleSettingsTabs({ guest: false, managesGuests: true, owner: true })).toContain("audit");
    expect(visibleSettingsTabs({ guest: false, managesGuests: true })).not.toContain("audit");
    expect(visibleSettingsTabs({ guest: true, managesGuests: false, owner: true })).toEqual(["general", "snippets"]);
  });
});

describe("page audience", () => {
  const of = (audience: unknown, translate = t) => auditAudience(event("page.created", { details: { audience } }), translate);

  it("reads each audience", () => {
    expect(of({ kind: "web" })).toBe("Published to the web");
    expect(of({ kind: "private" })).toBe("Private");
    expect(of({ kind: "workspace" })).toBe("Whole workspace");
    expect(of({ kind: "workspace", teamspace: "General" })).toBe("Whole workspace (teamspace General)");
    expect(of({ kind: "teamspace", teamspace: "Sales" })).toBe("Teamspace Sales");
    expect(of({ kind: "people", people: 2, groups: 1 })).toBe("Specific people (3)");
    expect(of({ kind: "people", people: 2, groups: 1 }, tTr)).not.toBe("Specific people (3)");
  });

  it("is empty for events without one", () => {
    expect(auditAudience(event("member.left"), t)).toBeNull();
    expect(of("web")).toBeNull();
  });
});

describe("new page and member events", () => {
  it("reads a link's expiry in UTC, and its removal", () => {
    const set = event("page.publication_expiry_changed", { targetLabel: "Docs", details: { from: null, to: "2026-11-02T15:30:00.000Z" } });
    expect(describeAuditEvent(set, t)).toBe("Set the web link of Docs to stop working on 2026-11-02 15:30 UTC");
    const removed = event("page.publication_expiry_changed", { targetLabel: "Docs", details: { from: "2026-11-02T15:30:00.000Z", to: null } });
    expect(describeAuditEvent(removed, t)).toBe("Removed the expiry of the web link of Docs");
  });

  it("reads a hand-over", () => {
    const handed = event("member.content_handed_over", { targetLabel: "Bob", details: { count: 3, subject: "Ayşe", subjectType: "user" } });
    expect(describeAuditEvent(handed, t)).toBe("Handed 3 pages that only Bob could manage over to Ayşe");
  });
});
