"use client";

import { Eye, EyeOff, Square, SquareCheck } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";
import { cn } from "@/components/ui";
import type { Group, GroupContext, GroupValue } from "@/lib/grouping";
import { pageLabel } from "@/lib/labels";
import { statusColor } from "@/lib/properties";
import { timestampDay } from "@/lib/time-zone";
import { Floating, useFloating } from "./floating";
import { PersonAvatar, usePeople } from "./person-cell";
import { OptionChip } from "./property-cell";
import { useRelations } from "./relation-context";
import type { Property } from "./types";
import { useViewerTimeZone } from "./use-today";

type AnyGroup = Pick<Group<unknown>, "key" | "value">;

/**
 * What grouping needs besides the rows: the people and related rows groups stand for, and the
 * viewer's day of a created or edited time.
 */
export function useGroupContext(prop: Pick<Property, "id" | "type"> | undefined): GroupContext {
  const { people } = usePeople();
  const relations = useRelations();
  const relationRows = prop?.type === "relation" ? relations?.targets[prop.id]?.rows : undefined;
  const timeZone = useViewerTimeZone();
  return useMemo(
    () => ({ people, relationRows, dayOf: (value: unknown) => timestampDay(value, timeZone) }),
    [people, relationRows, timeZone],
  );
}

/** A date group's name: the day, the week's first and last day, the month or the year. */
function useDateGroupName() {
  const format = useFormatter();
  return (value: Extract<GroupValue, { kind: "date" }>) => {
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
  };
}

/** A group's name as plain text, for labels and menus. */
export function useGroupName(prop: Pick<Property, "name">) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const dateName = useDateGroupName();
  return (group: AnyGroup) => {
    const value = group.value;
    switch (value.kind) {
      case "none":
        return t("board.noValue", { property: prop.name });
      case "option":
        return value.option.name || tc("untitled");
      case "status_group":
        return t(`statusGroups.${value.group}`);
      case "person":
        return value.person.name || t("person.unknown");
      case "checkbox":
        return value.checked ? t("group.checked") : t("group.unchecked");
      case "date":
        return dateName(value);
      case "relation":
        return pageLabel(value.row.title, tc("untitled"));
    }
  };
}

/** How a group is titled on board columns, table sections and the hidden groups list. */
export function GroupLabel({ prop, group, className }: { prop: Property; group: AnyGroup; className?: string }) {
  const name = useGroupName(prop)(group);
  const value = group.value;
  switch (value.kind) {
    case "option":
      return <OptionChip option={value.option} dot={prop.type === "status"} className={cn("min-w-0 truncate", className)} />;
    case "status_group":
      return (
        <OptionChip
          option={{ id: value.group, name, color: statusColor(value.group) }}
          dot
          className={cn("min-w-0 truncate", className)}
        />
      );
    case "person":
      return <PersonGroupLabel person={value.person} className={className} />;
    case "none":
      return <span className="min-w-0 truncate text-sm text-fg-muted">{name}</span>;
    case "checkbox":
      return (
        <span className={cn("flex min-w-0 items-center gap-1.5 text-sm", className)}>
          {value.checked ? (
            <SquareCheck aria-hidden className="h-4 w-4 shrink-0 text-accent" />
          ) : (
            <Square aria-hidden className="h-4 w-4 shrink-0 text-fg-muted" />
          )}
          <span className="truncate">{name}</span>
        </span>
      );
    case "relation":
      return (
        <span className={cn("flex min-w-0 items-center gap-1.5 text-sm", className)}>
          {value.row.icon && <span className="shrink-0">{value.row.icon}</span>}
          <span className="truncate">{name}</span>
        </span>
      );
    case "date":
      // Published pages render this on the server, whose date formatting may space ranges
      // differently from the browser's.
      return (
        <span suppressHydrationWarning className={cn("min-w-0 truncate text-sm", className)}>
          {name}
        </span>
      );
  }
}

/** A person group's title: their avatar and name, muted once they left the workspace. */
function PersonGroupLabel({
  person,
  className,
}: {
  person: Extract<GroupValue, { kind: "person" }>["person"];
  className?: string;
}) {
  const t = useTranslations("database.person");
  const tc = useTranslations("common");
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1.5 text-sm", !person.active && !person.isAgent && "text-fg-muted", className)}
      title={person.isAgent ? tc("agent") : person.active ? undefined : t("former")}
    >
      <PersonAvatar person={person} />
      <span className="truncate">{person.name || t("unknown")}</span>
    </span>
  );
}

/** Lists the groups hidden in a view, each with a way to bring it back. */
export function HiddenGroups({
  prop,
  groups,
  readOnly,
  onShow,
  className,
}: {
  prop: Property;
  groups: (AnyGroup & { rows: unknown[] })[];
  readOnly?: boolean;
  onShow: (key: string) => void;
  className?: string;
}) {
  const t = useTranslations("database.board");
  const menu = useFloating<HTMLButtonElement>();
  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        onClick={menu.toggle}
        className={cn(
          "flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg",
          className,
        )}
      >
        <EyeOff className="h-3.5 w-3.5" />
        {t("hiddenGroups", { count: groups.length })}
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close}>
        <div className="w-60">
          {groups.map((g) => (
            <div key={g.key} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-bg-hover">
              <GroupLabel prop={prop} group={g} />
              <span className="text-xs text-fg-muted tabular-nums">{g.rows.length}</span>
              <span className="flex-1" />
              {!readOnly && (
                <button
                  type="button"
                  aria-label={t("showGroup")}
                  title={t("showGroup")}
                  onClick={() => {
                    if (groups.length === 1) menu.close();
                    onShow(g.key);
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-fg/10 hover:text-fg"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </Floating>
    </>
  );
}
