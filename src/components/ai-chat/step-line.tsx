"use client";

/**
 * One step an AI answer or an agent's run took (a search, a page read, a database queried, a
 * change made, a thought), as a line: an icon and what happened, the pages it names as links.
 */
import { Ban, BookOpen, CircleAlert, FilePlus, Filter, Lightbulb, ListPlus, PencilLine, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment } from "react";
import { cn, PageIcon, pageLabel } from "@/components/ui";
import type { ChatChange, ChatPageView, ChatQueryCondition, ChatSourceView, ChatStepView, ChatWriteView } from "@/lib/ai-chat";

export function StepLine({ step, onSource }: { step: ChatStepView; onSource: (source: ChatSourceView) => void }) {
  const t = useTranslations("ai.chat");
  const icon = "mt-[3px] h-3.5 w-3.5 shrink-0";
  if (step.kind === "search") {
    return (
      <>
        <Search className={icon} />
        <span className="min-w-0 break-words">
          {step.query === null ? t("steps.question", { count: step.results }) : t("steps.searched", { query: step.query, count: step.results })}
        </span>
      </>
    );
  }
  if (step.kind === "read") {
    return (
      <>
        <BookOpen className={icon} />
        {step.page ? (
          <span className="flex min-w-0 items-center gap-1">
            {t("steps.read")}
            <PageLink page={step.page} onSource={onSource} />
          </span>
        ) : (
          <span>{t("steps.readGone")}</span>
        )}
      </>
    );
  }
  if (step.kind === "query") {
    return (
      <>
        <Filter className={icon} />
        {step.database ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1">
            {t("steps.query")}
            <PageLink page={step.database} onSource={onSource} />
            {step.conditions.length > 0 && <Conditions conditions={step.conditions} any={step.any === true} />}
            <span>· {t("steps.rows", { count: step.results })}</span>
          </span>
        ) : (
          <span>{t("steps.queryGone")}</span>
        )}
      </>
    );
  }
  if (step.kind === "write") return <WriteLine step={step} onSource={onSource} />;
  return (
    <>
      <Lightbulb className={icon} />
      <span className="line-clamp-2 min-w-0 break-words">{step.text}</span>
    </>
  );
}

const WRITE_ICONS = { createRow: ListPlus, updateRow: PencilLine, createPage: FilePlus } as const;

/**
 * A change made ("Row added: <row> · in <database>", with the values set), declined or failed. The
 * row or page it made links to it; until then, where it was to go does.
 */
function WriteLine({ step, onSource }: { step: ChatWriteView; onSource: (source: ChatSourceView) => void }) {
  const t = useTranslations("ai.chat.steps.write");
  const Icon = step.outcome === "declined" ? Ban : step.outcome === "failed" ? CircleAlert : WRITE_ICONS[step.action];
  const where = step.action === "updateRow" ? null : step.target;
  const subject = step.page ?? (step.action === "updateRow" ? step.target : null);
  return (
    <>
      <Icon className={cn("mt-[3px] h-3.5 w-3.5 shrink-0", step.outcome === "failed" && "text-danger")} />
      <span className="flex min-w-0 flex-wrap items-center gap-x-1">
        {t(`${step.outcome}.${step.action}`)}
        {subject ? <PageLink page={subject} onSource={onSource} /> : step.title && <span className="text-fg">“{step.title}”</span>}
        {where && (
          <>
            <span>· {t("in")}</span>
            <PageLink page={where} onSource={onSource} />
          </>
        )}
        {step.changes.length > 0 && <Changes changes={step.changes} />}
      </span>
    </>
  );
}

/** The values a change sets ("Status: Done"), a cleared one as such. */
export function Changes({ changes }: { changes: ChatChange[] }) {
  const t = useTranslations("ai.chat");
  return (
    <span className="break-words">
      ·{" "}
      {changes.map((c, i) => (
        <span key={i} className="mr-1 inline-block rounded bg-bg-subtle px-1 text-fg last:mr-0">
          {c.property}: {c.value || <span className="text-fg-muted">{t("approval.cleared")}</span>}
        </span>
      ))}
    </span>
  );
}

export function PageLink({ page, onSource }: { page: NonNullable<ChatPageView>; onSource: (source: ChatSourceView) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSource({ n: 0, pageId: page.pageId, workspaceId: page.workspaceId, title: page.title, icon: page.icon, kind: page.kind, blockId: null })}
      className="flex min-w-0 items-center gap-1 rounded px-0.5 text-fg underline decoration-border underline-offset-2 hover:bg-bg-hover"
    >
      <PageIcon icon={page.icon} kind={page.kind} className="text-xs" />
      <span className="truncate">{pageLabel(page.title)}</span>
    </button>
  );
}

const OP_LABELS = {
  contains: "contains",
  equals: "equals",
  not_equals: "notEquals",
  gt: "greaterThan",
  lt: "lessThan",
  is_empty: "isEmpty",
  is_not_empty: "isNotEmpty",
  is_within: "isWithin",
} as const;
const RANGE_LABELS = { today: "today", this_week: "thisWeek", this_month: "thisMonth" } as const;

/** A query step's filter rules, "or" between them when any may match. */
function Conditions({ conditions, any }: { conditions: ChatQueryCondition[]; any: boolean }) {
  const t = useTranslations("database.filter");
  const locale = useLocale();
  const or = t("or").toLocaleLowerCase(locale);
  return (
    <span className="break-words">
      ·{" "}
      {conditions.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && any && <span className="mr-1">{or}</span>}
          <Condition condition={c} />
        </Fragment>
      ))}
    </span>
  );
}

/** A filter rule of a query step, in the words of the database's filter menu ("Status = Done"). */
function Condition({ condition }: { condition: ChatQueryCondition }) {
  const t = useTranslations("database.filter");
  const locale = useLocale();
  const opKey = OP_LABELS[condition.op as keyof typeof OP_LABELS] as (typeof OP_LABELS)[keyof typeof OP_LABELS] | undefined;
  const op = opKey ? t(`ops.${opKey}`) : condition.op;
  let value = condition.value ?? "";
  const [range, days] = value.split(" ");
  const rangeKey = RANGE_LABELS[range as keyof typeof RANGE_LABELS] as (typeof RANGE_LABELS)[keyof typeof RANGE_LABELS] | undefined;
  if (condition.op === "is_within" && rangeKey) value = t(`relative.${rangeKey}`);
  else if (condition.op === "is_within" && (range === "past_n_days" || range === "next_n_days") && Number(days) > 0) {
    value = t(range === "past_n_days" ? "relative.pastDays" : "relative.nextDays", { count: Number(days) });
  } else if (value.toLowerCase() === "me") value = t("me");
  return (
    <span className="mr-1 inline-block rounded bg-bg-subtle px-1 text-fg last:mr-0">
      {condition.property} {/\p{L}/u.test(op) ? op.toLocaleLowerCase(locale) : op}
      {value && ` ${value}`}
    </span>
  );
}
