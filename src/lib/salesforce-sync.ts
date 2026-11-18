import type { PropertyType, StatusGroup } from "./property-types";

/**
 * Keeping a database in step with one object of a Salesforce org, one way (server/salesforce-sync
 * for setting it up and the calls, server/jira-sync/run for the runs, which every synced database
 * shares): each record is a row, found again by its Id. Pure, shared by the server, the import
 * dialog and the sync's dialog on the database.
 *
 * Records are read with SOQL (`GET /services/data/vXX.0/query`), signed in as a connected app with
 * the client credentials flow, which runs as the user the app names. A run asks only for what
 * changed since the newest `SystemModstamp` it has seen (`SalesforceQuery.since`), up to
 * SALESFORCE_PER_RUN records, so a big org is brought over in a few runs. Records deleted in
 * Salesforce stay as rows. Each object has a fixed set of standard fields (SALESFORCE_FIELDS).
 */

/** The REST API version the calls use. */
export const SALESFORCE_API_VERSION = "v62.0";
/** Records one run takes at most; the next run goes on from the newest of them. */
export const SALESFORCE_PER_RUN = 10_000;
/** Where the setup is described in Salesforce's own help. */
export const SALESFORCE_HELP_URL = "https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_client_credentials_flow.htm&type=5";

export const SALESFORCE_OBJECTS = ["Account", "Contact", "Opportunity", "Lead", "Case"] as const;
export type SalesforceObject = (typeof SALESFORCE_OBJECTS)[number];
export const isSalesforceObject = (value: unknown): value is SalesforceObject => SALESFORCE_OBJECTS.includes(value as SalesforceObject);

/** What a sync remembers between runs (the `query` column): the object, the newest change seen and how many records it holds. */
export type SalesforceQuery = { object: SalesforceObject; since: string | null; total: number };

type Kind = "text" | "number" | "select" | "date" | "url" | "email" | "phone" | "status" | "person";
/** One standard field a sync writes: `key` names its property (texts `import.salesforce.names.fields`), `path` is its SOQL path. */
type FieldSpec = { key: string; kind: Kind; path: string; /** Person: the path of the owner's email, where the relation is to users only. */ emailPath?: string };

const f = (key: string, kind: Kind, path: string, emailPath?: string): FieldSpec => ({ key, kind, path, emailPath });
const owner = (users: boolean) => f("owner", "person", "Owner.Name", users ? "Owner.Email" : undefined);

/** The fields of each object, and the one that is a row's title and the flag that closes a status. */
export const SALESFORCE_OBJECT_SPECS: Record<SalesforceObject, { title: string; closedFlag?: string; fields: FieldSpec[] }> = {
  Account: {
    title: "Name",
    fields: [
      f("industry", "select", "Industry"),
      f("type", "select", "Type"),
      f("website", "url", "Website"),
      f("phone", "phone", "Phone"),
      f("city", "text", "BillingCity"),
      f("country", "text", "BillingCountry"),
      f("revenue", "number", "AnnualRevenue"),
      f("employees", "number", "NumberOfEmployees"),
      owner(true),
    ],
  },
  Contact: {
    title: "Name",
    fields: [
      f("email", "email", "Email"),
      f("phone", "phone", "Phone"),
      f("jobTitle", "text", "Title"),
      f("department", "text", "Department"),
      f("account", "text", "Account.Name"),
      f("city", "text", "MailingCity"),
      f("country", "text", "MailingCountry"),
      owner(true),
    ],
  },
  Opportunity: {
    title: "Name",
    closedFlag: "IsClosed",
    fields: [
      f("stage", "status", "StageName"),
      f("amount", "number", "Amount"),
      f("closeDate", "date", "CloseDate"),
      f("probability", "number", "Probability"),
      f("type", "select", "Type"),
      f("leadSource", "select", "LeadSource"),
      f("account", "text", "Account.Name"),
      owner(true),
    ],
  },
  Lead: {
    title: "Name",
    closedFlag: "IsConverted",
    fields: [
      f("company", "text", "Company"),
      f("email", "email", "Email"),
      f("phone", "phone", "Phone"),
      f("status", "status", "Status"),
      f("leadSource", "select", "LeadSource"),
      f("industry", "select", "Industry"),
      owner(false),
    ],
  },
  Case: {
    title: "Subject",
    closedFlag: "IsClosed",
    fields: [
      f("caseNumber", "text", "CaseNumber"),
      f("status", "status", "Status"),
      f("priority", "select", "Priority"),
      f("origin", "select", "Origin"),
      f("type", "select", "Type"),
      f("account", "text", "Account.Name"),
      f("contact", "text", "Contact.Name"),
      f("created", "date", "CreatedDate"),
      owner(false),
    ],
  },
};

/** Every field key of any object: what the names a new sync makes are given for. */
export const SALESFORCE_FIELD_KEYS = [
  ...new Set(SALESFORCE_OBJECTS.flatMap((o) => SALESFORCE_OBJECT_SPECS[o].fields.map((spec) => spec.key))),
] as string[];

/** The properties a sync writes: `id`, `modified` and `link`, and each field of the object by its key (and `ownerOthers`). */
export type SalesforceMapping = { id: string; modified?: string; link?: string; fields: Record<string, string> };

/** Names of the properties and view a new sync makes, in its maker's language. */
export type SalesforceNames = {
  id: string;
  modified: string;
  link: string;
  board: string;
  others: (column: string) => string;
  /** By field key (SALESFORCE_FIELD_KEYS). */
  fields: Record<string, string>;
};

export const ENGLISH_SALESFORCE_NAMES: SalesforceNames = {
  id: "Id",
  modified: "Modified",
  link: "Salesforce link",
  board: "Board",
  others: (column) => `${column} (others)`,
  fields: {
    industry: "Industry",
    type: "Type",
    website: "Website",
    phone: "Phone",
    city: "City",
    country: "Country",
    revenue: "Annual revenue",
    employees: "Employees",
    owner: "Owner",
    email: "Email",
    jobTitle: "Job title",
    department: "Department",
    account: "Account",
    stage: "Stage",
    amount: "Amount",
    closeDate: "Close date",
    probability: "Probability",
    leadSource: "Lead source",
    company: "Company",
    status: "Status",
    caseNumber: "Case number",
    priority: "Priority",
    origin: "Origin",
    contact: "Contact",
    created: "Created",
  },
};

/** The property type a field is written to (the kinds are property types). */
export const fieldType = (kind: Kind): PropertyType => kind;

/** The type each mapped property must still have to be written (for liveFields), keyed as `flatMapping` is. */
export function salesforceTypes(object: SalesforceObject): Record<string, PropertyType> {
  const types: Record<string, PropertyType> = { id: "text", modified: "date", link: "url" };
  for (const spec of SALESFORCE_OBJECT_SPECS[object].fields) {
    types[spec.key] = fieldType(spec.kind);
    if (spec.kind === "person") types[`${spec.key}Others`] = "text";
  }
  return types;
}

/** The mapping with its fields beside `id`, `modified` and `link` (what liveFields reads). */
export const flatMapping = (mapping: SalesforceMapping): Record<string, string> => {
  const flat: Record<string, string> = { ...mapping.fields, id: mapping.id };
  if (mapping.modified) flat.modified = mapping.modified;
  if (mapping.link) flat.link = mapping.link;
  return flat;
};

const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/**
 * An org's My Domain address from what someone typed: its name ("acme"), its host
 * ("acme.my.salesforce.com", "acme.sandbox.my.salesforce.com") or an address, as an origin, https
 * unless written as http (which only a host allowed for connections can use). The Lightning host
 * ("….lightning.force.com") is turned into the My Domain host, the only one that signs in. Null when
 * it isn't one.
 */
export function salesforceSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 300 || /\s/.test(text)) return null;
  if (SUBDOMAIN.test(text)) return `https://${text.toLowerCase()}.my.salesforce.com`;
  // Anything else is a host or an address: it has a dot, or a scheme (a stand-in on localhost).
  if (!text.includes(".") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || !url.hostname) return null;
  const lightning = /^(.+)\.lightning\.force\.com$/i.exec(url.hostname);
  if (lightning) return `https://${lightning[1].toLowerCase()}.my.salesforce.com`;
  return url.origin;
}

/** A query (the sync's state) from stored JSON; null when it isn't usable. */
export function parseSalesforceQuery(value: unknown): SalesforceQuery | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!isSalesforceObject(input.object)) return null;
  const since = typeof input.since === "string" && !Number.isNaN(Date.parse(input.since)) ? new Date(input.since).toISOString() : null;
  const total = typeof input.total === "number" && Number.isFinite(input.total) && input.total >= 0 ? Math.floor(input.total) : 0;
  return { object: input.object, since, total };
}

/** SOQL's date-time literal for an instant, in whole seconds (`2026-10-01T10:00:00Z`). */
const soqlTime = (iso: string) => `${new Date(iso).toISOString().slice(0, 19)}Z`;

/** The paths a run selects: the Id and the change time, the title, the closing flag and every field of the object. */
export function selectedPaths(object: SalesforceObject): string[] {
  const spec = SALESFORCE_OBJECT_SPECS[object];
  const paths = ["Id", "SystemModstamp", spec.title, ...(spec.closedFlag ? [spec.closedFlag] : [])];
  for (const field of spec.fields) paths.push(field.path, ...(field.emailPath ? [field.emailPath] : []));
  return [...new Set(paths)];
}

/**
 * The SOQL a run sends: everything changed since the newest change seen (inclusive: a record
 * changed in that same second is written again, harmlessly), oldest first, so a run that stops at
 * its limit leaves the rest for the next.
 */
export function soqlOf(query: SalesforceQuery): string {
  const where = query.since ? ` WHERE SystemModstamp >= ${soqlTime(query.since)}` : "";
  return `SELECT ${selectedPaths(query.object).join(", ")} FROM ${query.object}${where} ORDER BY SystemModstamp ASC`;
}

/** One record as a row: what the sync writes, before it is matched to the database's properties. */
export type SalesforceRow = {
  id: string;
  title: string;
  /** ISO timestamp. */
  modified: string | null;
  /** The record's status is a closed one (a won or lost opportunity, a converted lead, a closed case). */
  closed: boolean;
  /** By field key: text, a number, an ISO time or day, or null. */
  values: Record<string, string | number | null>;
  owner: { name: string; email: string | null } | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** A value at a SOQL path ("Account.Name") of a record. */
function at(item: Record<string, unknown>, path: string): unknown {
  let value: unknown = item;
  for (const step of path.split(".")) {
    value = record(value)?.[step];
    if (value === undefined || value === null) return null;
  }
  return value;
}

/** An ISO time from what Salesforce writes ("2026-10-01T10:00:00.000+0000"), or a day as it is. */
function time(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const fixed = value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  return Number.isNaN(Date.parse(fixed)) ? null : new Date(fixed).toISOString();
}

/** One record of a query answer as a row, or null when it has no Id. */
export function recordRow(value: unknown, object: SalesforceObject): SalesforceRow | null {
  const item = record(value);
  const id = text(item?.Id);
  if (!item || !id) return null;
  const spec = SALESFORCE_OBJECT_SPECS[object];
  const values: SalesforceRow["values"] = {};
  let ownerOf: SalesforceRow["owner"] = null;
  for (const field of spec.fields) {
    const raw = at(item, field.path);
    if (field.kind === "person") {
      const name = text(raw);
      ownerOf = name ? { name, email: field.emailPath ? text(at(item, field.emailPath)) : null } : null;
    } else if (field.kind === "number") {
      values[field.key] = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    } else if (field.kind === "date") {
      values[field.key] = time(raw);
    } else if (field.kind === "url") {
      const url = text(raw);
      values[field.key] = url ? (/^https?:\/\//i.test(url) ? url : `https://${url}`) : null;
    } else {
      values[field.key] = text(raw);
    }
  }
  return {
    id,
    title: (text(at(item, spec.title)) ?? (object === "Case" ? text(at(item, "CaseNumber")) : null) ?? id).slice(0, 2000),
    modified: time(item.SystemModstamp),
    closed: spec.closedFlag ? at(item, spec.closedFlag) === true : false,
    values,
    owner: ownerOf,
  };
}

/** A page of a query answer: its records, and the address of the next page (null on the last). */
export function queryPage(body: unknown): { records: unknown[]; next: string | null } | null {
  const page = record(body);
  if (!page || !Array.isArray(page.records)) return null;
  return { records: page.records, next: page.done === true ? null : text(page.nextRecordsUrl) };
}

/** The first message of a Salesforce error answer (`[{ message, errorCode }]`), if any. */
export function salesforceErrorMessage(body: unknown): string | null {
  const first = Array.isArray(body) ? record(body[0]) : record(body);
  const message = text(first?.message) ?? text(first?.error_description) ?? text(first?.error);
  return message ? message.slice(0, 300) : null;
}

/** Whether Salesforce's error answer is its rate or request limit (it passes: the next run tries again). */
export const isSalesforceLimit = (body: unknown) => Array.isArray(body) && record(body[0])?.errorCode === "REQUEST_LIMIT_EXCEEDED";

/** The group a status option goes to: a closed record's is done, an open one's in progress. */
export const salesforceStatusGroup = (closed: boolean): StatusGroup => (closed ? "done" : "in_progress");

/** Status options and select options a run needs, by field key, in first-seen order. */
export function salesforceOptionsNeeded(object: SalesforceObject, rows: SalesforceRow[]) {
  const needed: Record<string, { name: string; group?: StatusGroup }[]> = {};
  for (const field of SALESFORCE_OBJECT_SPECS[object].fields) {
    if (field.kind !== "select" && field.kind !== "status") continue;
    const seen = new Map<string, { name: string; group?: StatusGroup }>();
    for (const row of rows) {
      const name = row.values[field.key];
      if (typeof name !== "string") continue;
      const known = seen.get(name.toLowerCase());
      // A status that some record of it has closed counts as closed.
      if (!known) seen.set(name.toLowerCase(), field.kind === "status" ? { name, group: salesforceStatusGroup(row.closed) } : { name });
      else if (field.kind === "status" && row.closed) known.group = "done";
    }
    needed[field.key] = [...seen.values()];
  }
  return needed;
}

/** A record's link in Lightning Experience (the org redirects it to the right host). */
export const salesforceLink = (siteUrl: string, object: SalesforceObject, id: string) =>
  `${siteUrl}/lightning/r/${object}/${encodeURIComponent(id)}/view`;

/**
 * The values a row gets from its record, keyed by property id, as normalizeRowProperties takes
 * them. Every mapped property gets a value, null to clear it: the record is the source. `person`
 * finds the workspace's person an owner is (null for none).
 */
export function salesforceValues(
  row: SalesforceRow,
  object: SalesforceObject,
  siteUrl: string,
  mapping: Partial<Record<string, string>>,
  person: (owner: { name: string; email: string | null }) => string | null,
) {
  const values: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    const id = mapping[key];
    if (id) values[id] = value;
  };
  set("id", row.id);
  set("modified", row.modified);
  set("link", salesforceLink(siteUrl, object, row.id));
  for (const field of SALESFORCE_OBJECT_SPECS[object].fields) {
    if (field.kind === "person") {
      const found = row.owner ? person(row.owner) : null;
      set(field.key, found ? [found] : null);
      // Someone the workspace doesn't have goes in the text beside; without that text, nowhere.
      set(`${field.key}Others`, row.owner && !(found && mapping[field.key]) ? row.owner.name : null);
    } else set(field.key, row.values[field.key] ?? null);
  }
  return values;
}
