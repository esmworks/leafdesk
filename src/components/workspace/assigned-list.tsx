"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState, type MouseEvent } from "react";
import { markAssignedDoneAction, undoAssignedDoneAction } from "@/app/actions/assigned";
import { OptionChip } from "@/components/database/property-cell";
import { useRowPanel } from "@/components/database/row-panel-context";
import { cn, PageIcon } from "@/components/ui";
import { assignedGroup, type AssignedGroupKey, type AssignedGrouping } from "@/lib/assigned";
import { pageLabel } from "@/lib/labels";
import { opensNewTab } from "@/lib/row-panel";
import type { AssignedRow } from "@/server/assigned";

export type AssignedListGroup = {
  /** A due-date group's key, or a database's id (null: rows shared without their database). */
  key: string | null;
  /** The database's name when grouped by database. */
  databaseTitle?: string | null;
  rows: AssignedRow[];
};

/** Overdue rows stand out; the rest stay quiet. */
const tone = (key: AssignedGroupKey) => (key === "overdue" ? "text-danger" : "text-fg-muted");

type Marked = { propertyId: string; previous: string | null } | "pending";

/**
 * Open database rows assigned to the viewer, in groups: by when they are due (the home page and
 * My tasks) or by database (My tasks). Rows open in the row panel beside the list where there is
 * one, else as pages; a row with a status can be marked done from here, and put back.
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
  // Rows marked done here: they stay, crossed out, until the list is loaded again.
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

  const mark = (rowId: string, value: Marked | null) =>
    setMarked((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(rowId);
      else next.set(rowId, value);
      return next;
    });

  const markDone = async (row: AssignedRow) => {
    setError(null);
    mark(row.id, "pending");
    const result = await markAssignedDoneAction(row.id).catch(() => null);
    if (result?.ok) mark(row.id, result.data);
    else {
      mark(row.id, null);
      setError(result?.error ?? t("myTasks.markFailed"));
    }
  };

  const undo = async (row: AssignedRow) => {
    const done = marked.get(row.id);
    if (!done || done === "pending") return;
    setError(null);
    mark(row.id, "pending");
    const result = await undoAssignedDoneAction(row.id, done.propertyId, done.previous).catch(() => null);
    if (result?.ok) mark(row.id, null);
    else {
      mark(row.id, done);
      setError(result?.error ?? t("myTasks.undoFailed"));
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
            {group.rows.map((row) => {
              const state = marked.get(row.id);
              const done = state !== undefined && state !== "pending";
              const title = pageLabel(row.title, tc("untitled"));
              const due = row.date ? assignedGroup(row.date, today, row.endDate) : "none";
              return (
                <li key={row.id} className="flex items-center gap-2.5 px-4 text-sm hover:bg-bg-hover">
                  {row.markable ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={done}
                      aria-label={done ? t("myTasks.undoLabel", { title }) : t("myTasks.markDone", { title })}
                      title={done ? t("myTasks.undoLabel", { title }) : t("myTasks.markDone", { title })}
                      disabled={state === "pending"}
                      onClick={() => void (done ? undo(row) : markDone(row))}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-50",
                        done ? "border-accent bg-accent text-accent-fg" : "border-fg-faint hover:border-fg-muted",
                      )}
                    >
                      {done && <Check className="h-3 w-3" strokeWidth={3} />}
                    </button>
                  ) : (
                    <PageIcon icon={row.icon} kind={row.kind} className="flex w-4 shrink-0 justify-center text-fg-muted" />
                  )}
                  <a
                    href={`/w/${workspaceId}/p/${row.id}`}
                    data-open-row={row.id}
                    onClick={(e) => open(e, row.id)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 py-3 md:py-2.5"
                  >
                    <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-baseline md:gap-2">
                      <span className={cn("truncate", done && "text-fg-muted line-through")}>{title}</span>
                      {grouping === "due" && row.databaseTitle !== null && (
                        <span className="truncate text-xs text-fg-muted">{pageLabel(row.databaseTitle, tc("untitled"))}</span>
                      )}
                    </span>
                    {/* Phones leave the status out so the title has room. */}
                    {row.status && !done && (
                      <span className="hidden shrink-0 sm:inline-flex">
                        <OptionChip option={row.status} dot />
                      </span>
                    )}
                    {row.date && !done && (
                      <span className={cn("shrink-0 text-xs tabular-nums", tone(due))}>{dateLabel(row.date)}</span>
                    )}
                  </a>
                  {done && (
                    <button type="button" onClick={() => void undo(row)} className="shrink-0 text-xs text-fg-muted hover:text-fg hover:underline">
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
