/**
 * The workspace audit log (Settings > Audit log, issue #61): which changes are recorded, how they
 * are grouped and filtered, how an event reads, and its CSV. Pure, for the server (server/audit.ts,
 * which records and lists events) and the settings tab alike.
 */

import { zoneOffset } from "./time-zone";

/**
 * Every recorded action, by the category the settings tab filters on. An action is stored as its
 * string, so renaming one leaves older events behind: add new ones instead.
 */
export const AUDIT_CATEGORIES = {
  members: ["member.added", "member.joined", "member.removed", "member.left", "member.role_changed", "member.ownership_transferred"],
  invitations: [
    "invitation.sent",
    "invitation.revoked",
    "invitation.accepted",
    "join_link.enabled",
    "join_link.disabled",
    "join_link.regenerated",
    "join_request.approved",
    "join_request.declined",
  ],
  sharing: [
    "page.permission_changed",
    "page.permission_removed",
    "access_request.approved",
    "access_request.declined",
    "property.access_changed",
  ],
  teamspaces: [
    "teamspace.created",
    "teamspace.updated",
    "teamspace.archived",
    "teamspace.restored",
    "teamspace.member_added",
    "teamspace.member_removed",
    "teamspace.role_changed",
    "teamspace.group_added",
    "teamspace.group_removed",
  ],
  groups: ["group.created", "group.renamed", "group.deleted", "group.members_added", "group.members_removed"],
  settings: ["workspace.renamed", "workspace.settings_changed"],
  security: ["sso.configured", "sso.domains_verified", "sso.removed", "scim.token_created", "scim.token_revoked"],
  pages: ["page.deleted", "page.published", "page.unpublished", "page.publication_revoked", "site.saved", "site.removed"],
  integrations: [
    "connected_app.connected",
    "connected_app.revoked",
    "api_token.created",
    "api_token.revoked",
    "automation.created",
    "automation.updated",
    "automation.deleted",
  ],
  agents: ["agent.created", "agent.updated", "agent.archived"],
  connections: [
    "connection.created",
    "connection.updated",
    "connection.deleted",
    "connection.tool_called",
    "connection.approval_decided",
  ],
  exports: ["export.workspace", "export.page"],
} as const;

export type AuditCategory = keyof typeof AUDIT_CATEGORIES;
export type AuditAction = (typeof AUDIT_CATEGORIES)[AuditCategory][number];

export const AUDIT_CATEGORY_NAMES = Object.keys(AUDIT_CATEGORIES) as AuditCategory[];
export const AUDIT_ACTIONS: readonly AuditAction[] = Object.values(AUDIT_CATEGORIES).flat();

const CATEGORY_OF = new Map<string, AuditCategory>(
  AUDIT_CATEGORY_NAMES.flatMap((category) => AUDIT_CATEGORIES[category].map((action) => [action, category] as const)),
);

/** The category of a stored action; null for one this version doesn't know. */
export function auditCategoryOf(action: string): AuditCategory | null {
  return CATEGORY_OF.get(action) ?? null;
}

export const isAuditCategory = (value: unknown): value is AuditCategory =>
  typeof value === "string" && Object.hasOwn(AUDIT_CATEGORIES, value);

/**
 * Who made a change:
 * - `user`: a person in the app;
 * - `agent`: one of the workspace's agents (see lib/agents.ts), acting as its own user;
 * - `api_token`, `connected_app`: a program acting for a person (a REST API token, an MCP client
 *   they authorized), which still names that person;
 * - `scim`: the workspace's identity provider, through one of its SCIM tokens;
 * - `system`: the server itself (the daily retention cleanup).
 */
export const AUDIT_ACTOR_KINDS = ["user", "agent", "api_token", "connected_app", "scim", "system"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** What an event is about: `targetId` is that thing's id (an email address for `email`). */
export type AuditTargetType =
  | "user"
  | "email"
  | "page"
  | "teamspace"
  | "group"
  | "workspace"
  | "sso"
  | "scim_token"
  | "api_token"
  | "connected_app"
  | "join_link"
  | "site"
  | "connection";

/** A stored event, as the list and the CSV show it. Names are as they were when it happened. */
export type AuditEvent = {
  id: string;
  action: string;
  actorKind: AuditActorKind;
  actorUserId: string | null;
  actorName: string;
  actorEmail: string | null;
  /** The program that acted: the API token's, connected app's or SCIM token's name. */
  actorVia: string | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string;
  details: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
};

// --------------------------------------------------------------------------------------- filters

export const AUDIT_PAGE_SIZE = 50;
/** Pages beyond this are refused: narrow the filters (or download the CSV) instead. */
export const AUDIT_MAX_PAGE = 200;
/** The CSV holds at most this many events, newest first. */
export const AUDIT_CSV_LIMIT = 10_000;

/** One person (whatever they acted through), or the identity provider, or the server. */
export type AuditActorFilter = { userId: string } | { kind: "agent" | "scim" | "system" };

export type AuditFilters = {
  actor: AuditActorFilter | null;
  category: AuditCategory | null;
  /** Calendar days (YYYY-MM-DD) in the viewer's time zone, both included. */
  from: string | null;
  to: string | null;
  /** 1-based. */
  page: number;
};

type Query = URLSearchParams | Record<string, string | string[] | undefined>;

function first(query: Query, key: string): string | null {
  const value = query instanceof URLSearchParams ? query.get(key) : query[key];
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" && one.trim() ? one.trim() : null;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as YYYY-MM-DD, or null. */
export function parseDay(value: string | null): string | null {
  if (!value || !DAY_PATTERN.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? value : null;
}

/** `u:<user id>` for a person (or an agent), `k:agent`, `k:scim` or `k:system`; as the actor select and links write it. */
export function encodeActorFilter(actor: AuditActorFilter): string {
  return "userId" in actor ? `u:${actor.userId}` : `k:${actor.kind}`;
}

export function parseActorFilter(value: string | null): AuditActorFilter | null {
  if (!value) return null;
  if (value === "k:agent" || value === "k:scim" || value === "k:system") return { kind: value.slice(2) as "agent" | "scim" | "system" };
  if (value.startsWith("u:") && value.length > 2 && value.length <= 200) return { userId: value.slice(2) };
  return null;
}

/**
 * The filters of the tab's URL (`actor`, `category`, `from`, `to`, `page`). Anything malformed is
 * ignored rather than refused, so a stale or hand-edited link still shows the log. A range given
 * backwards is turned around.
 */
export function parseAuditFilters(query: Query): AuditFilters {
  let from = parseDay(first(query, "from"));
  let to = parseDay(first(query, "to"));
  if (from && to && from > to) [from, to] = [to, from];
  const category = first(query, "category");
  const page = Number(first(query, "page"));
  return {
    actor: parseActorFilter(first(query, "actor")),
    category: isAuditCategory(category) ? category : null,
    from,
    to,
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, AUDIT_MAX_PAGE) : 1,
  };
}

/** The query string for these filters (without `?`), leaving out what isn't set and page 1. */
export function auditFilterQuery(filters: AuditFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (filters.actor) params.set("actor", encodeActorFilter(filters.actor));
  if (filters.category) params.set("category", filters.category);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.page > 1) params.set("page", String(filters.page));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

/** The instant a calendar day starts in `timeZone` (midnight there, whatever daylight saving does). */
export function startOfDayIn(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  let start = midnightUtc - zoneOffset(midnightUtc, timeZone);
  // The offset at the guess can differ from the one at midnight itself across a change of clocks.
  start = midnightUtc - zoneOffset(start, timeZone);
  return new Date(start);
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The filters' days as instants: from the start of `from` up to (not including) the day after `to`. */
export function auditDateRange(filters: Pick<AuditFilters, "from" | "to">, timeZone = "UTC") {
  return {
    since: filters.from ? startOfDayIn(filters.from, timeZone) : null,
    until: filters.to ? startOfDayIn(nextDay(filters.to), timeZone) : null,
  };
}

// ---------------------------------------------------------------------------------- descriptions

/**
 * A translator of the `settings` namespace, as next-intl's `getTranslations("settings")` or
 * `createTranslator` give it: texts are under `audit.`.
 */
export type AuditTranslator = {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
};

const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A translated text when the key exists, else the fallback (an unknown stored value, say). */
function known(t: AuditTranslator, key: string, fallback: string) {
  return t.has(key) ? t(key) : fallback;
}

/** Who acted, for the log's first column and the CSV's. */
export function auditActorName(event: Pick<AuditEvent, "actorKind" | "actorName" | "actorEmail" | "actorVia">, t: AuditTranslator) {
  const person = event.actorName || event.actorEmail || t("audit.actors.deletedUser");
  const via = event.actorVia || t("audit.actors.unnamed");
  switch (event.actorKind) {
    case "api_token":
      return t("audit.actors.apiToken", { name: person, via });
    case "connected_app":
      return t("audit.actors.connectedApp", { name: person, via });
    case "scim":
      return t("audit.actors.scim", { via });
    case "system":
      return t("audit.actors.system");
    case "agent":
      return t("audit.actors.agent", { name: person });
    default:
      return person;
  }
}

function role(t: AuditTranslator, value: unknown) {
  return known(t, `audit.roles.${text(value)}`, text(value));
}

function level(t: AuditTranslator, value: unknown) {
  return known(t, `audit.levels.${text(value)}`, text(value));
}

/** A setting's value as people read it: its choice's name, on/off, a number of days, a list. */
export function settingValue(t: AuditTranslator, key: string, value: unknown): string {
  if (value === undefined || value === null) return t("audit.values.unset");
  if (typeof value === "boolean") return t(value ? "audit.values.on" : "audit.values.off");
  if (key === "trashRetentionDays" && typeof value === "number") {
    return value === 0 ? t("audit.values.never") : t("audit.values.days", { days: value });
  }
  if (Array.isArray(value)) return value.length ? list(value).join(", ") : t("audit.values.none");
  return known(t, `audit.values.${text(value)}`, text(value));
}

/** "Who can publish to the web: Members → Owners; Allow export: On → Off". */
export function settingChanges(t: AuditTranslator, changes: unknown): string {
  return Object.entries(record(changes))
    .map(([key, change]) => {
      const { from, to } = record(change);
      const name = known(t, `audit.settingNames.${key}`, key);
      return t("audit.change", { name, from: settingValue(t, key, from), to: settingValue(t, key, to) });
    })
    .join("; ");
}

const TEAMSPACE_FIELDS = ["name", "icon", "description", "access", "memberLevel"] as const;

/**
 * What the event did, in the viewer's language, without the actor (the log shows them apart):
 * "Changed the role of Ada from Member to Owner". Actions this version doesn't know read as their
 * stored name.
 */
export function describeAuditEvent(event: Pick<AuditEvent, "action" | "targetLabel" | "details">, t: AuditTranslator): string {
  const d = record(event.details);
  const target = event.targetLabel || t("audit.untitled");
  // Whom a permission, a request or a teamspace role was about: a person (gone since, perhaps), a
  // group or everyone in the workspace.
  const subject =
    d.subjectType === "everyone"
      ? t("audit.everyone")
      : text(d.subject) || text(d.subjectEmail) || t(d.subjectType === "user" ? "audit.actors.deletedUser" : "audit.untitled");
  const values: Record<string, string | number> = {
    target,
    subject,
    role: role(t, d.role),
    from: text(d.from),
    to: text(d.to),
    level: level(t, d.level),
    names: list(d.names).join(", "),
    count: typeof d.count === "number" ? d.count : list(d.names).length,
    kind: text(d.kind) || "join",
    via: known(t, `audit.via.${text(d.via)}`, text(d.via)),
    format: known(t, `audit.formats.${text(d.format)}`, text(d.format)),
    protocol: text(d.protocol).toUpperCase(),
    domains: list(d.domains).join(", "),
    slug: text(d.slug),
    property: text(d.property),
    name: text(d.name),
    tool: text(d.tool),
    agent: text(d.agent),
    decision: known(t, `audit.decisions.${text(d.decision)}`, text(d.decision)),
    outcome: known(t, `audit.outcomes.${text(d.outcome)}`, text(d.outcome)),
  };
  switch (event.action) {
    case "member.role_changed":
      values.from = role(t, d.from);
      values.to = role(t, d.to);
      break;
    case "teamspace.role_changed":
      values.role = known(t, `audit.teamspaceRoles.${text(d.role)}`, text(d.role));
      break;
    case "teamspace.member_added":
      values.role = known(t, `audit.teamspaceRoles.${text(d.role)}`, text(d.role));
      break;
    case "teamspace.updated": {
      const changes = record(d.changes);
      values.fields = TEAMSPACE_FIELDS.filter((field) => field in changes)
        .map((field) => t(`audit.teamspaceFields.${field}`))
        .join(", ");
      break;
    }
    case "workspace.settings_changed":
      values.settings = settingChanges(t, d.changes);
      break;
    case "export.workspace":
      values.count = typeof d.pages === "number" ? d.pages : 0;
      break;
    case "agent.updated":
    case "automation.updated": {
      // Turning it on or off reads as such; any other change as a change.
      const previous = record(d.previous);
      values.change =
        typeof d.enabled === "boolean" && typeof previous.enabled === "boolean" && d.enabled !== previous.enabled
          ? d.enabled
            ? "on"
            : "off"
          : "other";
      break;
    }
  }
  const key = `audit.actions.${event.action}`;
  return t.has(key) ? t(key, values) : event.action;
}

// ------------------------------------------------------------------------------------------- CSV

type Cell = string | number | Date | null;

/** The events as CSV rows, header first: descriptions in the viewer's language, the rest as stored. */
export function auditCsvRows(events: AuditEvent[], t: AuditTranslator): Cell[][] {
  return [
    ["time", "actor", "actor_email", "actor_type", "via", "action", "category", "description", "target", "ip", "user_agent", "details"],
    ...events.map((e) => [
      e.createdAt,
      auditActorName(e, t),
      e.actorEmail,
      e.actorKind,
      e.actorVia,
      e.action,
      auditCategoryOf(e.action),
      describeAuditEvent(e, t),
      e.targetLabel || null,
      e.ip,
      e.userAgent,
      Object.keys(e.details).length ? JSON.stringify(e.details) : null,
    ]),
  ];
}
