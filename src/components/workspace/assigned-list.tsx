"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState, type MouseEvent } from "react";
import { markAssignedDoneAction, undoAssignedDoneAction, type AssignedItemRef, type AssignedMarked } from "@/app/actions/assigned";
import { OptionChip } from "@/components/database/property-cell";
import { useRowPanel } from "@/components/database/row-panel-context";
import { cn, PageIcon } from "@/components/ui";
import { assignedGroup, type AssignedGroupKey, type AssignedGrouping } from "@/lib/assigned";
import { pageLabel } from "@/lib/labels";
import { opensNewTab } from "@/lib/row-panel";
import type { AssignedItem } from "@/server/assigned";

export type AssignedListGroup = {
  /** A due-date group's key, or a database's (or page's) id (null: rows shared without their database). */
  key: string | null;
  /** The database's (or page's) name when grouped by database. */
  databaseTitle?: string | null;
  rows: AssignedItem[];
};

/** Overdue rows stand out; the rest stay quiet. */
const tone = (key: AssignedGroupKey) => (key === "overdue" ? "text-danger" : "text-fg-muted");

type Marked = AssignedMarked | "pending";

const refOf = (item: AssignedItem): AssignedItemRef =>
  item.type === "row" ? { type: "row", rowId: item.id } : { type: "pageTask", pageId: item.pageId, blockId: item.blockId };

/**
 * Open database rows assigned to the viewer, and the unticked to-dos in pages that mention them,
 * in groups: by when they are due (the home page and My tasks) or by database or page (My tasks).
 * Rows open in the row panel beside the list where there is one, else as pages; a to-do opens its
 * page at the to-do. A row with a status can be marked done from here, a to-do ticked, and either
 * put back.
 */
export function AssignedList({
  workspaceId,
  grouping,
  groups,
  today,
}: {
  workspaceId: string;
  grouping: AssignedGrouping;
  groups: AssignedListGroup[];
  today: string;
}) {
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const format = useFormatter();
  const rowPanel = useRowPanel();
  const listRef = useRef<HTMLDivElement>(null);
  // Items marked done here: they stay, crossed out, until the list is loaded again.
  const [marked, setMarked] = useState<Map<string, Marked>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const year = today.slice(0, 4);

  const dateLabel = (date: string) =>
    format.dateTime(new Date(`${date}T00:00:00Z`), {
      month: "short",
      day: "numeric",
      ...(date.slice(0, 4) === year ? {} : { year: "numeric" }),
      timeZone: "UTC",
    });

  const mark = (id: string, value: Marked | null) =>
    setMarked((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });

  const markDone = async (item: AssignedItem) => {
    setError(null);
    mark(item.id, "pending");
    const result = await markAssignedDoneAction(refOf(item)).catch(() => null);
    if (result?.ok) mark(item.id, result.data);
    else {
      mark(item.id, null);
      setError(result?.error ?? t(item.type === "row" ? "myTasks.markFailed" : "myTasks.tickFailed"));
    }
  };

  const undo = async (item: AssignedItem) => {
    const done = marked.get(item.id);
    if (!done || done === "pending") return;
    setError(null);
    mark(item.id, "pending");
    const result = await undoAssignedDoneAction(refOf(item), done).catch(() => null);
    if (result?.ok) mark(item.id, null);
    else {
      mark(item.id, done);
      setError(result?.error ?? t(item.type === "row" ? "myTasks.undoFailed" : "myTasks.untickFailed"));
    }
  };

  const open = (e: MouseEvent<HTMLAnchorElement>, rowId: string) => {
    if (!rowPanel?.available || opensNewTab(e)) return;
    e.preventDefault();
    rowPanel.open(rowId, { source: listRef.current, trigger: e.currentTarget });
  };

  return (
    // The row panel steps through the rows listed here, and gives focus back to one as it closes.
    <div ref={listRef} data-row-source className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {groups.map((group) => (
        <div key={group.key ?? ""} className="space-y-1.5">
          <h3 className={cn("text-xs font-medium", grouping === "due" ? tone(group.key as AssignedGroupKey) : "text-fg-muted")}>
            {grouping === "due" ? (
              t(`assignedGroups.${group.key as AssignedGroupKey}`)
            ) : group.key === null ? (
              t("myTasks.sharedRows")
            ) : (
              <Link href={`/w/${workspaceId}/p/${group.key}`} className="hover:text-fg hover:underline">
                {pageLabel(group.databaseTitle ?? "", tc("untitled"))}
              </Link>
            )}{" "}
            <span className="font-normal text-fg-muted">{group.rows.length}</span>
          </h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {group.rows.map((item) => {
              const state = marked.get(item.id);
              const done = state !== undefined && state !== "pending";
              const title = item.type === "row" ? pageLabel(item.title, tc("untitled")) : item.text || t("myTasks.untitledTask");
              const due = item.date ? assignedGroup(item.date, today, item.endDate) : "none";
              const label = done ? t("myTasks.undoLabel", { title }) : t("myTasks.markDone", { title });
              const details = (
                <>
                  <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-baseline md:gap-2">
                    <span className={cn("truncate", done && "text-fg-muted line-through")}>{title}</span>
                    {grouping === "due" && item.type === "row" && item.databaseTitle !== null && (
                      <span className="truncate text-xs text-fg-muted">{pageLabel(item.databaseTitle, tc("untitled"))}</span>
                    )}
                    {grouping === "due" && item.type === "pageTask" && (
                      <span className="truncate text-xs text-fg-muted">
                        {t.rich("myTasks.onPage", {
                          title: pageLabel(item.pageTitle, tc("untitled")),
                          page: (chunks) => (
                            <span className="inline-flex items-baseline gap-1">
                              <PageIcon icon={item.pageIcon} kind={item.pageKind} className="h-3 w-3 shrink-0 self-center text-xs" />
                              {chunks}
                            </span>
                          ),
                        })}
                      </span>
                    )}
                  </span>
                  {/* Phones leave the status out so the title has room. */}
                  {item.type === "row" && item.status && !done && (
                    <span className="hidden shrink-0 sm:inline-flex">
                      <OptionChip option={item.status} dot />
                    </span>
                  )}
                  {item.date && !done && <span className={cn("shrink-0 text-xs tabular-nums", tone(due))}>{dateLabel(item.date)}</span>}
                </>
              );
              const linkClass = "flex min-w-0 flex-1 items-center gap-2.5 py-3 md:py-2.5";
              return (
                <li key={item.id} className="flex items-center gap-2.5 px-4 text-sm hover:bg-bg-hover">
                  {item.markable ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={done}
                      aria-label={label}
                      title={label}
                      disabled={state === "pending"}
                      onClick={() => void (done ? undo(item) : markDone(item))}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-50",
                        done ? "border-accent bg-accent text-accent-fg" : "border-fg-faint hover:border-fg-muted",
                      )}
                    >
                      {done && <Check className="h-3 w-3" strokeWidth={3} />}
                    </button>
                  ) : item.type === "row" ? (
                    <PageIcon icon={item.icon} kind={item.kind} className="flex w-4 shrink-0 justify-center text-fg-muted" />
                  ) : (
                    // A to-do the viewer may not tick: its box, as the page shows it.
                    <span aria-hidden className="h-4 w-4 shrink-0 rounded border border-fg-faint opacity-50" />
                  )}
                  {item.type === "row" ? (
                    <a href={`/w/${workspaceId}/p/${item.id}`} data-open-row={item.id} onClick={(e) => open(e, item.id)} className={linkClass}>
                      {details}
                    </a>
                  ) : (
                    <Link href={item.path} className={linkClass}>
                      {details}
                    </Link>
                  )}
                  {done && (
                    <button type="button" onClick={() => void undo(item)} className="shrink-0 text-xs text-fg-muted hover:text-fg hover:underline">
                      {t("myTasks.undo")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
