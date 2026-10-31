"use client";

/**
 * One step an AI answer or an agent's run took (a search, a page read, a database queried, a
 * change made, a note kept about the person or dropped, a call to a connection's tool, a research
 * plan, a web search or a web page read, a thought), as a line: an icon and what happened, the
 * pages it names as links (web pages open in a new tab).
 */
import { Ban, BookOpen, Brain, BrainCog, CircleAlert, ClipboardList, FileDown, FilePen, FilePlus, Filter, Globe, Lightbulb, ListPlus, ListTree, Merge, MessageSquarePlus, PencilLine, Plug, Search, Table2, Wrench } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment } from "react";
import { cn, PageIcon, pageLabel } from "@/components/ui";
import { makesFile, type ChatChange, type ChatPageView, type ChatQueryCondition, type ChatSourceView, type ChatStepView, type ChatWriteView } from "@/lib/ai-chat";

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
  if (step.kind === "memory") {
    // An agent's proposal waits for an owner, and its note for its next run needs none: neither is declined in its run.
    const action = step.action;
    const declined = step.outcome === "declined" && (action === "remember" || action === "forget");
    const Icon = declined ? Ban : action === "forget" ? BrainCog : Brain;
    const label = declined && (action === "remember" || action === "forget") ? t(`steps.memory.declined.${action}`) : t(`steps.memory.${action}`);
    return (
      <>
        <Icon className={icon} />
        <span className="min-w-0 break-words">
          {label} <span className="text-fg">“{step.text}”</span>
        </span>
      </>
    );
  }
  if (step.kind === "connection") {
    const Icon = step.outcome === "declined" ? Ban : step.outcome === "failed" ? CircleAlert : Plug;
    return (
      <>
        <Icon className={cn(icon, step.outcome === "failed" && "text-danger")} />
        <span className="min-w-0 break-words">
          {t(`steps.connection.${step.outcome}`, { connection: step.connection, tool: step.tool })}
          <code className="mt-0.5 block truncate text-xs text-fg-faint" title={step.input}>
            {step.input}
          </code>
        </span>
      </>
    );
  }
  if (step.kind === "leafdesk") {
    const Icon = step.outcome === "declined" ? Ban : step.outcome === "failed" ? CircleAlert : Wrench;
    return (
      <>
        <Icon className={cn(icon, step.outcome === "failed" && "text-danger")} />
        <span className="min-w-0 break-words">
          {t(`steps.tool.${step.outcome}`, { tool: step.title })}
          <code className="mt-0.5 block truncate text-xs text-fg-faint" title={step.input}>
            {step.input}
          </code>
        </span>
      </>
    );
  }
  if (step.kind === "plan") {
    return (
      <>
        <ListTree className={icon} />
        <span className="min-w-0 break-words">
          {t("steps.plan")}
          <ol className="mt-0.5 list-decimal ps-4">
            {step.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </span>
      </>
    );
  }
  if (step.kind === "web") {
    if (step.action === "search") {
      return (
        <>
          <Globe className={icon} />
          <span className="min-w-0 break-words">{t("steps.webSearched", { query: step.query, count: step.results })}</span>
        </>
      );
    }
    return (
      <>
        {step.outcome === "failed" ? <CircleAlert className={cn(icon, "text-danger")} /> : <Globe className={icon} />}
        <span className="flex min-w-0 items-center gap-1">
          {step.outcome === "failed" ? t("steps.webReadFailed") : t("steps.webRead")}
          <a href={step.url} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 truncate text-fg hover:underline" title={step.url}>
            {step.title || step.url}
          </a>
        </span>
      </>
    );
  }
  return (
    <>
      <Lightbulb className={icon} />
      <span className="line-clamp-2 min-w-0 break-words">{step.text}</span>
    </>
  );
}

const WRITE_ICONS = {
  createRow: ListPlus,
  updateRow: PencilLine,
  createPage: FilePlus,
  editPage: FilePen,
  // One icon for every file the chat makes: each icon here is in every workspace page's first load.
  createPdf: FileDown,
  createDocx: FileDown,
  createXlsx: FileDown,
  mergeRows: Merge,
  addComment: MessageSquarePlus,
  createDatabase: Table2,
  createForm: ClipboardList,
} as const;

/**
 * A change made ("Row added: <row> · in <database>", with the values set), declined or failed. The
 * row or page it made links to it; until then, where it was to go does.
 */
function WriteLine({ step, onSource }: { step: ChatWriteView; onSource: (source: ChatSourceView) => void }) {
  const t = useTranslations("ai.chat.steps.write");
  const Icon = step.outcome === "declined" ? Ban : step.outcome === "failed" ? CircleAlert : WRITE_ICONS[step.action];
  // A row or page changed is the change's subject; a row or page added goes into its target, and
  // so does a file made of a page or a database (the file is its subject, by name).
  const changedInPlace = step.action === "updateRow" || step.action === "editPage" || step.action === "mergeRows" || step.action === "addComment";
  // A form is named by its title, in the database it was added to.
  const pdf = makesFile(step.action) || step.action === "createForm";
  const where = changedInPlace ? null : pdf ? (step.page ?? step.target) : step.target;
  const subject = pdf ? null : (step.page ?? (changedInPlace ? step.target : null));
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
        <span key={i} className="me-1 inline-block rounded bg-bg-subtle px-1 text-fg last:me-0">
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
  does_not_contain: "doesNotContain",
  equals: "equals",
  not_equals: "notEquals",
  is_any_of: "isAnyOf",
  is_none_of: "isNoneOf",
  gt: "greaterThan",
  gte: "greaterOrEqual",
  lt: "lessThan",
  lte: "lessOrEqual",
  is_empty: "isEmpty",
  is_not_empty: "isNotEmpty",
  is_within: "isWithin",
} as const;
const RANGE_LABELS = {
  today: "today",
  this_week: "thisWeek",
  last_week: "lastWeek",
  next_week: "nextWeek",
  this_month: "thisMonth",
  last_month: "lastMonth",
  next_month: "nextMonth",
  this_quarter: "thisQuarter",
  last_quarter: "lastQuarter",
  next_quarter: "nextQuarter",
  this_year: "thisYear",
  last_year: "lastYear",
  next_year: "nextYear",
} as const;

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
          {i > 0 && any && <span className="me-1">{or}</span>}
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
    <span className="me-1 inline-block rounded bg-bg-subtle px-1 text-fg last:me-0">
      {condition.property} {/\p{L}/u.test(op) ? op.toLocaleLowerCase(locale) : op}
      {value && ` ${value}`}
    </span>
  );
}
