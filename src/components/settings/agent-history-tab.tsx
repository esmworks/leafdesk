"use client";

import { ArrowLeft, ChevronRight, History } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getAgentVersionAction, listAgentVersionsAction, restoreAgentVersionAction } from "@/app/actions/agents";
import { BlockChanges } from "@/components/page/history-diff";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, PageIcon, pageLabel } from "@/components/ui";
import {
  fieldLabel,
  instructionChanges,
  MAX_AGENT_VERSIONS,
  type AgentRestoreResult,
  type AgentVersionDetail,
  type AgentVersionView,
  type VersionPageRef,
  type VersionScheduleRef,
} from "@/lib/agent-versions";
import type { AgentView } from "@/lib/agents";
import { useRuleSummary } from "./agent-schedules-tab";

const NAMED_FIELDS = ["name", "icon", "description", "instructions", "enabled", "monthly_token_limit", "skills", "schedules", "shares"] as const;
type NamedField = (typeof NAMED_FIELDS)[number];

/** A setting or part's name; one added since that has no translation yet goes by its column. */
function useFieldName() {
  const t = useTranslations("settings.agents.history.fields");
  return (field: string) => ((NAMED_FIELDS as readonly string[]).includes(field) ? t(field as NamedField) : fieldLabel(field));
}

/** What a version is: how it came about, and what it changed from the one before. */
function useSummary() {
  const t = useTranslations("settings.agents.history");
  const field = useFieldName();
  return (v: AgentVersionView) => {
    const parts = v.changes?.length ? v.changes.map(field).join(", ") : "";
    if (v.kind === "created" || v.kind === "baseline") return t(`kinds.${v.kind}`);
    if (v.kind === "restored") return parts ? `${t("kinds.restored", { number: v.restoredFrom ?? 0 })} · ${parts}` : t("kinds.restored", { number: v.restoredFrom ?? 0 });
    return parts || t("kinds.changed");
  };
}

/**
 * The versions of an agent's setup (server/agents/versions.ts): each saved change to its settings,
 * skills, schedules or the pages shared with it, newest first. Opening one shows what changed from
 * it to the setup now; an owner can bring it back.
 */
export function AgentHistoryTab({ workspaceId, agent }: { workspaceId: string; agent: AgentView }) {
  const t = useTranslations("settings.agents.history");
  const tc = useTranslations("common");
  const format = useFormatter();
  const summary = useSummary();
  const [versions, setVersions] = useState<AgentVersionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const [restored, setRestored] = useState<AgentRestoreResult | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    listAgentVersionsAction(workspaceId, agent.id)
      .then((res) => {
        if (!live) return;
        if (res.ok) setVersions(res.data);
        else setLoadError(res.error);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, tc, reload]);

  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const version = opened !== null ? versions?.find((v) => v.number === opened) : undefined;

  if (opened !== null) {
    return (
      <VersionPanel
        key={`${opened}-${reload}`}
        workspaceId={workspaceId}
        agent={agent}
        number={opened}
        latest={versions?.[0]?.number === opened}
        title={version ? t("version", { number: opened }) : ""}
        onBack={() => setOpened(null)}
        onRestored={(result) => {
          setRestored(result);
          setOpened(null);
          setReload((n) => n + 1);
        }}
      />
    );
  }

  return (
    <div className="max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4">
      <p className="text-sm text-fg-muted">{t("description", { max: MAX_AGENT_VERSIONS })}</p>
      {restored && (
        <div role="status" className="space-y-1 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
          <p>{t("restored", { number: restored.version.restoredFrom ?? 0, version: restored.version.number })}</p>
          <SkippedList result={restored} />
        </div>
      )}
      {!versions ? (
        <p className="text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? tc("loading")}
        </p>
      ) : versions.length ? (
        <ol aria-label={t("list")} className="divide-y divide-border rounded-md border border-border">
          {versions.map((v, i) => (
            <li key={v.number}>
              <button
                type="button"
                onClick={() => {
                  setRestored(null);
                  setOpened(v.number);
                }}
                className="flex w-full items-start gap-3 px-3 py-2 text-start text-sm hover:bg-bg-hover"
              >
                <History className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{t("version", { number: v.number })}</span>
                    {i === 0 && <span className="text-xs text-fg-muted">{t("current")}</span>}
                  </span>
                  <span className="block truncate">{summary(v)}</span>
                  <span className="block text-xs text-fg-muted">
                    {t("byAt", { name: v.by?.name || t("someone"), time: when(v.updatedAt) })}
                  </span>
                </span>
                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted rtl:-scale-x-100" aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted">{t("empty")}</p>
      )}
    </div>
  );
}

function SkippedList({ result }: { result: AgentRestoreResult }) {
  const t = useTranslations("settings.agents.history");
  const field = useFieldName();
  if (!result.skipped.length) return null;
  return (
    <>
      <p>{t("skippedHeading")}</p>
      <ul className="list-disc space-y-0.5 ps-5 text-fg-muted">
        {result.skipped.map((s, i) => (
          <li key={i}>
            {t("skippedItem", {
              what: !s.name ? t(`skipped.${s.part}Hidden`) : t(`skipped.${s.part}`, { name: s.part === "setting" ? field(s.name) : s.name }),
              reason: t(`reasons.${s.reason}`),
            })}
          </li>
        ))}
      </ul>
    </>
  );
}

/** One version: what changed from it to the setup now, and bringing it back. */
function VersionPanel({
  workspaceId,
  agent,
  number,
  latest,
  title,
  onBack,
  onRestored,
}: {
  workspaceId: string;
  agent: AgentView;
  number: number;
  latest: boolean;
  title: string;
  onBack: () => void;
  onRestored: (result: AgentRestoreResult) => void;
}) {
  const t = useTranslations("settings.agents.history");
  const tc = useTranslations("common");
  const format = useFormatter();
  const summary = useSummary();
  const [detail, setDetail] = useState<AgentVersionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    getAgentVersionAction(workspaceId, agent.id, number)
      .then((res) => {
        if (!live) return;
        if (res.ok) setDetail(res.data);
        else setLoadError(res.error);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, number, tc]);

  const same =
    detail &&
    !detail.settings.length &&
    !detail.skills.added.length &&
    !detail.skills.removed.length &&
    !detail.skills.reordered &&
    !detail.schedules.added.length &&
    !detail.schedules.removed.length &&
    !detail.schedules.changed.length &&
    !detail.shares.added.length &&
    !detail.shares.removed.length &&
    !detail.shares.changed.length;

  return (
    <div className={cn("max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4", pending && "opacity-70")}>
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
        {t("back")}
      </button>
      {!detail ? (
        <p className="text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? tc("loading")}
        </p>
      ) : (
        <>
          <div>
            <h3 className="text-base font-semibold">{title || t("version", { number })}</h3>
            <p className="text-sm">{summary(detail.version)}</p>
            <p className="text-xs text-fg-muted">
              {t("byAt", {
                name: detail.version.by?.name || t("someone"),
                time: format.dateTime(new Date(detail.version.updatedAt), { dateStyle: "medium", timeStyle: "short" }),
              })}
            </p>
          </div>
          {same ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted">{latest ? t("sameLatest") : t("same")}</p>
          ) : (
            <>
              <p className="text-sm text-fg-muted">{t("compareNote")}</p>
              <VersionChanges workspaceId={workspaceId} detail={detail} />
            </>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          {agent.archived ? (
            <p className="text-sm text-fg-muted">{t("archived")}</p>
          ) : (
            !same && (
              <div className="border-t border-border pt-4">
                <Button
                  variant="primary"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(t("confirmRestore", { number }))) run(() => restoreAgentVersionAction(workspaceId, agent.id, number), onRestored);
                  }}
                >
                  {t("restore")}
                </Button>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </section>
  );
}

const ADDED = "border-s-2 border-added-bar ps-3";
const REMOVED = "border-s-2 border-removed-bar ps-3";
const CHANGED = "border-s-2 border-accent ps-3";

function PageName({ workspaceId, page }: { workspaceId: string; page: VersionPageRef }) {
  const t = useTranslations("settings.agents.history");
  const tc = useTranslations("common");
  if (page.hidden) return <span className="text-fg-muted">{t("hiddenPage")}</span>;
  if (page.gone) return <span className="text-fg-muted">{t("deletedPage")}</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <PageIcon icon={page.icon} kind="page" className="text-sm" />
      <a href={`/w/${workspaceId}/p/${page.id}`} className="truncate hover:underline">
        {pageLabel(page.title, tc("untitled"))}
      </a>
      {page.trashed && <span className="text-xs text-fg-muted">({t("inTrash")})</span>}
    </span>
  );
}

/** How the version differs from now: each part that changed, older on the left of each arrow. */
function VersionChanges({ workspaceId, detail }: { workspaceId: string; detail: AgentVersionDetail }) {
  const t = useTranslations("settings.agents.history");
  const ta = useTranslations("settings.agents.access.level");
  const field = useFieldName();
  const format = useFormatter();
  const ruleSummary = useRuleSummary();
  const instructions = detail.settings.find((s) => s.field === "instructions");
  const others = detail.settings.filter((s) => s.field !== "instructions");
  const lines = useMemo(
    () => (instructions ? instructionChanges(typeof instructions.before === "string" ? instructions.before : "", typeof instructions.after === "string" ? instructions.after : "") : []),
    [instructions],
  );

  const value = (name: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return t("none");
    if (name === "enabled" && typeof v === "boolean") return v ? t("on") : t("paused");
    if (name === "monthly_token_limit" && typeof v === "number") return t("tokens", { count: v });
    if (typeof v === "boolean") return v ? t("yes") : t("no");
    if (typeof v === "number") return format.number(v);
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  };
  const schedule = (s: VersionScheduleRef) => (
    <span className="block">
      <span className="block">{ruleSummary(s.rule, s.timeZone)}</span>
      <span className="block text-fg-muted">{s.taskHidden ? t("taskHidden") : s.task}</span>
      {s.database && (
        <span className="block text-xs text-fg-muted">
          <PageName workspaceId={workspaceId} page={s.database} />
        </span>
      )}
    </span>
  );
  const marked = (kind: "added" | "removed", children: ReactNode, key: number | string) => (
    <li key={key} className={cn("text-sm", kind === "added" ? ADDED : REMOVED)}>
      <span className="block text-xs text-fg-muted">{t(kind === "added" ? "addedSince" : "removedSince")}</span>
      {children}
    </li>
  );

  return (
    <div className="space-y-5">
      {others.length > 0 && (
        <Section title={t("sections.settings")}>
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-start text-xs text-fg-muted">
                <th className="w-1/4 pb-1 text-start font-normal">{t("setting")}</th>
                <th className="pb-1 text-start font-normal">{t("thisVersion")}</th>
                <th className="pb-1 text-start font-normal">{t("now")}</th>
              </tr>
            </thead>
            <tbody className="align-top">
              {others.map((s) => (
                <tr key={s.field} className="border-t border-border">
                  <td className="py-1.5 pe-2 text-fg-muted">{field(s.field)}</td>
                  <td className="break-words py-1.5 pe-2">
                    <del className="text-removed-fg no-underline">{value(s.field, s.before)}</del>
                  </td>
                  <td className="break-words py-1.5">
                    <ins className="text-added-fg no-underline">{value(s.field, s.after)}</ins>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {instructions && (
        <Section title={field("instructions")}>
          <div className="rounded-md border border-border px-2 py-2 text-sm">
            <BlockChanges changes={lines} compact />
          </div>
        </Section>
      )}
      {(detail.skills.added.length > 0 || detail.skills.removed.length > 0 || detail.skills.reordered) && (
        <Section title={field("skills")}>
          <ul className="space-y-1">
            {detail.skills.removed.map((p, i) => marked("removed", <PageName workspaceId={workspaceId} page={p} />, `r${i}`))}
            {detail.skills.added.map((p, i) => marked("added", <PageName workspaceId={workspaceId} page={p} />, `a${i}`))}
          </ul>
          {detail.skills.reordered && <p className="text-xs text-fg-muted">{t("reordered")}</p>}
        </Section>
      )}
      {(detail.schedules.added.length > 0 || detail.schedules.removed.length > 0 || detail.schedules.changed.length > 0) && (
        <Section title={field("schedules")}>
          <ul className="space-y-2">
            {detail.schedules.removed.map((s, i) => marked("removed", schedule(s), `r${i}`))}
            {detail.schedules.changed.map((c, i) => (
              <li key={`c${i}`} className={cn("space-y-1 text-sm", CHANGED)}>
                <span className="block text-xs text-fg-muted">{t("thisVersion")}</span>
                {schedule(c.before)}
                <span className="block text-xs text-fg-muted">{t("now")}</span>
                {schedule(c.after)}
              </li>
            ))}
            {detail.schedules.added.map((s, i) => marked("added", schedule(s), `a${i}`))}
          </ul>
        </Section>
      )}
      {(detail.shares.added.length > 0 || detail.shares.removed.length > 0 || detail.shares.changed.length > 0) && (
        <Section title={field("shares")}>
          <ul className="space-y-1">
            {detail.shares.removed.map((p, i) =>
              marked(
                "removed",
                <span className="flex flex-wrap items-center gap-x-2">
                  <PageName workspaceId={workspaceId} page={p} />
                  <span className="text-xs text-fg-muted">{ta(p.level)}</span>
                </span>,
                `r${i}`,
              ),
            )}
            {detail.shares.changed.map((p, i) => (
              <li key={`c${i}`} className={cn("flex flex-wrap items-center gap-x-2 text-sm", CHANGED)}>
                <PageName workspaceId={workspaceId} page={p} />
                <span className="text-xs text-fg-muted">{t("levelChange", { before: ta(p.before), after: ta(p.after) })}</span>
              </li>
            ))}
            {detail.shares.added.map((p, i) =>
              marked(
                "added",
                <span className="flex flex-wrap items-center gap-x-2">
                  <PageName workspaceId={workspaceId} page={p} />
                  <span className="text-xs text-fg-muted">{ta(p.level)}</span>
                </span>,
                `a${i}`,
              ),
            )}
          </ul>
        </Section>
      )}
    </div>
  );
}
