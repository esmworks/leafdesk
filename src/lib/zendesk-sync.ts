import type { StatusGroup } from "./property-types";

/**
 * Keeping a database in step with a Zendesk Support account's tickets, one way (server/zendesk-sync
 * for setting it up and the calls, server/jira-sync/run for the runs, which every synced database
 * shares): each ticket is a row, found again by its number. Pure, shared by the server, the import
 * dialog and the sync's dialog on the database.
 *
 * Tickets come from the incremental export (`GET /api/v2/incremental/tickets/cursor`, which needs
 * an agent with the admin role), signed in with an email address and API token. A run asks only for
 * what changed since the newest ticket it has seen (`ZendeskQuery.since`), up to ZENDESK_PER_RUN
 * tickets, so a big account is brought over in a few runs. Requesters and assignees are users of the
 * Zendesk account, found by email address in the workspace like Jira's people.
 */

export const ZENDESK_PAGE_SIZE = 1000;
/** Tickets one run takes at most; the next run goes on from the newest of them. */
export const ZENDESK_PER_RUN = 5000;
/** Users asked for in one request (`users/show_many`'s ceiling). */
export const ZENDESK_USERS_PER_REQUEST = 100;
/** Where people make an API token (Admin Center > Apps and integrations > APIs). */
export const ZENDESK_TOKENS_URL = "https://support.zendesk.com/hc/en-us/articles/4408889192858";

/** A ticket's status, as the status property shows it ("deleted" is a ticket the incremental export reports as gone). */
export const ZENDESK_STATUSES = ["new", "open", "pending", "hold", "solved", "closed", "deleted"] as const;
export type ZendeskStatus = (typeof ZENDESK_STATUSES)[number];
export const ZENDESK_STATUS_GROUPS: Record<ZendeskStatus, StatusGroup> = {
  new: "todo",
  open: "in_progress",
  pending: "in_progress",
  hold: "in_progress",
  solved: "done",
  closed: "done",
  deleted: "done",
};

/** What a sync remembers between runs (the `query` column): the newest update seen (epoch seconds) and how many tickets it holds. */
export type ZendeskQuery = { since: number | null; total: number };

/** The properties a sync writes, by what each holds (their ids in the database), and the names of the status options. */
export type ZendeskMapping = {
  id: string;
  status?: string;
  priority?: string;
  type?: string;
  requester?: string;
  /** Text: the requester's name when no one in the workspace is them. */
  requesterOthers?: string;
  assignee?: string;
  assigneeOthers?: string;
  tags?: string;
  created?: string;
  updated?: string;
  link?: string;
  /** The status option each status writes, by name (made in the language of whoever set it up). */
  statuses: Record<ZendeskStatus, string>;
};
export type ZendeskField = Exclude<keyof ZendeskMapping, "statuses">;

/** Names of the properties, status options and view a new sync makes, in its maker's language. */
export type ZendeskNames = {
  id: string;
  status: string;
  priority: string;
  type: string;
  requester: string;
  assignee: string;
  others: (column: string) => string;
  tags: string;
  created: string;
  updated: string;
  link: string;
  board: string;
  statuses: Record<ZendeskStatus, string>;
};

export const ENGLISH_ZENDESK_NAMES: ZendeskNames = {
  id: "Ticket",
  status: "Status",
  priority: "Priority",
  type: "Type",
  requester: "Requester",
  assignee: "Assignee",
  others: (column) => `${column} (others)`,
  tags: "Tags",
  created: "Created",
  updated: "Updated",
  link: "Zendesk link",
  board: "Board",
  statuses: { new: "New", open: "Open", pending: "Pending", hold: "On hold", solved: "Solved", closed: "Closed", deleted: "Deleted" },
};

const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/**
 * A Zendesk account's address from what someone typed: its subdomain ("acme"), its host
 * ("acme.zendesk.com") or an address ("https://acme.zendesk.com/agent/..."), as an origin, https
 * unless written as http (which only a host allowed for connections can use). Null when it isn't one.
 */
export function zendeskSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 300 || /\s/.test(text)) return null;
  if (SUBDOMAIN.test(text)) return `https://${text.toLowerCase()}.zendesk.com`;
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
  return url.origin;
}

/** One ticket as a row: what the sync writes, before it is matched to the database's properties. */
export type ZendeskRow = {
  id: number;
  title: string;
  status: ZendeskStatus | null;
  priority: string | null;
  type: string | null;
  requesterId: number | null;
  assigneeId: number | null;
  tags: string[];
  /** ISO timestamps. */
  created: string | null;
  updated: string | null;
  link: string;
};

/** A Zendesk user as the account names them. */
export type ZendeskUser = { name: string; email: string | null };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const time = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);
const userId = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

/** One ticket of an export page as a row, or null when it has no id. */
export function ticketRow(value: unknown, siteUrl: string): ZendeskRow | null {
  const ticket = record(value);
  const id = ticket?.id;
  if (!ticket || typeof id !== "number" || !Number.isInteger(id) || id < 1) return null;
  const status = ZENDESK_STATUSES.find((s) => s === ticket.status) ?? null;
  const tags = (Array.isArray(ticket.tags) ? ticket.tags : []).map(text).filter((t): t is string => t !== null);
  return {
    id,
    title: (text(ticket.subject) ?? text(ticket.raw_subject) ?? `#${id}`).slice(0, 2000),
    status,
    priority: text(ticket.priority),
    type: text(ticket.type),
    requesterId: userId(ticket.requester_id),
    assigneeId: userId(ticket.assignee_id),
    tags: [...new Set(tags)],
    created: time(ticket.created_at),
    updated: time(ticket.updated_at),
    link: `${siteUrl}/agent/tickets/${id}`,
  };
}

/** A page of the incremental export: its tickets, the cursor of the next page, and whether it was the last. */
export function exportPage(body: unknown): { tickets: unknown[]; cursor: string | null; end: boolean } | null {
  const page = record(body);
  if (!page || !Array.isArray(page.tickets)) return null;
  return { tickets: page.tickets, cursor: text(page.after_cursor), end: page.end_of_stream === true };
}

/** The users of a `users/show_many` answer, by id. */
export function usersOf(body: unknown): Map<number, ZendeskUser> {
  const users = new Map<number, ZendeskUser>();
  const list = record(body)?.users;
  if (!Array.isArray(list)) return users;
  for (const value of list) {
    const user = record(value);
    const id = userId(user?.id);
    const email = text(user?.email);
    const name = text(user?.name) ?? email;
    if (id && name) users.set(id, { name, email });
  }
  return users;
}

/** A query (the sync's state) from stored JSON; a fresh one when it isn't usable. */
export function parseZendeskQuery(value: unknown): ZendeskQuery {
  const input = record(value);
  const since = typeof input?.since === "number" && Number.isFinite(input.since) && input.since >= 0 ? Math.floor(input.since) : null;
  const total = typeof input?.total === "number" && Number.isFinite(input.total) && input.total >= 0 ? Math.floor(input.total) : 0;
  return { since, total };
}

/** Option names a run needs in the select and multi-select properties, in first-seen order. */
export function zendeskOptionsNeeded(rows: ZendeskRow[]) {
  const distinct = (values: string[]) => {
    const seen = new Map<string, string>();
    for (const v of values) if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
    return [...seen.values()];
  };
  return {
    priority: distinct(rows.flatMap((r) => (r.priority ? [r.priority] : []))),
    type: distinct(rows.flatMap((r) => (r.type ? [r.type] : []))),
    tags: distinct(rows.flatMap((r) => r.tags)),
  };
}

/**
 * The values a row gets from its ticket, keyed by property id, as normalizeRowProperties takes them.
 * Every mapped property gets a value, null to clear it: the ticket is the source. `users` are the
 * account's users by id, `person` finds the workspace's person one is (null for none).
 */
export function ticketValues(
  row: ZendeskRow,
  mapping: Partial<ZendeskMapping>,
  users: Map<number, ZendeskUser>,
  person: (user: ZendeskUser) => string | null,
) {
  const values: Record<string, unknown> = {};
  const set = (field: ZendeskField, value: unknown) => {
    const id = mapping[field];
    if (id) values[id] = value;
  };
  set("id", row.id);
  set("status", row.status ? (mapping.statuses?.[row.status] ?? null) : null);
  set("priority", row.priority);
  set("type", row.type);
  const requester = row.requesterId ? users.get(row.requesterId) : undefined;
  const requesterPerson = requester ? person(requester) : null;
  set("requester", requesterPerson ? [requesterPerson] : null);
  // Someone the workspace doesn't have goes in the text beside; without that text, nowhere.
  set("requesterOthers", requester && !(requesterPerson && mapping.requester) ? requester.name : null);
  const assignee = row.assigneeId ? users.get(row.assigneeId) : undefined;
  const assigneePerson = assignee ? person(assignee) : null;
  set("assignee", assigneePerson ? [assigneePerson] : null);
  set("assigneeOthers", assignee && !(assigneePerson && mapping.assignee) ? assignee.name : null);
  set("tags", row.tags.length ? row.tags : null);
  set("created", row.created);
  set("updated", row.updated);
  set("link", row.link);
  return values;
}
