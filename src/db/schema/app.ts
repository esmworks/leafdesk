import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { AiAutofillConfig } from "../../lib/ai";
import type { AggregateFn, RollupDisplay, RollupFn } from "../../lib/aggregate";
import type { FormulaResultType } from "../../lib/formula/types";
import { PROPERTY_TYPES, type PropertyType, type StatusGroup } from "../../lib/property-types";
import type { PageBackground } from "../../lib/page-background";
import type { SidebarLayout } from "../../lib/sidebar-sections";
import { user } from "./auth";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Workspace-wide policies, changed by owners in Settings > Security. */
export type WorkspaceSettings = {
  /** Who may share pages with people outside the workspace, bringing them in as guests. */
  guestInvites: "owners" | "members";
  /** Whether guests may add top-level pages, which only they can see. */
  guestPrivatePages: boolean;
  /**
   * Who may publish pages and open forms to the web; guests never can. "off": nobody, and what is
   * already published stops being served (published pages, the workspace's site, public forms)
   * without being deleted, so turning publishing back on brings it all back.
   */
  publishing: "owners" | "members" | "off";
  /**
   * Everyone must use two-step verification (an authenticator app, or a passkey sign-in) to open
   * the workspace in the app. Doesn't apply to connected apps (MCP), which use their own tokens.
   */
  requireTwoFactor: boolean;
  /** Who may create teamspaces. Guests never can. */
  teamspaceCreation: "owners" | "members";
  /**
   * How members may sign in to open the workspace: any way, or only through its single sign-on
   * (its own connection, or the instance's provider). Owners keep their other ways in, so a broken
   * identity provider can't lock the workspace; guests are outside it. Like two-step verification,
   * it doesn't apply to connected apps (MCP) or API tokens.
   */
  loginMethod: "any" | "sso";
  /**
   * The AI writing assistant and AI autofill properties, when the server has an AI provider (see
   * server/ai). Owners can turn them off so no page content of the workspace goes to the provider.
   */
  ai: boolean;
  /**
   * Days a page stays in the trash before the daily cleanup deletes it for good, with its files
   * (see server/retention.ts); 0 keeps it until someone deletes it. One of TRASH_RETENTION_CHOICES.
   */
  trashRetentionDays: number;
  /**
   * Whether people may take the workspace's pages out as files: Markdown, CSV and ZIP exports and
   * the print view ("Export as PDF"). Reading pages through connected apps is `connectedApps`.
   */
  export: boolean;
  /**
   * What connected apps may do in the workspace: MCP clients a user authorized over OAuth and REST
   * API tokens alike (see server/connected-app.ts). "full": whatever their user may; "read": read
   * only, every change refused; "off": the workspace is hidden from them.
   */
  connectedApps: "full" | "read" | "off";
  /**
   * Whether someone who opens a link to a page they can't see may ask for access from the "You
   * don't have access" screen (see server/access-requests.ts). Guests and people outside the
   * workspace too: approving brings them in as guests, which the guest invite policy decides.
   */
  accessRequests: boolean;
  /**
   * Who may add members: owners only, members too but through a request an owner approves (see
   * server/join-requests.ts), or any member. Members add people as members, never as owners.
   */
  memberInvites: "owners" | "members_with_approval" | "any_member";
  /**
   * Email domains (subdomains included) whose people may come in on their own: someone who signs
   * up or in with a *verified* address on one of them joins as a member (`domainJoin: "join"`) or
   * sends a join request (`"request"`), once; after that the workspace waits in their switcher.
   */
  allowedDomains: string[];
  domainJoin: "join" | "request";
  /**
   * Who may ask to join when they can't join directly: nobody, people with an address on an
   * allowed domain (verified or not), or also anyone with the join link, which then asks an owner
   * instead of adding them right away.
   */
  joinRequests: "nobody" | "allowed_domains" | "anyone_with_link";
};

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  guestInvites: "owners",
  guestPrivatePages: false,
  publishing: "members",
  requireTwoFactor: false,
  teamspaceCreation: "members",
  loginMethod: "any",
  ai: true,
  trashRetentionDays: 30,
  export: true,
  connectedApps: "full",
  accessRequests: true,
  memberInvites: "owners",
  allowedDomains: [],
  domainJoin: "join",
  joinRequests: "nobody",
};

export const workspace = pgTable("workspace", {
  id: id(),
  name: text("name").notNull(),
  icon: text("icon"),
  /** Token of the shareable join link (joins as member); null while the link is turned off. */
  inviteLinkToken: text("invite_link_token").unique(),
  /** Only the policies an owner changed; `workspaceSettings` fills in the rest from the defaults. */
  settings: jsonb("settings").$type<Partial<WorkspaceSettings>>().notNull().default({}),
  ...timestamps,
});

/**
 * `owner` and `member` see every page unless a page permission restricts it; a `guest` sees only
 * pages shared with them and can't create top-level pages or see who else is in the workspace.
 */
export type WorkspaceRole = "owner" | "member" | "guest";

export const workspaceMember = pgTable(
  "workspace_member",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<WorkspaceRole>().notNull().default("member"),
    /**
     * Who brought them in: the person who added them or shared a page with them, who sent the
     * invitation they redeemed, or the owner who approved their request. Null when they came in on
     * their own (join link, allowed email domain, single sign-on, SCIM), made the workspace, or the
     * inviter's account is gone.
     */
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    /** How they arranged the sidebar in this workspace: section order, hidden and folded sections. */
    sidebar: jsonb("sidebar").$type<SidebarLayout>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("workspace_member_user_idx").on(t.userId)],
);

/**
 * A pending invitation for an email that has no account yet. The token in the invitation link is
 * the only way to redeem it, since email addresses are not verified.
 */
export const workspaceInvitation = pgTable(
  "workspace_invitation",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** Stored lowercased. */
    email: text("email").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull().default("member"),
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("workspace_invitation_email_idx").on(t.workspaceId, t.email)],
);

/**
 * Asking to be let into a workspace, decided by an owner (see server/join-requests.ts).
 * - `join`: `userId` asks to join as a member (through an allowed email domain, the join link or
 *   the workspace switcher). One row per person and workspace, kept after the decision: an
 *   `accepted` or `declined` row remembers that the domain rule already ran for them, so signing in
 *   again doesn't join or ask again. An owner removing someone leaves a `declined` row too, and
 *   someone leaving an `accepted` one.
 * - `invite`: `requestedBy`, a member, asks to invite `email` while the workspace wants members'
 *   invitations approved. Deleted once decided; approving sends the invitation.
 */
export type JoinRequestKind = "join" | "invite";
export type JoinRequestStatus = "pending" | "accepted" | "declined";
/** Where a request came from: an allowed email domain, the join link, the workspace switcher, a member. */
export type JoinRequestSource = "domain" | "link" | "switcher" | "member";

export const workspaceJoinRequest = pgTable(
  "workspace_join_request",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: text("kind").$type<JoinRequestKind>().notNull(),
    /** `join`: who asks to join. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** `join`: the requester's address when they asked; `invite`: who to invite. Lowercased. */
    email: text("email").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull().default("member"),
    /** Who asked: the requester themselves, or the member who wants to invite someone. */
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "cascade" }),
    /** Null for the rows left by someone leaving or being removed without having asked. */
    source: text("source").$type<JoinRequestSource>(),
    status: text("status").$type<JoinRequestStatus>().notNull().default("pending"),
    /** The asker's interface language when they asked, for the email about the decision. */
    locale: text("locale"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_join_request_user_idx").on(t.workspaceId, t.userId).where(sql`${t.kind} = 'join'`),
    uniqueIndex("workspace_join_request_invite_idx").on(t.workspaceId, t.email).where(sql`${t.kind} = 'invite'`),
    index("workspace_join_request_status_idx").on(t.workspaceId, t.status),
    check("workspace_join_request_kind_check", sql`${t.kind} in ('join', 'invite')`),
    check("workspace_join_request_status_check", sql`${t.status} in ('pending', 'accepted', 'declined')`),
    check("workspace_join_request_user_check", sql`${t.kind} <> 'join' or ${t.userId} is not null`),
  ],
);

/**
 * Who sees a teamspace and its pages (see `page_access_level`): owners and members of the
 * workspace only. Guests are never in a teamspace; they get single pages shared with them.
 * - `default`: every owner and member is in it and can't leave it.
 * - `open`: everyone sees it and can join; those who haven't can read and comment on its pages.
 * - `closed`: everyone sees that it exists, but only its members open its pages; its owners add them.
 * - `private`: only its members know it exists.
 */
export const TEAMSPACE_ACCESS = ["default", "open", "closed", "private"] as const;
export type TeamspaceAccess = (typeof TEAMSPACE_ACCESS)[number];
/** Teamspace owners change its settings and members; members add and edit its pages. */
export type TeamspaceRole = "owner" | "member";

/**
 * What a teamspace's members get on its pages when a page says nothing else (the page's own
 * "everyone" entry, or one it inherits, still decides). Its owners and the workspace's owners
 * get full access that way whatever this says.
 */
export const TEAMSPACE_MEMBER_LEVELS = ["full", "edit", "comment", "view"] as const;
export type TeamspaceMemberLevel = (typeof TEAMSPACE_MEMBER_LEVELS)[number];

export const teamspace = pgTable(
  "teamspace",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    description: text("description").notNull().default(""),
    access: text("access").$type<TeamspaceAccess>().notNull().default("open"),
    memberLevel: text("member_level").$type<TeamspaceMemberLevel>().notNull().default("full"),
    /** Archived teamspaces leave the sidebar and take no new pages; their pages keep their access. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    // Target of the page's (teamspace_id, workspace_id) key: a page never sits in another workspace's teamspace.
    unique("teamspace_id_workspace_key").on(t.id, t.workspaceId),
    index("teamspace_workspace_idx").on(t.workspaceId),
    check("teamspace_access_check", sql`${t.access} in ('default', 'open', 'closed', 'private')`),
    check("teamspace_member_level_check", sql`${t.memberLevel} in ('full', 'edit', 'comment', 'view')`),
  ],
);

/**
 * Who joined a teamspace, and who owns it. Everyone is in a `default` teamspace without a row;
 * rows there only name its owners.
 */
export const teamspaceMember = pgTable(
  "teamspace_member",
  {
    teamspaceId: text("teamspace_id")
      .notNull()
      .references(() => teamspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<TeamspaceRole>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamspaceId, t.userId] }),
    index("teamspace_member_user_idx").on(t.userId),
    check("teamspace_member_role_check", sql`${t.role} in ('owner', 'member')`),
  ],
);

export type PageKind = "page" | "database";
/** Values of a database row, keyed by property id. */
export type RowProperties = Record<string, unknown>;

export const page = pgTable(
  "page",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnyPgColumn => page.id, { onDelete: "cascade" }),
    /**
     * The teamspace the page's tree belongs to, set on every page of the tree (a trigger copies the
     * parent's; see drizzle/*_teamspaces.sql). Null for private pages: only the people they are
     * shared with see them.
     */
    teamspaceId: text("teamspace_id"),
    kind: text("kind").$type<PageKind>().notNull().default("page"),
    title: text("title").notNull().default(""),
    icon: text("icon"),
    /** The color and pattern behind the page's title and body (lib/page-background). */
    background: jsonb("background").$type<PageBackground>(),
    position: doublePrecision("position").notNull().default(0),
    /** Row values when the parent is a database; empty for regular pages. */
    properties: jsonb("properties").$type<RowProperties>().notNull().default({}),
    /** Encoded Yjs state (Y.encodeStateAsUpdate) — the source of truth for the body. */
    ydoc: bytea("ydoc"),
    /** Derived from ydoc on every store; used for search and MCP reads. */
    contentText: text("content_text").notNull().default(""),
    contentMarkdown: text("content_markdown").notNull().default(""),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Databases: while set, properties and views can't be added, renamed or removed. Rows stay editable. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /**
     * A template (see server/templates.ts): a top-level page of the workspace's template picker, or
     * a row template of its parent database. New pages and rows are copied from it.
     */
    isTemplate: boolean("is_template").notNull().default(false),
    /**
     * The page is a template or lies under one. Such pages stay out of the sidebar, search, trash,
     * favorites, published sites and relation pickers. Database views leave out only the row
     * templates themselves (`isTemplate`), so a database kept as a template still shows its rows.
     */
    inTemplate: boolean("in_template").notNull().default(false),
    /** Databases: the row template "New" starts from; null for a blank row. */
    defaultTemplateId: text("default_template_id").references((): AnyPgColumn => page.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("page_workspace_parent_idx").on(t.workspaceId, t.parentId, t.position),
    index("page_teamspace_idx").on(t.teamspaceId),
    foreignKey({
      name: "page_teamspace_fk",
      columns: [t.teamspaceId, t.workspaceId],
      foreignColumns: [teamspace.id, teamspace.workspaceId],
    }),
    index("page_template_idx").on(t.workspaceId, t.parentId).where(sql`${t.isTemplate}`),
    index("page_search_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.contentText}, ''))`,
    ),
  ],
);

export { PROPERTY_TYPES, type PropertyType, type StatusGroup };
/** An option of a select, multi-select or status property. Status options belong to a `group`. */
export type SelectOption = { id: string; name: string; color: string; group?: StatusGroup };
/** One entry of a checklist value; the value is a list of these, in order. */
export type ChecklistItem = { id: string; text: string; checked: boolean };
/**
 * A relation links rows of this database to rows of another database in the same workspace.
 * Values are arrays of row ids. A two-way relation has a paired relation property on the target
 * database that is kept in sync (`pairedPropertyId`).
 */
export type RelationConfig = {
  databaseId: string;
  pairedPropertyId?: string | null;
  /**
   * What a relation of a database with itself stands for: "parent" holds each row's parent, which
   * makes the rows linking to a row its sub-items (see lib/sub-items); "blocked_by" holds the rows
   * each row waits for (see lib/dependencies). Set by turning the feature on; a copy of the
   * property, or the property turned into another type, doesn't keep it.
   */
  role?: RelationRole;
  /** A "blocked_by" relation: how waiting rows follow when the rows they wait for move. */
  dependencies?: DependencyConfig;
};
export type RelationRole = "parent" | "blocked_by";
/**
 * When a row's dates move, the rows waiting for it move: "overlap" only when they would start
 * before it ends, "keep_gap" by as much as it moved, "none" never.
 */
export type DependencyShift = "overlap" | "keep_gap" | "none";
export type DependencyConfig = {
  /** "overlap" when missing. */
  shift?: DependencyShift;
  /** Rows that move never start on a Saturday or Sunday (they go to the Monday after). */
  skipWeekends?: boolean;
  /** The date properties rows start and end on; without a start nothing moves. */
  startPropertyId?: string;
  endPropertyId?: string;
};
/**
 * A formula property's expression. `prop("…")` references hold property ids (or "title"), so
 * renaming a property keeps its formulas working; editors show names instead (see lib/derived).
 */
export type FormulaConfig = {
  expression: string;
  /** What the formula evaluates to. Worked out whenever properties are read; never stored. */
  type?: FormulaResultType;
};
/**
 * A rollup: `function` over the values of `targetPropertyId` (a property of the related
 * database, or "title") in the rows this row links to through `relationPropertyId`.
 * "show_original" lists the values instead of calculating one. `display` shows a percentage as
 * a number (the default), a bar or a ring.
 */
export type RollupConfig = {
  relationPropertyId: string;
  targetPropertyId: string;
  function: RollupFn;
  display?: RollupDisplay;
  /**
   * The format a sum, average… of a number property shows in (lib/number-format
   * calculationFormat). Worked out whenever properties are read; never stored.
   */
  number?: NumberFormat;
};
/**
 * How a number property shows its values (see lib/number-format). A percentage stores the
 * fraction (0.15 shows as 15 %); `currency` is an ISO 4217 code, set only for "currency".
 * `decimals` (0–8) fixes the decimal places; without it they follow the value (a currency's own).
 */
export type NumberFormat = {
  format: "number" | "percent" | "currency";
  currency?: string;
  decimals?: number;
};
/**
 * Date properties: how values show and whether they remind people (see lib/date-options).
 * `display` "relative" shows days near today as "tomorrow", "in 3 days"; the date otherwise.
 */
export type DateOptions = {
  display?: "relative";
  reminder?: DateReminder;
};
/**
 * A date property's reminder (see server/date-reminders): at 9:00 in `timeZone` (that of whoever
 * set it), `daysBefore` days before a row's date, the people its person properties name (or,
 * without any, whoever added the row) are told. `since`, when it was set (ISO): dates whose
 * reminder time had passed by then don't remind.
 */
export type DateReminder = { daysBefore: number; timeZone: string; since: string };
export type PropertyOptions = {
  options?: SelectOption[];
  relation?: RelationConfig;
  formula?: FormulaConfig;
  rollup?: RollupConfig;
  /** Number properties: how values show; plain numbers when missing. */
  number?: NumberFormat;
  /** Text properties: AI autofill (see lib/ai and server/ai-properties). */
  ai?: AiAutofillConfig;
  /** Date properties: relative display and a reminder; plain dates when missing. */
  date?: DateOptions;
};

export const databaseProperty = pgTable(
  "database_property",
  {
    id: id(),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<PropertyType>().notNull(),
    options: jsonb("options").$type<PropertyOptions>().notNull().default({}),
    position: doublePrecision("position").notNull().default(0),
    /**
     * While set, the property is deleted: left out everywhere (views keep what they said about it,
     * rows keep their values) until someone restores it, or the daily cleanup deletes it for good
     * after the workspace's `trashRetentionDays` (see server/retention.ts).
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("database_property_db_idx").on(t.databaseId),
    index("database_property_deleted_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
    // The date properties with a reminder, which server/date-reminders looks for every minute.
    index("database_property_reminder_idx")
      .on(t.id)
      .where(sql`${t.type} = 'date' and ${t.options} -> 'date' -> 'reminder' is not null`),
  ],
);

export type ViewType = "table" | "board" | "calendar" | "gallery" | "list" | "timeline" | "chart" | "form";
/** Grouping by a date: one group per day, week (Monday to Sunday), month or year. */
export type GroupDateBy = "day" | "week" | "month" | "year";
export type GroupStatusBy = "option" | "group";
export type SortRule = { propertyId: string; direction: "asc" | "desc" };
export type FilterOp = "contains" | "equals" | "not_equals" | "is_empty" | "is_not_empty" | "gt" | "lt" | "is_within";
/** Values of an `is_within` rule: date ranges relative to the day the view is looked at. */
export type RelativeDateRange = "today" | "this_week" | "this_month" | "past_n_days" | "next_n_days";
/** `days` is only used by `is_within` rules with a `past_n_days` / `next_n_days` value. */
export type FilterRule = { propertyId: string; op: FilterOp; value?: unknown; days?: number };
export type FilterCombinator = "and" | "or";
/** Rules combined with their own and/or; groups nest at most MAX_FILTER_DEPTH levels (see lib/filters). */
export type FilterGroup = { type: "group"; combinator: FilterCombinator; rules: FilterEntry[] };
export type FilterEntry = FilterRule | FilterGroup;
/** Gallery card sizes. */
export type CardSize = "small" | "medium" | "large";
/**
 * Where gallery cards take their cover from: the first image in the row's body, the first image of
 * a files property, or nowhere.
 */
export type ViewCover = { source: "first_image" } | { source: "none" } | { source: "property"; propertyId: string };
/** How a view of a database with sub-items shows them (see ViewConfig `subItems`). */
export type SubItemsDisplay = "nested" | "flat" | "parents";
/** Timeline scale: a column per day, per week or per month. */
export type TimelineZoom = "day" | "week" | "month";
/** Chart kinds: vertical bars (columns), horizontal bars, a line, or a donut (a pie with a hole). */
export type ChartType = "bar" | "horizontal_bar" | "line" | "donut";
/** Chart group order: the grouping's own order (see lib/grouping), or by value. */
export type ChartSort = "group" | "value_desc" | "value_asc";
/**
 * Charts over a date: each point the total up to its period ("cumulative"), or what is left of the
 * whole once those rows are taken away ("remaining", a burndown). Rows without a date are never
 * taken away: grouped by the day work was finished, they are the work still open.
 */
export type ChartAccumulate = "cumulative" | "remaining";
/** What a chart measures per group instead of counting rows: a calculation over one property. */
export type ChartAggregate = { fn: AggregateFn; propertyId: string };
/** One question of a form view: a property (or "title", the row's name) the form asks for. */
export type FormQuestion = {
  propertyId: string;
  /** Submitting needs an answer; for a checkbox, a tick. */
  required?: boolean;
  /** Shown instead of the property's name. */
  label?: string;
  /** Help text under the question. */
  description?: string;
};
/**
 * A form view: the questions it asks, in order, and what happens to the row it creates. Whether
 * it is open to people outside the workspace lives in `form_publication`, not here, so editing a
 * view (or copying a database) never turns a public link on.
 */
export type FormConfig = {
  /** Heading of the form; the database's title when missing. */
  title?: string;
  description?: string;
  questions?: FormQuestion[];
  /**
   * Values every row from the form gets for properties it doesn't ask (Status = New), stored like
   * row values (option, user and row ids).
   */
  defaults?: Record<string, unknown>;
  /** Shown after submitting; a generic thank-you when missing. */
  confirmation?: string;
  /** Whether the thank-you screen offers to fill the form in again; true when missing. */
  allowAnother?: boolean;
};
export type ViewConfig = {
  /** Boards: the column property. Timelines: optional swimlanes (none when missing). Charts: the bars, points or slices. */
  groupBy?: string;
  /** Calendar views: the date property that places rows on days. Timelines: where bars start. */
  dateBy?: string;
  /** Timelines: the date property where bars end; without it bars are one day long. */
  endDateBy?: string;
  /** Timelines: "week" when missing. */
  zoom?: TimelineZoom;
  /** Timelines: whether the table of row titles shows left of the bars; shown when missing. */
  showTable?: boolean;
  /** Galleries: "medium" when missing. */
  cardSize?: CardSize;
  /** Galleries: the first image of each row when missing. */
  cover?: ViewCover;
  /** Charts: "bar" when missing. */
  chartType?: ChartType;
  /** Charts: counts rows per group when missing. */
  chartAggregate?: ChartAggregate;
  /** Bar charts: splits each bar into segments by a second property (only for measures that add up). */
  stackBy?: string;
  /** Charts: "group" when missing. */
  chartSort?: ChartSort;
  /** Charts grouped by a date: each period on its own when missing (see lib/chart `chartAccumulateOf`). */
  chartAccumulate?: ChartAccumulate;
  /** Charts: print each value on its bar or point, and in the donut's legend. */
  showValues?: boolean;
  /** Donut charts: the legend beside the donut; shown when missing. */
  showLegend?: boolean;
  sorts?: SortRule[];
  /** Rules and groups; plain rule lists from before groups existed are still valid. */
  filters?: FilterEntry[];
  /** How the top-level filters combine; missing means "and". */
  filterCombinator?: FilterCombinator;
  hidden?: string[];
  /**
   * Property ids in the order this view shows them (the Name column always comes first). Properties
   * it doesn't list follow in their database order (see `orderProperties`).
   */
  propertyOrder?: string[];
  /** Properties shown although their type starts hidden in this kind of view (see `isHiddenInView`). */
  shown?: string[];
  /** Date grouping (date, created and last edited time): how big each group is; "month" when missing. */
  groupDateBy?: GroupDateBy;
  /** Status grouping: one group per option (the default), or per stage (to do, in progress, done). */
  groupStatusBy?: GroupStatusBy;
  /** Board, table and chart views: group order by group key (see lib/grouping), "" for no value. Unlisted groups follow in their natural order. */
  groupOrder?: string[];
  /** Board, table and chart views: groups the user hid, by group key ("" for no value). */
  hiddenGroups?: string[];
  /** Board, table and chart views: leave out groups without rows (the no-value group only shows with rows anyway). */
  hideEmptyGroups?: boolean;
  /**
   * Table, list and timeline views of a database with sub-items: rows under their parent
   * ("nested", the default), every row on its own ("flat"), or only the rows without a parent.
   */
  subItems?: SubItemsDisplay;
  /** Table views: groups shown collapsed, by group key. */
  collapsedGroups?: string[];
  /** Table views: column widths in pixels the user dragged, keyed by property id or "title". */
  columnWidths?: Record<string, number>;
  /** Table views: columns whose cells wrap onto more lines instead of cutting off, by property id or "title". */
  wrapped?: string[];
  /** Table views: the columns up to this one (property id or "title") stay put while the table scrolls sideways. */
  frozenThrough?: string;
  /** Table views: the footer calculation per column, keyed by property id or "title". */
  calculations?: Record<string, AggregateFn>;
  /** Form views: questions, texts and default values. */
  form?: FormConfig;
};

export const databaseView = pgTable(
  "database_view",
  {
    id: id(),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<ViewType>().notNull().default("table"),
    config: jsonb("config").$type<ViewConfig>().notNull().default({}),
    position: doublePrecision("position").notNull().default(0),
    /**
     * Shown where the database is published, with visitors switching between these views. When
     * no view of the database is marked, published pages show its first view (see publication.ts).
     */
    published: boolean("published").notNull().default(false),
    /** While set, the view is deleted and can be restored; like a deleted property's `deletedAt`. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("database_view_db_idx").on(t.databaseId),
    index("database_view_deleted_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  ],
);

/** `before_ai_edit`: saved before the editor's AI writing assistant applied a suggestion. */
export type SnapshotReason = "auto" | "before_mcp_write" | "before_restore" | "before_ai_edit" | "manual";

export const pageSnapshot = pgTable(
  "page_snapshot",
  {
    id: id(),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    ydoc: bytea("ydoc").notNull(),
    contentMarkdown: text("content_markdown").notNull().default(""),
    reason: text("reason").$type<SnapshotReason>().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** OAuth client that triggered the write, for MCP-originated snapshots. */
    oauthClientId: text("oauth_client_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_snapshot_page_idx").on(t.pageId, t.createdAt)],
);
