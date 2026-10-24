"use client";

import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { cn, PageIcon } from "@/components/ui";
import { SECTION_PAGE, shownPropertyIds } from "@/lib/relation-options";
import { pageLabel } from "@/lib/labels";
import { Floating, useFloating } from "./floating";
import { PeopleProvider, usePeople } from "./person-cell";
import { PropertyCell, type CreateOption } from "./property-cell";
import { HiddenValue } from "./property-access";
import { PropertyTypeIcon } from "./property-icons";
import { RelationPicker } from "./relation-cell";
import { linkedRows, useRelations } from "./relation-context";
import { RowCellProvider } from "./row-cell-context";
import { SchemaProvider } from "./schema-context";
import type { Property } from "./types";

/**
 * A relation shown as a section of its own on a row page (RelationConfig `display: "section"`,
 * lib/relation-options): the linked rows, the first SECTION_PAGE and more on request, each with the
 * properties the relation shows (`show`) editable in place, and links added or removed here. Values
 * of the related rows are written to those rows; the server checks access there as for any write.
 * Loaded only by row pages that have such a relation.
 */
export default function RelationSection({
  prop,
  value,
  readOnly,
  onChange,
  onRelatedChange,
  onCreateOption,
}: {
  prop: Property;
  value: unknown;
  readOnly: boolean;
  /** The relation's new value: links added or removed. */
  onChange: (value: unknown) => void;
  /** A value of a linked row changed. */
  onRelatedChange: (rowId: string, propertyId: string, value: unknown) => void;
  onCreateOption: CreateOption;
}) {
  const t = useTranslations("database.relation");
  const tc = useTranslations("common");
  const ctx = useRelations();
  const target = ctx?.targets[prop.id];
  const rows = linkedRows(target, value);
  const [count, setCount] = useState(SECTION_PAGE);
  const picker = useFloating<HTMLButtonElement>();
  const outer = usePeople();
  const people = useMemo(
    () => (target?.people ? { viewerId: outer.viewerId, people: mergePeople(outer.people, target.people) } : outer),
    [target?.people, outer],
  );
  // The related database's properties as cells take them (they belong to that database).
  const schema = useMemo(
    () => (target?.properties ?? []).map((p) => ({ ...p, databaseId: target?.database?.id ?? "" }) as Property),
    [target?.properties, target?.database?.id],
  );
  const columns = shownPropertyIds(prop.options.relation).flatMap((id) => schema.find((p) => p.id === id) ?? []);
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const unlink = (id: string) => {
    const rest = ids.filter((x) => x !== id);
    onChange(rest.length ? rest : null);
  };
  const href = (id: string) => `/w/${ctx?.workspaceId}/p/${id}`;
  const grid = { gridTemplateColumns: `minmax(10rem, 1fr) ${columns.map(() => "minmax(7rem, 11rem)").join(" ")} 1.75rem` };

  return (
    <section aria-label={prop.name} className="mb-6">
      <div className="mb-1 flex h-[30px] items-center gap-1.5 text-sm">
        <PropertyTypeIcon type="relation" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <h3 className="truncate font-medium">{prop.name}</h3>
        <span className="text-xs text-fg-faint tabular-nums">{rows.length}</span>
        {!readOnly && (
          <>
            <button
              ref={picker.ref}
              type="button"
              aria-expanded={picker.open}
              onClick={picker.toggle}
              className="ms-auto inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("addLink")}
            </button>
            <Floating open={picker.open} anchor={picker.el} onClose={picker.close}>
              <RelationPicker prop={prop} value={value} onChange={onChange} />
            </Floating>
          </>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-border px-1 py-2 text-sm text-fg-faint">{t("noLinks")}</p>
      ) : (
        <PeopleProvider value={people}>
          <SchemaProvider value={schema}>
            <div className="overflow-x-auto border-t border-border">
              <div role="table" aria-label={prop.name} className="min-w-fit text-sm">
                {columns.length > 0 && (
                  <div role="row" className="grid items-center gap-x-1 border-b border-border text-xs text-fg-muted" style={grid}>
                    <span role="columnheader" className="truncate px-1 py-1">
                      {t("titlePart")}
                    </span>
                    {columns.map((c) => (
                      <span key={c.id} role="columnheader" className="flex min-w-0 items-center gap-1 px-2 py-1">
                        <PropertyTypeIcon type={c.type} className="h-3 w-3 shrink-0" />
                        <span className="truncate">{c.name}</span>
                      </span>
                    ))}
                    <span />
                  </div>
                )}
                {rows.slice(0, count).map((row) => (
                  <RowCellProvider key={row.id} value={{ rowId: row.id, template: false }}>
                    <div role="row" className="group grid items-center gap-x-1 border-b border-border" style={grid}>
                      <Link
                        role="cell"
                        href={href(row.id)}
                        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 hover:bg-bg-hover"
                      >
                        <PageIcon icon={row.icon} className="h-4 w-4 shrink-0 text-sm" />
                        <span className="truncate font-medium">{pageLabel(row.title, tc("untitled"))}</span>
                      </Link>
                      {columns.map((c) => (
                        <div key={c.id} role="cell" className="min-w-0">
                          {row.hidden?.includes(c.id) ? (
                            <span className="flex min-h-[30px] items-center px-2">
                              <HiddenValue />
                            </span>
                          ) : (
                            <PropertyCell
                              variant="panel"
                              prop={c}
                              value={row.values?.[c.id]}
                              readOnly={readOnly}
                              rowValues={row.values}
                              onChange={(v) => onRelatedChange(row.id, c.id, v)}
                              onCreateOption={onCreateOption}
                            />
                          )}
                        </div>
                      ))}
                      {!readOnly ? (
                        <button
                          type="button"
                          aria-label={t("unlink", { title: pageLabel(row.title, tc("untitled")) })}
                          title={t("unlink", { title: pageLabel(row.title, tc("untitled")) })}
                          onClick={() => unlink(row.id)}
                          className={cn(
                            "inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-active hover:text-fg",
                            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                          )}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <span />
                      )}
                    </div>
                  </RowCellProvider>
                ))}
              </div>
            </div>
          </SchemaProvider>
        </PeopleProvider>
      )}
      {rows.length > count && (
        <button
          type="button"
          onClick={() => setCount((n) => n + SECTION_PAGE)}
          className="mt-1 inline-flex h-7 items-center rounded-md px-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          {t("showMore", { count: rows.length - count })}
        </button>
      )}
    </section>
  );
}

/** The row's people and those its linked rows name, each once. */
function mergePeople<P extends { id: string }>(own: P[], related: P[]): P[] {
  const known = new Set(own.map((p) => p.id));
  return [...own, ...related.filter((p) => !known.has(p.id))];
}
