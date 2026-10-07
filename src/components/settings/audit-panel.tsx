import { Download } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import {
  AUDIT_CATEGORY_NAMES,
  auditActorName,
  auditCategoryOf,
  auditFilterQuery,
  describeAuditEvent,
  encodeActorFilter,
  type AuditEvent,
  type AuditFilters,
  type AuditTranslator,
} from "@/lib/audit";
import { parseUserAgent } from "@/lib/user-agent";
import type { AuditActorOption } from "@/server/audit";

// A server component (a plain form and links, nothing to hydrate), so it cannot pull `cn` from the client-only ui module.
const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

const fieldClass = "h-8 w-full rounded-md border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";
const buttonClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors";

/**
 * Settings > Audit log, for owners: the events of server/audit.ts, newest first, filtered by who
 * acted, what kind of change and when (a plain GET form, so a filtered view is a link), a page at a
 * time, and the same filtered list as CSV.
 */
export async function AuditPanel({
  workspaceId,
  events,
  hasMore,
  filters,
  actors,
}: {
  workspaceId: string;
  events: AuditEvent[];
  hasMore: boolean;
  filters: AuditFilters;
  actors: AuditActorOption[];
}) {
  const [settingsT, t, format] = await Promise.all([getTranslations("settings"), getTranslations("settings.audit"), getFormatter()]);
  // The descriptions look their texts up by keys built at run time (lib/audit.ts).
  const ts = settingsT as unknown as AuditTranslator;
  const base = `/w/${workspaceId}/settings`;
  const pageLink = (page: number) => `${base}?${auditFilterQuery({ ...filters, page }, { tab: "audit" })}`;
  const csv = `${base}/audit.csv?${auditFilterQuery({ ...filters, page: 1 })}`;
  const filtered = Boolean(filters.actor || filters.category || filters.from || filters.to);
  const selectedActor = filters.actor ? encodeActorFilter(filters.actor) : "";
  // Someone picked in the filter who acted outside the list (another page of history): keep them selectable.
  const knownActor = !selectedActor || selectedActor.startsWith("k:") || actors.some((a) => `u:${a.userId}` === selectedActor);

  return (
    <div>
      <SettingsHeader title={settingsT("nav.audit")} description={t("description")} />

      <div className="space-y-6">
        <form action={base} role="search" aria-label={t("filters")} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto_auto] lg:items-end">
          <input type="hidden" name="tab" value="audit" />
          <div>
            <label htmlFor="audit-actor" className={labelClass}>
              {t("actor")}
            </label>
            <select id="audit-actor" name="actor" defaultValue={selectedActor} className={fieldClass}>
              <option value="">{t("anyone")}</option>
              {actors.map((a) => (
                <option key={a.userId} value={`u:${a.userId}`}>
                  {a.name && a.email ? `${a.name} (${a.email})` : a.name || a.email || t("actors.deletedUser")}
                </option>
              ))}
              {!knownActor && <option value={selectedActor}>{t("actors.deletedUser")}</option>}
              <option value="k:agent">{t("actorKinds.agent")}</option>
              <option value="k:scim">{t("actorKinds.scim")}</option>
              <option value="k:system">{t("actorKinds.system")}</option>
            </select>
          </div>
          <div>
            <label htmlFor="audit-category" className={labelClass}>
              {t("category")}
            </label>
            <select id="audit-category" name="category" defaultValue={filters.category ?? ""} className={fieldClass}>
              <option value="">{t("allCategories")}</option>
              {AUDIT_CATEGORY_NAMES.map((category) => (
                <option key={category} value={category}>
                  {t(`categories.${category}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="audit-from" className={labelClass}>
              {t("from")}
            </label>
            <input id="audit-from" type="date" name="from" defaultValue={filters.from ?? ""} className={fieldClass} />
          </div>
          <div>
            <label htmlFor="audit-to" className={labelClass}>
              {t("to")}
            </label>
            <input id="audit-to" type="date" name="to" defaultValue={filters.to ?? ""} className={fieldClass} />
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" className={cn(buttonClass, "bg-accent text-accent-fg hover:opacity-90")}>
              {t("apply")}
            </button>
            {filtered && (
              <Link href={`${base}?tab=audit`} className={cn(buttonClass, "text-fg-muted hover:bg-bg-hover hover:text-fg")}>
                {t("clear")}
              </Link>
            )}
          </div>
        </form>

        <SettingsGroup
          title={t("eventsHeading")}
          description={t("retention")}
          action={
            events.length > 0 && (
              <a
                href={csv}
                download
                aria-label={t("export")}
                title={t("export")}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
              >
                <Download className="h-4 w-4" />
              </a>
            )
          }
          bare
        >
          {events.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">
              {filtered || filters.page > 1 ? t("noMatches") : t("empty")}
            </p>
          ) : (
            <div className="relative overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
                  <tr>
                    <th scope="col" className="w-40 px-4 py-2.5 text-left font-normal">
                      {t("columns.time")}
                    </th>
                    <th scope="col" className="w-52 px-4 py-2.5 text-left font-normal">
                      {t("columns.actor")}
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-left font-normal">
                      {t("columns.event")}
                    </th>
                    <th scope="col" className="w-40 px-4 py-2.5 text-left font-normal">
                      {t("columns.source")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {events.map((event) => {
                    const category = auditCategoryOf(event.action);
                    const device = parseUserAgent(event.userAgent);
                    const browser = device.browser && device.os ? t("device", { browser: device.browser, os: device.os }) : null;
                    return (
                      <tr key={event.id} className="align-top">
                        <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
                          <time dateTime={event.createdAt.toISOString()}>
                            {format.dateTime(event.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                          </time>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium break-words">{auditActorName(event, ts)}</div>
                          {event.actorEmail && event.actorName && (
                            <div className="truncate text-xs text-fg-muted">{event.actorEmail}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="break-words">{describeAuditEvent(event, ts)}</div>
                          {category && <div className="mt-0.5 text-xs text-fg-muted">{t(`categories.${category}`)}</div>}
                        </td>
                        <td className="px-4 py-3 text-xs text-fg-muted">
                          {event.ip ? <div className="break-all">{event.ip}</div> : <div>{t("noSource")}</div>}
                          {browser && <div>{browser}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {(filters.page > 1 || hasMore) && (
            <nav aria-label={t("paging")} className="flex items-center justify-between gap-3 text-sm">
              {filters.page > 1 ? (
                <Link href={pageLink(filters.page - 1)} className={cn(buttonClass, "border border-border bg-bg hover:bg-bg-hover")}>
                  {t("newer")}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-fg-muted">{t("page", { page: filters.page })}</span>
              {hasMore ? (
                <Link href={pageLink(filters.page + 1)} className={cn(buttonClass, "border border-border bg-bg hover:bg-bg-hover")}>
                  {t("older")}
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </SettingsGroup>
      </div>
    </div>
  );
}
