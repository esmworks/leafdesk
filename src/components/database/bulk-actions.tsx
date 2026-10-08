"use client";

import { ArrowLeft, Copy, Download, Pencil, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, cn, Input, MenuItem } from "@/components/ui";
import { Floating, useFloating } from "./floating";
import { PersonPicker } from "./person-cell";
import { usePropertyAccess } from "./property-access";
import { INPUT_MODE, INVALID_INPUT, OptionPicker, parseInput } from "./property-cell";
import { PropertyTypeIcon } from "./property-icons";
import { RelationPicker } from "./relation-cell";
import type { Property, Row } from "./types";
import type { DatabaseApi } from "./use-database";

/** Property types a selection can be edited in, each with an editor below. */
const BULK_EDITABLE = new Set<string>([
  "text",
  "number",
  "url",
  "email",
  "phone",
  "date",
  "checkbox",
  "select",
  "multi_select",
  "status",
  "relation",
  "person",
]);

/**
 * Which rows of a table are selected. Rows that leave the view (filtered out, trashed, deleted
 * elsewhere) leave the selection. `ids` follows the view's row order.
 */
export function useRowSelection(rows: Row[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // The row the last plain click toggled: shift-click selects from there.
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s;
      const present = new Set(rows.map((r) => r.id));
      const kept = [...s].filter((id) => present.has(id));
      return kept.length === s.size ? s : new Set(kept);
    });
  }, [rows]);

  const ids = useMemo(() => rows.filter((r) => selected.has(r.id)).map((r) => r.id), [rows, selected]);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const toggle = (rowId: string, range: boolean) => {
    const from = anchor.current ? rows.findIndex((r) => r.id === anchor.current) : -1;
    const to = rows.findIndex((r) => r.id === rowId);
    if (range && from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelected((s) => new Set([...s, ...rows.slice(start, end + 1).map((r) => r.id)]));
      return;
    }
    anchor.current = rowId;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const toggleAll = () => {
    if (ids.length === rows.length) clear();
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  // Escape clears the selection. Listening on window lets an open popover's own Escape handler
  // (on document) stop the event first, so Escape closes the popover before the selection.
  const active = ids.length > 0;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, clear]);

  return {
    ids,
    isSelected: (rowId: string) => selected.has(rowId),
    all: rows.length > 0 && ids.length === rows.length,
    some: ids.length > 0,
    toggle,
    toggleAll,
    clear,
  };
}

export type RowSelection = ReturnType<typeof useRowSelection>;

/** A row's (or, with `indeterminate`, the header's) selection checkbox; shift-click selects a range. */
export function SelectBox({
  checked,
  indeterminate,
  label,
  visible,
  onToggle,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  /** Always shown (something is selected); otherwise it appears on hover. */
  visible: boolean;
  onToggle: (range: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  // The wrapper takes the clicks (a mouse click and Space on the focused box both arrive here with
  // their shift key), so the whole 24px square is the target. Hidden boxes stay focusable.
  return (
    <div
      className="flex h-6 w-6 cursor-pointer items-center justify-center"
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={(e) => onToggle(e.shiftKey)}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={() => {}}
        className={cn(
          "pointer-events-none h-3.5 w-3.5 accent-accent",
          !checked &&
            !visible &&
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        )}
      />
    </div>
  );
}

/**
 * The bar that floats over a table while rows are selected: edit a property of every selected
 * row, duplicate them, export them as CSV or move them to the trash. Viewers only get export;
 * guests don't get the trash, and nobody gets export while the workspace has it turned off. The server checks every row again and reports rows it skipped.
 */
export function BulkActionBar({
  workspaceId,
  databaseId,
  properties,
  rows,
  selection,
  api,
  readOnly,
  guest,
  exportable = true,
}: {
  workspaceId: string;
  databaseId: string;
  properties: Property[];
  rows: Row[];
  selection: RowSelection;
  api: DatabaseApi;
  readOnly?: boolean;
  guest?: boolean;
  exportable?: boolean;
}) {
  const t = useTranslations("database.bulk");
  const edit = useFloating<HTMLButtonElement>();
  const [busy, setBusy] = useState(false);
  const ids = selection.ids;
  if (!ids.length) return null;

  const selectedRows = rows.filter((r) => selection.isSelected(r.id));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () =>
    run(async () => {
      try {
        const res = await fetch(`/w/${workspaceId}/p/${databaseId}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: ids }),
        });
        // Export turned off since the table loaded (the bar hides the button while it is off).
        if (res.status === 403 && (await res.json().catch(() => null))?.error === "disabled") return api.showError(t("exportDisabled"));
        if (!res.ok) throw new Error(String(res.status));
        const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
        const url = URL.createObjectURL(await res.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = name ? decodeURIComponent(name) : "export.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        api.showError(t("exportFailed"));
      }
    });

  const action = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-bg-hover disabled:opacity-50";

  return (
    <div
      role="toolbar"
      aria-label={t("actions")}
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-bg p-1 shadow-lg [scrollbar-width:none]"
    >
      <span className="shrink-0 px-2 text-sm font-medium tabular-nums text-accent">{t("selected", { count: ids.length })}</span>
      {!readOnly && (
        <>
          <button ref={edit.ref} type="button" disabled={busy} onClick={edit.toggle} className={action} title={t("editProperty")}>
            <Pencil className="h-3.5 w-3.5 text-fg-muted" />
            <span className="max-sm:sr-only">{t("editProperty")}</span>
          </button>
          <Floating open={edit.open} anchor={edit.el} onClose={edit.close} className="w-72 p-0">
            <BulkEditPanel properties={properties} rows={selectedRows} api={api} onDone={edit.close} />
          </Floating>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => api.duplicateRows(ids).then(selection.clear))}
            className={action}
            title={t("duplicate")}
          >
            <Copy className="h-3.5 w-3.5 text-fg-muted" />
            <span className="max-sm:sr-only">{t("duplicate")}</span>
          </button>
        </>
      )}
      {exportable && (
        <button type="button" disabled={busy} onClick={exportCsv} className={action} title={t("export")}>
          <Download className="h-3.5 w-3.5 text-fg-muted" />
          <span className="max-sm:sr-only">{t("export")}</span>
        </button>
      )}
      {!readOnly && !guest && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!confirm(t("confirmTrash", { count: ids.length }))) return;
            selection.clear();
            void run(() => api.deleteRows(ids));
          }}
          className={cn(action, "text-danger")}
          title={t("trash")}
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="max-sm:sr-only">{t("trash")}</span>
        </button>
      )}
      <button
        type="button"
        onClick={selection.clear}
        aria-label={t("clearSelection")}
        title={t("clearSelection")}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Pick a property, then its new value for every selected row, with the same pickers as cells. */
function BulkEditPanel({
  properties,
  rows,
  api,
  onDone,
}: {
  properties: Property[];
  rows: Row[];
  api: DatabaseApi;
  onDone: () => void;
}) {
  const t = useTranslations("database.bulk");
  const [propId, setPropId] = useState<string | null>(null);
  const access = usePropertyAccess();
  // Property access: only properties whose values the viewer may change (rows that don't allow it
  // are refused by the server and reported).
  const editable = properties.filter((p) => BULK_EDITABLE.has(p.type) && access.canEditValues(p.id));
  const prop = editable.find((p) => p.id === propId);

  if (!prop) {
    return (
      <div className="p-1">
        <div className="px-2 pt-1 pb-1.5 text-xs text-fg-muted">{editable.length ? t("chooseProperty") : t("noEditable")}</div>
        <div className="max-h-72 overflow-y-auto">
          {editable.map((p) => (
            <MenuItem key={p.id} icon={<PropertyTypeIcon type={p.type} className="h-3.5 w-3.5" />} onClick={() => setPropId(p.id)}>
              {p.name}
            </MenuItem>
          ))}
        </div>
      </div>
    );
  }

  // Pickers start from the rows' shared value, or empty when the rows differ.
  const values = rows.map((r) => r.properties[prop.id] ?? null);
  const shared = values.every((v) => JSON.stringify(v) === JSON.stringify(values[0])) ? values[0] : null;
  const apply = (value: unknown) => void api.setCells(rows.map((r) => r.id), prop.id, value);

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-border px-1 py-1">
        <button
          type="button"
          aria-label={t("back")}
          onClick={() => setPropId(null)}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="truncate text-xs text-fg-muted">{t("setValue", { property: prop.name })}</span>
      </div>
      <BulkValueEditor key={prop.id} prop={prop} value={shared} api={api} onApply={apply} onDone={onDone} />
    </div>
  );
}

function BulkValueEditor({
  prop,
  value,
  api,
  onApply,
  onDone,
}: {
  prop: Property;
  value: unknown;
  api: DatabaseApi;
  onApply: (value: unknown) => void;
  onDone: () => void;
}) {
  const t = useTranslations("database.bulk");
  switch (prop.type) {
    case "select":
    case "multi_select":
    case "status":
      return <OptionPicker prop={prop} value={value} onChange={onApply} onCreateOption={api.createOption} onDone={onDone} />;
    case "relation":
      return <RelationPicker prop={prop} value={value} onChange={onApply} />;
    case "person":
      return <PersonPicker prop={prop} value={value} onChange={onApply} />;
    case "checkbox":
      return (
        <div className="p-1">
          {[true, false].map((checked) => (
            <MenuItem
              key={String(checked)}
              active={value === checked}
              onClick={() => {
                onApply(checked);
                onDone();
              }}
            >
              {checked ? t("checked") : t("unchecked")}
            </MenuItem>
          ))}
        </div>
      );
    default:
      return <TextValueEditor prop={prop} value={value} onApply={onApply} onDone={onDone} />;
  }
}

/** A number in the locale's decimal style without grouping, so parseInput reads it back as is. */
function initialText(value: unknown, locale: string) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "number") return String(value);
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value;
  const s = String(value);
  return decimal === "," && !s.includes("e") ? s.replace(".", ",") : s;
}

/** Text, number, URL, email, phone and date values: type, then Apply (Enter) or Clear. */
function TextValueEditor({
  prop,
  value,
  onApply,
  onDone,
}: {
  prop: Property;
  value: unknown;
  onApply: (value: unknown) => void;
  onDone: () => void;
}) {
  const t = useTranslations("database.bulk");
  const tc = useTranslations("database.cell");
  const locale = useLocale();
  const [draft, setDraft] = useState(() => initialText(value, locale));
  const [invalid, setInvalid] = useState(false);
  const date = prop.type === "date";

  const commit = () => {
    const parsed = date ? draft || null : parseInput(prop, draft, locale);
    if (parsed === undefined) {
      setInvalid(true);
      return;
    }
    onApply(parsed);
    onDone();
  };

  return (
    <form
      className="p-2"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <Input
        autoFocus
        type={date ? "date" : "text"}
        inputMode={INPUT_MODE[prop.type]}
        value={draft}
        aria-label={prop.name}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        className="h-8"
      />
      {invalid && (
        <div className="mt-1 text-xs text-danger">{tc(INVALID_INPUT[prop.type] ?? "enterUrl")}</div>
      )}
      <div className="mt-2 flex justify-end gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            onApply(null);
            onDone();
          }}
        >
          {t("clearValue")}
        </Button>
        <Button type="submit" size="sm" variant="primary">
          {t("apply")}
        </Button>
      </div>
    </form>
  );
}
