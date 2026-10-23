import { ArrowRight, CircleCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { HealthFix } from "@/components/settings/health-fix";
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import {
  CHECK_SECTIONS,
  STALE_MONTHS,
  type CheckSection,
  type CheckSectionKey,
  type DeadTarget,
  type WorkspaceCheck,
} from "@/lib/workspace-check";

// A server component (links, and client buttons only where something can be fixed), so it cannot
// pull `cn` from the client-only ui module.
const cn = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

const anchor = (key: CheckSectionKey) => `health-${key}`;

/** Settings > Health: the workspace check of `check` (see server/workspace-check.ts) with its fixes. */
export async function HealthPanel({ workspaceId, check }: { workspaceId: string; check: WorkspaceCheck }) {
  const [ts, t, tc, format] = await Promise.all([
    getTranslations("settings"),
    getTranslations("settings.health"),
    getTranslations("common"),
    getFormatter(),
  ]);
  const now = new Date(check.checkedAt);
  const href = (id: string) => `/w/${workspaceId}/p/${id}`;
  const label = (title: string) => pageLabel(title, tc("untitled"));

  const pageLink = (p: { id: string; title: string; icon: string | null; kind?: string }) => (
    <Link href={href(p.id)} className="-mx-1.5 inline-flex h-7 min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 hover:bg-bg-hover">
      <PageIcon icon={p.icon} kind={p.kind === "database" ? "database" : undefined} className="shrink-0 text-fg-muted" />
      <span className="truncate">{label(p.title)}</span>
    </Link>
  );
  const deadTarget = (target: DeadTarget) =>
    target.status === "trash" ? (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-fg-muted">
        <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t("inTrash", { title: label(target.title) })}</span>
      </span>
    ) : (
      <span className="text-fg-muted">{t("deletedPage")}</span>
    );
  const restore = (target: DeadTarget) =>
    target.status === "trash" &&
    target.canRestore && <HealthFix workspaceId={workspaceId} fix={{ kind: "restore", pageId: target.id }} label={t("restore")} />;

  const counts: Record<CheckSectionKey, number | null> = {
    brokenLinks: check.brokenLinks.total,
    orphans: check.orphans.total,
    empty: check.empty.total,
    stale: check.stale.total,
    expiredVerifications: check.expiredVerifications.total,
    duplicates: check.duplicates.status === "done" ? check.duplicates.total : null,
    brokenRelations: check.brokenRelations.total,
  };

  return (
    <div>
      <SettingsHeader title={ts("nav.health")} description={t("description")} />

      <div className="space-y-10">
        <div className="space-y-3">
          <ul className="grid gap-3 sm:grid-cols-3">
            {CHECK_SECTIONS.map((key) => (
              <li key={key}>
                <a
                  href={`#${anchor(key)}`}
                  className="block rounded-xl border border-border bg-bg-subtle/60 px-4 py-3 transition-colors hover:bg-bg-hover"
                >
                  <span className="block text-sm text-fg-muted">{t(`${key}.title`)}</span>
                  <span className={cn("mt-1 block text-2xl font-semibold tabular-nums", counts[key] === 0 && "text-fg-muted")}>
                    {counts[key] === null ? "–" : format.number(counts[key])}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <p className="text-xs text-fg-muted">
            {t("checked", { count: check.pages })}
            {check.truncated && <> {t("truncated")}</>}
          </p>
        </div>

        <Section id="brokenLinks" t={t} section={check.brokenLinks}>
          {check.brokenLinks.items.map((f) => (
            <Row key={`${f.source.id}:${f.target.id}`} fix={restore(f.target)}>
              {pageLink(f.source)}
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-faint rtl:-scale-x-100" aria-label={t("linksTo")} />
              {deadTarget(f.target)}
            </Row>
          ))}
        </Section>

        <Section id="orphans" t={t} section={check.orphans}>
          {check.orphans.items.map((p) => (
            <Row
              key={p.id}
              detail={p.linkFrom && t("writtenIn", { title: label(p.linkFrom.title) })}
              fix={
                p.linkFrom && (
                  <HealthFix
                    workspaceId={workspaceId}
                    fix={{ kind: "link", sourceId: p.linkFrom.id, targetId: p.id }}
                    label={t("linkThere")}
                  />
                )
              }
            >
              {pageLink(p)}
            </Row>
          ))}
        </Section>

        <Section id="empty" t={t} section={check.empty}>
          {check.empty.items.map((p) => (
            <Row
              key={p.id}
              fix={
                p.canEdit && (
                  <HealthFix
                    workspaceId={workspaceId}
                    fix={{ kind: "trash", pageId: p.id }}
                    label={t("moveToTrash")}
                    confirm={t("confirmTrash", { title: label(p.title) })}
                  />
                )
              }
            >
              {pageLink(p)}
            </Row>
          ))}
        </Section>

        <Section
          id="stale"
          t={t}
          section={check.stale}
          description={t("stale.description", { months: check.staleMonths })}
          toolbar={
            <nav aria-label={t("periods")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
              {STALE_MONTHS.map((months) => (
                <Link
                  key={months}
                  href={`/w/${workspaceId}/settings?tab=health&months=${months}#${anchor("stale")}`}
                  aria-current={months === check.staleMonths ? "page" : undefined}
                  className={cn(
                    "flex h-7 items-center rounded-md px-2.5 text-sm transition-colors",
                    months === check.staleMonths ? "bg-bg font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                  )}
                >
                  {t("months", { months })}
                </Link>
              ))}
            </nav>
          }
        >
          {check.stale.items.map((p) => (
            <Row
              key={p.id}
              detail={
                <time dateTime={p.updatedAt} title={format.dateTime(new Date(p.updatedAt), { dateStyle: "medium" })}>
                  {t("lastEdited", { when: format.relativeTime(new Date(p.updatedAt), now) })}
                </time>
              }
            >
              {pageLink(p)}
            </Row>
          ))}
        </Section>

        <Section id="expiredVerifications" t={t} section={check.expiredVerifications}>
          {check.expiredVerifications.items.map((p) => (
            <Row
              key={p.id}
              detail={
                <time dateTime={p.until} title={format.dateTime(new Date(p.until), { dateStyle: "medium" })}>
                  {p.by
                    ? t("verificationEndedBy", { name: p.by, when: format.relativeTime(new Date(p.until), now) })
                    : t("verificationEnded", { when: format.relativeTime(new Date(p.until), now) })}
                </time>
              }
            >
              {pageLink(p)}
            </Row>
          ))}
        </Section>

        {check.duplicates.status === "done" ? (
          <Section id="duplicates" t={t} section={check.duplicates}>
            {check.duplicates.items.map((d) => (
              <Row key={`${d.a.id}:${d.b.id}`} detail={t("alike", { similarity: d.similarity })}>
                {pageLink(d.a)}
                <span className="shrink-0 text-fg-faint" aria-hidden>
                  ≈
                </span>
                {pageLink(d.b)}
              </Row>
            ))}
          </Section>
        ) : (
          <div id={anchor("duplicates")} className="scroll-mt-6">
            <SettingsGroup title={t("duplicates.title")} description={t("duplicates.description")} bare>
              <p className="rounded-xl border border-dashed border-border px-4 py-4 text-sm text-fg-muted">
                {t(`duplicates.${check.duplicates.reason}`)}
              </p>
            </SettingsGroup>
          </div>
        )}

        <Section id="brokenRelations" t={t} section={check.brokenRelations}>
          {check.brokenRelations.items.map((f) => (
            <Row
              key={`${f.row.id}:${f.property.id}:${f.target.id}`}
              detail={t("inProperty", { property: f.property.name, database: label(f.database.title) })}
              fix={
                <>
                  {restore(f.target)}
                  {f.canFix && (
                    <HealthFix
                      workspaceId={workspaceId}
                      fix={{ kind: "unrelate", rowId: f.row.id, propertyId: f.property.id, targetId: f.target.id }}
                      label={t("removeFromRelation")}
                    />
                  )}
                </>
              }
            >
              {pageLink(f.row)}
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-faint rtl:-scale-x-100" aria-label={t("linksTo")} />
              {deadTarget(f.target)}
            </Row>
          ))}
        </Section>
      </div>
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"settings.health">>>;

/** One kind of finding: its title and what it means, then the findings, or a note that there are none. */
function Section<I>({
  id,
  t,
  section,
  description,
  toolbar,
  children,
}: {
  id: CheckSectionKey;
  t: T;
  section: CheckSection<I>;
  description?: string;
  /** Controls above the findings (on their own line, so the description keeps its width on phones). */
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const more = section.total - section.items.length;
  return (
    <div id={anchor(id)} className="scroll-mt-6">
      <SettingsGroup title={t(`${id}.title`)} description={description ?? t(`${id}.description`)} bare>
        {toolbar}
        {section.total === 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-4 text-sm text-fg-muted">
            <CircleCheck className="h-4 w-4 shrink-0 text-added-fg" aria-hidden />
            {t(`${id}.none`)}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <ul className="divide-y divide-border text-sm">{children}</ul>
            {more > 0 && <p className="border-t border-border bg-bg-subtle px-4 py-2.5 text-xs text-fg-muted">{t("more", { count: more })}</p>}
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}

function Row({ children, detail, fix }: { children: ReactNode; detail?: ReactNode; fix?: ReactNode }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">{children}</div>
        {detail && <div className="truncate text-xs text-fg-muted">{detail}</div>}
      </div>
      {fix && <div className="flex shrink-0 items-center gap-2">{fix}</div>}
    </li>
  );
}
