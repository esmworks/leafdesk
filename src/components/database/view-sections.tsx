"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useToggleAllGroups } from "@/components/toggle-all";
import { arrangeGroups, canAddToGroup, groupDefaults, groupRowsBy, isGroupable, type Group } from "@/lib/grouping";
import { GroupHeader, HiddenGroups, useGroupContext, useGroupName } from "./group-label";
import { usePeople } from "./person-cell";
import { usePropertyAccess } from "./property-access";
import { useToday } from "./use-today";
import type { Property, Row, View } from "./types";
import type { DatabaseApi } from "./use-database";

/**
 * A list or gallery in sections, one per group of the property the view groups by (ViewConfig
 * groupBy), each folding away like a table's; without grouping, just `children` of every row.
 * `children` lays out a group's rows (null without grouping); `group` is passed to add rows into it.
 */
export function ViewSections({
  view,
  properties,
  rows,
  api,
  readOnly,
  onAdd,
  children,
}: {
  view: View;
  properties: Property[];
  rows: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
  /** Adds a row with these values (a group's); missing where rows can't be added. */
  onAdd?: (values: Record<string, unknown>) => void;
  children: (rows: Row[], group: SectionGroup | null) => ReactNode;
}) {
  const groupBy = properties.find((p) => p.id === view.config.groupBy && isGroupable(p.type));
  const groupContext = useGroupContext(groupBy);
  const groupName = useGroupName(groupBy ?? { name: "" });
  const access = usePropertyAccess();
  const { viewerId } = usePeople();
  const today = useToday();
  // Viewers can't save the view, so what they fold stays on this page, as in tables.
  const [ownCollapsed, setOwnCollapsed] = useState<string[] | null>(null);
  const collapsed = useMemo(() => new Set(ownCollapsed ?? view.config.collapsedGroups ?? []), [ownCollapsed, view.config.collapsedGroups]);
  const grouping = useMemo(
    () => (groupBy ? arrangeGroups(groupRowsBy(rows, groupBy, view.config, groupContext), view.config) : null),
    [rows, groupBy, view.config, groupContext],
  );
  const groupKeys = useMemo(() => grouping?.shown.map((g) => g.key) ?? null, [grouping]);
  useToggleAllGroups(groupKeys, collapsed, setOwnCollapsed);

  if (!groupBy || !grouping) return children(rows, null);

  const toggle = (key: string) => {
    const next = collapsed.has(key) ? [...collapsed].filter((k) => k !== key) : [...collapsed, key];
    if (readOnly) setOwnCollapsed(next);
    else {
      setOwnCollapsed(null);
      void api.updateView(view, { config: { ...view.config, collapsedGroups: next } });
    }
  };
  const setHidden = (key: string, hide: boolean) => {
    const next = (view.config.hiddenGroups ?? []).filter((k) => k !== key);
    if (hide) next.push(key);
    void api.updateView(view, { config: { ...view.config, hiddenGroups: next } });
  };
  // Rows can't be given who created them or when: such groups only take rows in the viewer's own.
  const valuesOf = (group: Group<Row>) =>
    !readOnly && (group.value.kind === "none" || access.canEditValues(groupBy.id)) && canAddToGroup(groupBy, group, { viewerId, today })
      ? groupDefaults(groupBy, group)
      : undefined;

  return (
    <div className="flex flex-col gap-2">
      {grouping.shown.map((group) => {
        const open = !collapsed.has(group.key);
        const values = valuesOf(group);
        const add = values && onAdd ? () => onAdd(values) : undefined;
        const name = groupName(group);
        return (
          <section key={group.key || "__none"} aria-label={name}>
            <GroupHeader
              prop={groupBy}
              group={group}
              name={name}
              open={open}
              readOnly={readOnly}
              canAdd={!!add}
              onToggle={() => toggle(group.key)}
              onHide={() => setHidden(group.key, true)}
              onAdd={() => add?.()}
            />
            {open && <div className="pt-1">{children(group.rows, { add, values })}</div>}
          </section>
        );
      })}
      {grouping.hidden.length > 0 && (
        <HiddenGroups prop={groupBy} groups={grouping.hidden} readOnly={readOnly} onShow={(key) => setHidden(key, false)} className="self-start" />
      )}
    </div>
  );
}

/**
 * A section's rows are laid out with this: `add` adds a row into the group and `values` are what a
 * row there gets, when the viewer may add one.
 */
export type SectionGroup = { add?: () => void; values?: Record<string, unknown> };
