import { createHmac, timingSafeEqual } from "node:crypto";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { createFormatter, createTranslator } from "next-intl";
import { db } from "@/db";
import { page, schedule, user, workspace } from "@/db/schema";
import type { PropertyOptions } from "@/db/schema/app";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { loadMessages, type Messages } from "@/i18n/messages";
import type { AggregateFn, AggregateResult } from "@/lib/aggregate";
import { chartAccumulateOf, chartMeasure } from "@/lib/chart";
import { RECENT_ROWS_SORT, viewWidgets, type DashboardWidget } from "@/lib/dashboard";
import {
  MAX_DASHBOARD_EMAIL_RECIPIENTS,
  MAX_DASHBOARD_EMAILS,
  defaultSubscriptionPeriod,
  emailPeriod,
  isSubscriptionPeriod,
  readDashboardEmailTarget,
  sameTarget,
  type DashboardEmailTarget,
  type SubscriptionPeriod,
} from "@/lib/dashboard-emails";
import {
  changeTone,
  comparisonOf,
  figureChange,
  nameRange,
  PERIOD_LABELS,
  periodRange,
  type DashboardPeriod,
  type DayRange,
} from "@/lib/dashboard-period";
import { formatDateValue } from "@/lib/date-value";
import { env } from "@/lib/env";
import type { GroupValue } from "@/lib/grouping";
import { pageLabel } from "@/lib/labels";
import { calculationFormat, formatInFormat } from "@/lib/number-format";
import { isReservedEmail } from "@/lib/reserved-emails";
import { nextOccurrence, parseRepeatRule, SCHEDULE_ERRORS, WEEKDAYS_FROM_MONDAY, type RepeatRule, type ScheduleError } from "@/lib/schedule";
import { isTimeZone, timeZoneLabel } from "@/lib/time-zone";
import { AccessError, getMembership, pageAccessOf, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { widgetData, type WidgetData } from "@/server/dashboards";
import * as databases from "@/server/databases";
import { mailStatus, sendMail } from "@/server/mail";
import { recipientLocale, savedLocale } from "@/server/mail/locale";
import { dashboardEmail, emailTranslator, type DashboardEmailWidget, type RenderedEmail } from "@/server/mail/templates";
import { dashboardsIn } from "@/server/mcp/dashboards";
import { workspacePeople } from "@/server/workspaces";
import { lockWorkspaceSchedules, MAX_SCHEDULES_PER_WORKSPACE, registerScheduleHandler, ScheduleRunError, type ScheduleRow } from "@/server/schedules";

/**
 * Dashboard emails (lib/dashboard-emails): a dashboard's figures, sent on a schedule (server/schedules,
 * kind "dashboard_email") to the people its subscription names.
 *
 * Who may do what: anyone who can open the page holding the dashboard may subscribe themselves;
 * emailing others takes edit access to it, and only people who can open the page may be named.
 * The person who set a subscription last (`runAs`) or anyone who may edit the page changes or stops
 * it; each recipient can leave it, signed in or through the link in every email.
 *
 * When it runs, it runs as its setter: they must still have the access setting it took, or it
 * pauses ("accessLost"); a dashboard taken off its page pauses it too ("dashboardGone"), a page in
 * the trash skips the run. Then each recipient gets the dashboard as they would see it at that
 * moment: the widgets read with their own access (server/dashboards widgetData), in their language,
 * for the subscription's period in the schedule's time zone. Recipients who can no longer open the
 * page are left out.
 *
 * The server imports this module for its handler (server.ts).
 */

export class DashboardEmailError extends Error {
  constructor(
    readonly code:
      | "notFound"
      | "needsEdit"
      | "noRecipients"
      | "recipientNoAccess"
      | "tooManyRecipients"
      | "tooMany"
      | "invalidRepeat"
      | "invalidPeriod"
      | "mailDisabled",
    message: string = code,
  ) {
    super(message);
  }
}

export type DashboardEmailView = {
  id: string;
  rule: RepeatRule;
  timeZone: string;
  period: SubscriptionPeriod;
  recipients: { id: string; name: string; email: string }[];
  setBy: { id: string; name: string } | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: ScheduleError | null;
  /** Whether the viewer may change or stop it, and whether they get it. */
  canChange: boolean;
  receives: boolean;
};

export type DashboardEmailInput = { rule: unknown; timeZone: unknown; period?: unknown; recipients: unknown };

// ---------------------------------------------------------------------------------------------
// The dashboard a subscription shows

type FoundDashboard = {
  workspaceId: string;
  title: string;
  /** A dashboard view's widgets are named after what they show; a block's after their database. */
  fixed: boolean;
  widgets: DashboardWidget[];
  /** Its saved period, as stored. */
  period: string;
  inTrash: boolean;
};

/**
 * The dashboard as `userId` sees it, or null when the page holds no such dashboard. Throws
 * AccessError when they can't open the page (or a dashboard view's database).
 */
async function readDashboard(userId: string, pageId: string, target: DashboardEmailTarget): Promise<FoundDashboard | null> {
  if ("view" in target) {
    const found = await databases.getDatabase(userId, pageId);
    const view = found.views.find((v) => v.id === target.view && v.type === "dashboard");
    if (!view) return null;
    return {
      workspaceId: found.database.workspaceId,
      title: `${pageLabel(found.database.title)} · ${view.name}`,
      fixed: true,
      widgets: viewWidgets(view.config, pageId),
      period: view.config.period ?? "",
      inTrash: Boolean(found.database.archivedAt),
    };
  }
  const host = await requirePageAccess(userId, pageId, "view");
  const block = dashboardsIn((await getCollab().readBlocks(pageId)).blocks).find((d) => d.id === target.block);
  if (!block) return null;
  return {
    workspaceId: host.workspaceId,
    title: pageLabel(host.title),
    fixed: false,
    widgets: block.widgets,
    period: block.period,
    inTrash: Boolean(host.archivedAt),
  };
}

/** The dashboard, or a DashboardEmailError when `userId` can't open it or it isn't there. */
async function requireDashboard(userId: string, pageId: string, target: DashboardEmailTarget) {
  try {
    const found = await readDashboard(userId, pageId, target);
    if (found) return found;
  } catch (error) {
    if (!(error instanceof AccessError)) throw error;
  }
  throw new DashboardEmailError("notFound");
}

const canOpen = async (userId: string, pageId: string) => (await pageAccessOf(userId, pageId)).level !== "none";
const canEdit = async (userId: string, pageId: string) => {
  const { level } = await pageAccessOf(userId, pageId);
  return level === "edit" || level === "full";
};

// ---------------------------------------------------------------------------------------------
// Setting, listing and stopping subscriptions

function settingsOf(row: ScheduleRow) {
  const target = readDashboardEmailTarget(row.settings.dashboard);
  const recipients = Array.isArray(row.settings.recipients) ? row.settings.recipients.filter((r): r is string => typeof r === "string") : [];
  const period = isSubscriptionPeriod(row.settings.period) ? row.settings.period : defaultSubscriptionPeriod(row.rule.frequency);
  return { target, recipients, period };
}

async function viewsOf(userId: string, rows: ScheduleRow[], editor: (pageId: string) => Promise<boolean>): Promise<DashboardEmailView[]> {
  const ids = [...new Set(rows.flatMap((r) => [...settingsOf(r).recipients, ...(r.runAs ? [r.runAs] : [])]))];
  const people = new Map(
    ids.length ? (await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, ids))).map((u) => [u.id, u]) : [],
  );
  return Promise.all(
    rows.map(async (r) => {
      const { recipients, period } = settingsOf(r);
      const setter = r.runAs ? people.get(r.runAs) : undefined;
      return {
        id: r.id,
        rule: r.rule,
        timeZone: r.timeZone,
        period,
        recipients: recipients.flatMap((id) => {
          const person = people.get(id);
          return person ? [{ id, name: person.name, email: person.email }] : [];
        }),
        setBy: setter ? { id: setter.id, name: setter.name } : null,
        enabled: r.enabled,
        nextRunAt: r.enabled && r.nextRunAt ? r.nextRunAt.toISOString() : null,
        lastRunAt: r.lastRunAt?.toISOString() ?? null,
        lastError: SCHEDULE_ERRORS.includes(r.lastError as ScheduleError) ? (r.lastError as ScheduleError) : null,
        canChange: r.runAs === userId || (await editor(r.pageId!)),
        receives: recipients.includes(userId),
      };
    }),
  );
}

async function subscriptionsOf(pageId: string, target: DashboardEmailTarget) {
  const rows = await db
    .select()
    .from(schedule)
    .where(and(eq(schedule.kind, "dashboard_email"), eq(schedule.pageId, pageId)))
    .orderBy(schedule.createdAt);
  return rows.filter((r) => {
    const found = settingsOf(r).target;
    return found !== null && sameTarget(found, target);
  });
}

/** A dashboard's subscriptions, for someone who can open it. */
export async function listDashboardEmails(userId: string, pageId: string, target: DashboardEmailTarget): Promise<DashboardEmailView[]> {
  await requireDashboard(userId, pageId, target);
  const editor = await canEdit(userId, pageId);
  return viewsOf(userId, await subscriptionsOf(pageId, target), async () => editor);
}

/**
 * Whom `userId` may email the dashboard to: themselves, and when they may edit the page (and aren't
 * a guest, who doesn't see the workspace's people) everyone in the workspace who can open it.
 */
export async function dashboardEmailPeople(userId: string, pageId: string): Promise<{ id: string; name: string; email: string; image: string | null }[]> {
  const access = await pageAccessOf(userId, pageId);
  if (!access.page || access.level === "none") throw new DashboardEmailError("notFound");
  const membership = await getMembership(userId, access.page.workspaceId);
  const everyone = await workspacePeople(access.page.workspaceId);
  const editor = access.level === "edit" || access.level === "full";
  const candidates = editor && membership && membership.role !== "guest" ? everyone : everyone.filter((p) => p.id === userId);
  const open = await Promise.all(candidates.map(async (p) => (p.id === userId || (await canOpen(p.id, pageId)) ? p : null)));
  return open.flatMap((p) => (p && !isReservedEmail(p.email) ? [{ id: p.id, name: p.name, email: p.email, image: p.image }] : []));
}

/** The subscription `id` as a row of kind "dashboard_email", or a notFound error. */
async function requireSubscription(id: string) {
  const [row] = await db
    .select()
    .from(schedule)
    .where(and(eq(schedule.id, id), eq(schedule.kind, "dashboard_email")));
  if (!row?.pageId) throw new DashboardEmailError("notFound");
  return row as ScheduleRow & { pageId: string };
}

/** Whether `userId` sees the dashboard (a personal dashboard view is its owner's alone). */
async function seesDashboard(userId: string, pageId: string, target: DashboardEmailTarget) {
  try {
    return (await readDashboard(userId, pageId, target)) !== null;
  } catch (error) {
    if (error instanceof AccessError) return false;
    throw error;
  }
}

/** Checks a subscription's rule, time zone, period and recipients as `userId` would set them. */
async function checkInput(userId: string, pageId: string, target: DashboardEmailTarget, input: DashboardEmailInput) {
  const rule = parseRepeatRule(input.rule);
  if (!rule || !isTimeZone(input.timeZone)) throw new DashboardEmailError("invalidRepeat");
  const period = input.period === undefined ? defaultSubscriptionPeriod(rule.frequency) : input.period;
  if (!isSubscriptionPeriod(period)) throw new DashboardEmailError("invalidPeriod");
  if (!Array.isArray(input.recipients) || !input.recipients.every((r) => typeof r === "string")) throw new DashboardEmailError("noRecipients");
  const recipients = [...new Set(input.recipients as string[])];
  if (!recipients.length) throw new DashboardEmailError("noRecipients");
  if (recipients.length > MAX_DASHBOARD_EMAIL_RECIPIENTS) throw new DashboardEmailError("tooManyRecipients");
  // Emailing anyone else takes edit access; only people who can open the page are named.
  if (recipients.some((r) => r !== userId) && !(await canEdit(userId, pageId))) throw new DashboardEmailError("needsEdit");
  const people = await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, recipients));
  if (people.length !== recipients.length || people.some((p) => isReservedEmail(p.email))) throw new DashboardEmailError("recipientNoAccess");
  for (const r of recipients) if (!(await seesDashboard(r, pageId, target))) throw new DashboardEmailError("recipientNoAccess");
  return { rule, timeZone: input.timeZone, period, recipients };
}

/**
 * Sets up a subscription (`id` null) or changes one, as `userId` from now on; turns a paused one
 * back on. Its next email is counted from now.
 */
export async function setDashboardEmail(
  userId: string,
  pageId: string,
  target: DashboardEmailTarget,
  input: DashboardEmailInput,
  id: string | null,
  now = new Date(),
): Promise<DashboardEmailView> {
  if (mailStatus() === "disabled") throw new DashboardEmailError("mailDisabled");
  const dashboard = await requireDashboard(userId, pageId, target);
  const existing = id ? await requireSubscription(id) : null;
  if (existing) {
    const found = settingsOf(existing).target;
    if (existing.pageId !== pageId || !found || !sameTarget(found, target)) throw new DashboardEmailError("notFound");
    if (existing.runAs !== userId && !(await canEdit(userId, pageId))) throw new DashboardEmailError("needsEdit");
  }
  const { rule, timeZone, period, recipients } = await checkInput(userId, pageId, target, input);
  const values = {
    rule,
    timeZone,
    settings: { dashboard: target, recipients, period },
    enabled: true,
    nextRunAt: nextOccurrence(rule, timeZone, now),
    lastError: null,
    runAs: userId,
  };
  const savedId = await db.transaction(async (tx) => {
    if (existing) {
      await tx.update(schedule).set(values).where(eq(schedule.id, existing.id));
      return existing.id;
    }
    await lockWorkspaceSchedules(tx, dashboard.workspaceId);
    const [[inWorkspace], onPage] = await Promise.all([
      tx.select({ n: count() }).from(schedule).where(eq(schedule.workspaceId, dashboard.workspaceId)),
      tx.select().from(schedule).where(and(eq(schedule.kind, "dashboard_email"), eq(schedule.pageId, pageId))),
    ]);
    const ofDashboard = onPage.filter((r) => {
      const found = settingsOf(r).target;
      return found !== null && sameTarget(found, target);
    }).length;
    if (inWorkspace.n >= MAX_SCHEDULES_PER_WORKSPACE || ofDashboard >= MAX_DASHBOARD_EMAILS) throw new DashboardEmailError("tooMany");
    const [created] = await tx
      .insert(schedule)
      .values({ ...values, workspaceId: dashboard.workspaceId, kind: "dashboard_email", pageId, createdBy: userId })
      .returning({ id: schedule.id });
    return created.id;
  });
  await recordAudit({
    workspaceId: dashboard.workspaceId,
    actorId: userId,
    action: "dashboard_email.set",
    target: { type: "page", id: pageId, label: dashboard.title },
    details: { scheduleId: savedId, rule, timeZone, period, count: recipients.length, created: !existing || undefined },
  });
  const [row] = await db.select().from(schedule).where(eq(schedule.id, savedId));
  return (await viewsOf(userId, [row], async () => canEdit(userId, pageId)))[0];
}

/** Stops a subscription: its setter, or someone who may edit the page. */
export async function removeDashboardEmail(userId: string, id: string) {
  const row = await requireSubscription(id);
  if (!(await canOpen(userId, row.pageId))) throw new DashboardEmailError("notFound");
  if (row.runAs !== userId && !(await canEdit(userId, row.pageId))) throw new DashboardEmailError("needsEdit");
  await db.delete(schedule).where(eq(schedule.id, row.id));
  const [host] = await db.select({ title: page.title }).from(page).where(eq(page.id, row.pageId));
  await recordAudit({
    workspaceId: row.workspaceId,
    actorId: userId,
    action: "dashboard_email.removed",
    target: { type: "page", id: row.pageId, label: pageLabel(host?.title ?? "") },
    details: { scheduleId: row.id },
  });
}

/**
 * Takes `userId` off a subscription's recipients: from the app, or through an email's link. One
 * nobody gets any more stops. True when they were on it.
 */
export async function leaveDashboardEmail(userId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schedule)
      .where(and(eq(schedule.id, id), eq(schedule.kind, "dashboard_email")))
      .for("update");
    if (!row) return false;
    const { recipients } = settingsOf(row);
    if (!recipients.includes(userId)) return false;
    const rest = recipients.filter((r) => r !== userId);
    if (!rest.length) await tx.delete(schedule).where(eq(schedule.id, row.id));
    else await tx.update(schedule).set({ settings: { ...row.settings, recipients: rest } }).where(eq(schedule.id, row.id));
    return true;
  });
}

export type MyDashboardEmail = DashboardEmailView & { pageId: string; workspaceId: string; title: string; target: DashboardEmailTarget };

/** The subscriptions `userId` gets or set, across their workspaces, for Settings. */
export async function myDashboardEmails(userId: string): Promise<MyDashboardEmail[]> {
  const rows = await db
    .select()
    .from(schedule)
    .where(
      and(
        eq(schedule.kind, "dashboard_email"),
        sql`(${schedule.runAs} = ${userId} or ${schedule.settings}->'recipients' ? ${userId})`,
      ),
    )
    .orderBy(schedule.createdAt);
  const out: MyDashboardEmail[] = [];
  for (const row of rows) {
    const target = settingsOf(row).target;
    if (!row.pageId || !target) continue;
    // Only what they can still open: a page out of reach isn't named.
    const access = await pageAccessOf(userId, row.pageId);
    if (access.level === "none" || !access.page) continue;
    const editor = access.level === "edit" || access.level === "full";
    const [view] = await viewsOf(userId, [row], async () => editor);
    out.push({ ...view, pageId: row.pageId, workspaceId: row.workspaceId, title: pageLabel(access.page.title), target });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Unsubscribing through an email's link

const tokenKey = () => `dashboard-email:${env.authSecret}`;
const sign = (data: string) => createHmac("sha256", tokenKey()).update(data).digest("base64url");

/** What an email's unsubscribe link carries: the subscription and the recipient, signed. */
export function unsubscribeToken(scheduleId: string, userId: string) {
  const data = `${scheduleId}.${userId}`;
  return `${Buffer.from(data).toString("base64url")}.${sign(data)}`;
}

export function readUnsubscribeToken(token: unknown): { scheduleId: string; userId: string } | null {
  if (typeof token !== "string" || token.length > 400) return null;
  const [encoded, signature, ...rest] = token.split(".");
  if (rest.length || !encoded || !signature) return null;
  const data = Buffer.from(encoded, "base64url").toString();
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [scheduleId, userId, ...more] = data.split(".");
  return scheduleId && userId && !more.length ? { scheduleId, userId } : null;
}

export const unsubscribePageUrl = (token: string) => `${env.appUrl}/dashboard-emails/unsubscribe?token=${encodeURIComponent(token)}`;
/** For mail apps' own unsubscribe button (RFC 8058): a POST there unsubscribes without a page. */
export const unsubscribePostUrl = (token: string) => `${env.appUrl}/api/dashboard-emails/unsubscribe?token=${encodeURIComponent(token)}`;

/** What the unsubscribe page names: the dashboard's page and whether the person still gets it. */
export async function describeUnsubscribe(token: unknown): Promise<{ title: string; subscribed: boolean } | null> {
  const found = readUnsubscribeToken(token);
  if (!found) return null;
  const [row] = await db
    .select({ settings: schedule.settings, title: page.title })
    .from(schedule)
    .innerJoin(page, eq(page.id, schedule.pageId))
    .where(and(eq(schedule.id, found.scheduleId), eq(schedule.kind, "dashboard_email")));
  if (!row) return { title: "", subscribed: false };
  return { title: pageLabel(row.title), subscribed: (row.settings.recipients ?? []).includes(found.userId) };
}

/** Unsubscribes through a link's token; false when the token isn't one. */
export async function unsubscribeWithToken(token: unknown): Promise<boolean> {
  const found = readUnsubscribeToken(token);
  if (!found) return false;
  await leaveDashboardEmail(found.userId, found.scheduleId);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Writing the email

type Translate = ReturnType<typeof createTranslator<Messages>>;

/** Words and formats in one language, as the dashboard in the app has them (components/page/dashboard-grid). */
async function wording(locale: Locale, timeZone: string) {
  const messages = await loadMessages(locale);
  const t = createTranslator({ locale, messages }) as Translate;
  const format = createFormatter({ locale, timeZone });
  const rangeName = (range: DayRange) => nameRange(range, format, (values) => t("page.dashboard.period.quarter", values));
  const formatResult = (fn: AggregateFn, result: AggregateResult, options?: PropertyOptions) => {
    switch (result.format) {
      case "number":
        return formatInFormat(result.value, calculationFormat(fn, options), (n, o) => format.number(n, o), fn === "average" || fn === "median" ? 2 : undefined);
      case "percent":
        return format.number(result.value, { style: "percent", maximumFractionDigits: 1 });
      case "date":
        return (
          formatDateValue(result.value, (d, o) => format.dateTime(d, o), timeZone) ??
          format.dateTime(new Date(`${String(result.value).slice(0, 10)}T00:00:00Z`), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
        );
      case "days":
        return t("database.calculate.days", { count: result.value });
    }
  };
  return { t, format, rangeName, formatResult };
}

type Words = Awaited<ReturnType<typeof wording>>;

/** "Weekly on Mon · 08:00 (Istanbul)", as Settings names an agent's schedule. */
function ruleSummary({ t, format }: Words, rule: RepeatRule, timeZone: string) {
  const how =
    rule.interval === 1
      ? t(`database.page.templates.repeatDialog.frequencies.${rule.frequency}`)
      : t("settings.agents.schedules.every", { count: rule.interval, unit: t(`database.page.templates.repeatDialog.units.${rule.frequency}`, { count: rule.interval }) });
  const days =
    rule.frequency === "weekly"
      ? WEEKDAYS_FROM_MONDAY.filter((d) => rule.weekdays.includes(d))
          // 2026-10-04 was a Sunday: day 0 of that week.
          .map((d) => format.dateTime(new Date(Date.UTC(2026, 9, 4 + d)), { weekday: "short", timeZone: "UTC" }))
          .join(", ")
      : "";
  const zone = timeZoneLabel(timeZone);
  return days ? t("settings.agents.schedules.summaryOn", { how, days, time: rule.time, zone }) : t("settings.agents.schedules.summary", { how, time: rule.time, zone });
}

function groupName({ t, format }: Words, property: string, value: GroupValue) {
  switch (value.kind) {
    case "none":
      return t("database.board.noValue", { property });
    case "option":
      return value.option.name || t("common.untitled");
    case "status_group":
      return t(`database.statusGroups.${value.group}`);
    case "person":
      return value.person.name || t("database.person.unknown");
    case "checkbox":
      return value.checked ? t("database.group.checked") : t("database.group.unchecked");
    case "relation":
      return pageLabel(value.row.title, t("common.untitled"));
    case "date": {
      const start = new Date(`${value.start}T00:00:00Z`);
      const end = new Date(`${value.end}T00:00:00Z`);
      switch (value.by) {
        case "day":
          return format.dateTime(start, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
        case "week":
          return format.dateTimeRange(start, end, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
        case "month":
          return format.dateTime(start, { year: "numeric", month: "long", timeZone: "UTC" });
        case "year":
          return format.dateTime(start, { year: "numeric", timeZone: "UTC" });
      }
    }
  }
}

/** One widget in words, for one recipient (the email's twin of dashboard-grid's WidgetBody). */
function emailWidget(words: Words, emailT: (key: string, values?: Record<string, string | number>) => string, widget: DashboardWidget, data: WidgetData, fixed: boolean): DashboardEmailWidget {
  const { t, rangeName, formatResult, format } = words;
  if (data.state === "unavailable") return { title: widget.title || t("page.dashboard.title"), url: null, kind: "note", text: emailT("unavailable") };
  const config = widget.view.config;
  const measure = chartMeasure(config, data.properties);
  const measureName =
    measure.kind === "count"
      ? t("database.chart.countShort")
      : t("database.chart.measureOf", {
          calculation: t(`database.calculate.menu.${measure.fn}`),
          property: data.properties.find((p) => p.id === measure.prop.id)?.name ?? "",
        });
  const shows = (() => {
    if (data.kind === "number") return measureName;
    if (data.kind === "chart") {
      const groupBy = data.properties.find((p) => p.id === data.groupById);
      return groupBy ? t("database.dashboardView.chartTitle", { measure: measureName, property: groupBy.name }) : measureName;
    }
    const sort = config.sorts?.[0];
    if (widget.view.type === "list" && sort?.propertyId === RECENT_ROWS_SORT.propertyId && sort.direction === RECENT_ROWS_SORT.direction) return t("database.dashboardView.recent");
    return t(`database.views.${widget.view.type}`);
  })();
  const title = widget.title || (fixed ? shows : pageLabel(data.database.title, t("common.untitled")));
  const base = { title, url: `${env.appUrl}/w/${data.database.workspaceId}/p/${data.database.id}` };
  if (data.database.inTrash) return { ...base, kind: "note", text: emailT("inTrash") };
  const fn: AggregateFn = measure.kind === "count" ? "count_all" : measure.fn;
  const options = measure.kind === "count" ? undefined : measure.prop.options;
  const show = (result: AggregateResult | null) => (result ? formatResult(fn, result, options) : "–");
  switch (data.kind) {
    case "number": {
      let change: Extract<DashboardEmailWidget, { kind: "number" }>["change"] = null;
      if (data.previous) {
        const versus = rangeName(data.previous.range);
        const moved = figureChange(data.result, data.previous.result);
        if (!moved) change = { amount: null, tone: "flat", arrow: null, versus };
        else {
          const amount =
            moved.by === "points"
              ? t("page.dashboard.period.points", { value: format.number(moved.value * 100, { maximumFractionDigits: 1, signDisplay: "exceptZero" }) })
              : format.number(moved.value, { style: "percent", maximumFractionDigits: Math.abs(moved.value) < 0.1 ? 1 : 0, signDisplay: "exceptZero" });
          change = { amount, tone: changeTone(moved, comparisonOf(config)), arrow: moved.value > 0 ? "up" : moved.value < 0 ? "down" : null, versus };
        }
      }
      return { ...base, kind: "number", value: show(data.result), label: measureName === title ? null : measureName, change };
    }
    case "chart": {
      const groupBy = data.properties.find((p) => p.id === data.groupById);
      const stackBy = data.properties.find((p) => p.id === data.stackById);
      if (!data.chart || !groupBy) return { ...base, kind: "note", text: emailT("noGroup") };
      if (data.rowCount === 0) return { ...base, kind: "note", text: emailT(data.period ? "empty" : "allEmpty") };
      const accumulate = chartAccumulateOf(config, groupBy, measure);
      const measured = accumulate ? t(`database.chart.running.${accumulate}`, { measure: measureName }) : measureName;
      const name = (g: { value: GroupValue; other?: boolean }, prop: string) => (g.other ? emailT("other") : groupName(words, prop, g.value));
      const stacked = data.chart.series.length > 0 && stackBy;
      return {
        ...base,
        kind: "table",
        head: [groupBy.name, ...(stacked ? data.chart.series.map((s) => name(s, stackBy.name)) : [measured])],
        rows: data.chart.groups.map((g) => ({ cells: [name(g, groupBy.name), ...(stacked ? g.segments.map((s) => show(s.result)) : [show(g.result)])] })),
        more: null,
      };
    }
    case "list":
      if (!data.rows.length) return { ...base, kind: "note", text: emailT(data.period ? "empty" : "allEmpty") };
      return {
        ...base,
        kind: "table",
        head: [],
        rows: data.rows.map((r) => ({ cells: [pageLabel(r.title, t("common.untitled"))], url: `${env.appUrl}/w/${data.database.workspaceId}/p/${r.id}` })),
        more: data.rowCount > data.rows.length ? emailT("more", { count: data.rowCount - data.rows.length }) : null,
      };
    case "view":
      return { ...base, kind: "note", text: emailT("viewOnly") };
  }
}

/** "Last week (19–25 Oct 2026)": the period an email shows, as of when it was due. */
function periodName(words: Words, emailT: (key: string, values?: Record<string, string | number>) => string, choice: SubscriptionPeriod, period: DashboardPeriod, at: Date, timeZone: string) {
  const range = periodRange(period, at, timeZone);
  if (!range) return emailT("asOf", { date: words.format.dateTime(at, { year: "numeric", month: "short", day: "numeric", timeZone }) });
  const days = words.rangeName(range);
  if (choice === "yesterday") return emailT("periodDays", { period: emailT("yesterday"), days });
  if (period.kind === "custom") return days;
  if (period.kind === "all") return days;
  return emailT("periodDays", { period: words.t(`page.dashboard.period.${PERIOD_LABELS[period.kind]}`), days });
}

type Sending = {
  scheduleId: string | null;
  pageId: string;
  target: DashboardEmailTarget;
  rule: RepeatRule;
  timeZone: string;
  period: SubscriptionPeriod;
  setterId: string;
  at: Date;
};

/**
 * The email `recipientId` gets, or null when they can't open the dashboard (or have no address).
 * Everything in it is read with their access.
 */
export async function renderDashboardEmail(recipientId: string, sending: Sending): Promise<{ to: string; email: RenderedEmail; locale: Locale } | null> {
  const [person] = await db.select({ email: user.email }).from(user).where(eq(user.id, recipientId));
  if (!person?.email || isReservedEmail(person.email)) return null;
  let dashboard: FoundDashboard | null;
  try {
    dashboard = await readDashboard(recipientId, sending.pageId, sending.target);
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
  if (!dashboard) return null;
  const locale = await recipientLocale(recipientId, (await savedLocale(sending.setterId)) ?? DEFAULT_LOCALE);
  const words = await wording(locale, sending.timeZone);
  const emailTexts = emailTranslator(locale);
  const emailT = (key: string, values?: Record<string, string | number>) =>
    (emailTexts as unknown as (key: string, values?: Record<string, string | number>) => string)(`dashboard.${key}`, values);
  const period = emailPeriod(sending.period, dashboard.period, sending.at, sending.timeZone);
  const widgets = await Promise.all(
    dashboard.widgets.map(async (w) =>
      emailWidget(words, emailT, w, await widgetData({ userId: recipientId }, { databaseId: w.databaseId, view: w.view }, { timeZone: sending.timeZone, period, now: sending.at }), dashboard.fixed),
    ),
  );
  const [space] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, dashboard.workspaceId));
  const [setter] = sending.setterId === recipientId ? [] : await db.select({ name: user.name }).from(user).where(eq(user.id, sending.setterId));
  const token = unsubscribeToken(sending.scheduleId ?? "test", recipientId);
  const link = `${env.appUrl}/w/${dashboard.workspaceId}/p/${sending.pageId}${"view" in sending.target ? `?view=${sending.target.view}` : ""}`;
  const email = dashboardEmail(locale, {
    dashboardTitle: dashboard.title,
    periodName: periodName(words, emailT, sending.period, period, sending.at, sending.timeZone),
    workspaceName: space?.name ?? "",
    widgets,
    link,
    schedule: ruleSummary(words, sending.rule, sending.timeZone),
    setterName: setter ? setter.name : null,
    unsubscribeUrl: sending.scheduleId ? unsubscribePageUrl(token) : link,
  });
  return { to: person.email, email, locale };
}

async function deliver(recipientId: string, sending: Sending): Promise<boolean> {
  const rendered = await renderDashboardEmail(recipientId, sending);
  if (!rendered) return false;
  const headers = sending.scheduleId
    ? { "List-Unsubscribe": `<${unsubscribePostUrl(unsubscribeToken(sending.scheduleId, recipientId))}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  await sendMail({ to: rendered.to, ...rendered.email, ...(headers ? { headers } : {}) });
  return true;
}

/**
 * Sends the email as a subscription set up with `input` would, to `userId` alone and now: what
 * the form's "Send me a test" does, before or after saving it.
 */
export async function sendTestDashboardEmail(userId: string, pageId: string, target: DashboardEmailTarget, input: Omit<DashboardEmailInput, "recipients">, now = new Date()) {
  if (mailStatus() === "disabled") throw new DashboardEmailError("mailDisabled");
  await requireDashboard(userId, pageId, target);
  const { rule, timeZone, period } = await checkInput(userId, pageId, target, { ...input, recipients: [userId] });
  await deliver(userId, { scheduleId: null, pageId, target, rule, timeZone, period, setterId: userId, at: now });
}

// ---------------------------------------------------------------------------------------------
// The schedule's run

registerScheduleHandler("dashboard_email", async ({ schedule: row, runAs, at }) => {
  const { target, recipients, period } = settingsOf(row);
  if (!row.pageId || !target) throw new ScheduleRunError("dashboardGone");
  // The setter keeps the access setting it took: to open the page, and to edit it when it emails others.
  const others = recipients.some((r) => r !== runAs);
  if (!(others ? await canEdit(runAs, row.pageId) : await canOpen(runAs, row.pageId))) throw new ScheduleRunError("accessLost");
  let dashboard: FoundDashboard | null;
  try {
    dashboard = await readDashboard(runAs, row.pageId, target);
  } catch (error) {
    if (error instanceof AccessError) throw new ScheduleRunError("accessLost", error.message);
    throw error;
  }
  if (!dashboard) throw new ScheduleRunError("dashboardGone");
  // A page in the trash sends nothing; the emails come again if it comes back.
  if (dashboard.inTrash || !recipients.length) return false;
  const sending: Sending = { scheduleId: row.id, pageId: row.pageId, target, rule: row.rule, timeZone: row.timeZone, period, setterId: runAs, at };
  let sent = 0;
  let failed: unknown = null;
  for (const recipient of recipients) {
    try {
      if (await deliver(recipient, sending)) sent++;
    } catch (error) {
      // One address the server refuses doesn't keep the others from theirs.
      failed = error;
    }
  }
  if (sent) {
    await recordAudit({
      workspaceId: row.workspaceId,
      actorId: runAs,
      action: "dashboard_email.sent",
      target: { type: "page", id: row.pageId, label: dashboard.title },
      details: { scheduleId: row.id, count: sent },
    });
  }
  if (failed && !sent) throw failed;
  return sent > 0;
});
