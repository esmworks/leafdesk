"use client";

import { Check, ExternalLink, Plus, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import {
  asChecklist,
  checklistProgress,
  isEmailAddress,
  isPhoneNumber,
  phoneHref,
  sortStatusOptions,
  statusGroupOf,
} from "@/lib/properties";
import { derivedType, isErrorValue, rollupFormat } from "@/lib/derived";
import { asFiles } from "@/lib/files";
import { holdsPeople, isDerived, isReadOnlyType } from "@/lib/property-types";
import { FilesDisplay, FilesEditor, type UploadFile } from "./files-cell";
import { Floating } from "./floating";
import { useFormulaErrorMessage } from "./formula-editor";
import { PersonChips, PersonPicker } from "./person-cell";
import { HiddenValue } from "./property-access";
import { RelationChips, RelationPicker } from "./relation-cell";
import { useRelations } from "./relation-context";
import type { ChecklistItem, Property, SelectOption } from "./types";
import { searchFold } from "@/lib/search-fold";
import type { NumberFormat, PropertyOptions } from "@/db/schema/app";
import { calculationFormat, numberFormatOptions, numberText, readNumber } from "@/lib/number-format";

export type CreateOption = (propertyId: string, name: string) => Promise<SelectOption | null>;

export function OptionChip({
  option,
  onRemove,
  className,
  dot,
}: {
  option: SelectOption;
  onRemove?: () => void;
  className?: string;
  /** Status options show a dot before the name. */
  dot?: boolean;
}) {
  const t = useTranslations("database.cell");
  const tc = useTranslations("common");
  return (
    <span
      className={cn(
        `opt-${option.color} inline-flex max-w-full min-w-0 items-center gap-0.5 rounded px-1.5 text-xs leading-5`,
        className,
      )}
    >
      {dot && <span aria-hidden className="mr-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />}
      <span className="truncate">{option.name || tc("untitled")}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={t("removeOption", { name: option.name })}
          className="-mr-0.5 rounded opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function optionsOf(prop: Property) {
  return prop.options.options ?? [];
}

function selectedOptions(prop: Property, value: unknown): SelectOption[] {
  const ids = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const options = optionsOf(prop);
  return ids.map((id) => options.find((o) => o.id === id)).filter((o): o is SelectOption => Boolean(o));
}

/**
 * Formats stored date values (`YYYY-MM-DD`) in the UI locale. Dates are calendar days, so they are
 * read and printed in UTC; the viewer's time zone must not shift them by a day.
 */
export function useFormatDate() {
  const format = useFormatter();
  return (value: string) => {
    const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(d.getTime())) return value;
    return format.dateTime(d, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  };
}

/** Formats a timestamp (created or last edited time) as date and time in the viewer's locale and time zone. */
export function useFormatDateTime() {
  const format = useFormatter();
  return (value: string) => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  };
}

/**
 * Formats a number value in the UI locale (grouping and decimal separator), as a percentage or
 * an amount of money when the property's number format says so. `auto`: the most decimal places
 * when the format doesn't fix them (see lib/number-format).
 */
export function useFormatNumber() {
  const format = useFormatter();
  return (value: number, numberFormat?: NumberFormat | null, auto?: number) => format.number(value, numberFormatOptions(numberFormat, auto));
}

export function isEmptyValue(prop: Property, value: unknown) {
  if (value === null || value === undefined || value === "") return true;
  // A formula's unticked checkbox counts as empty, like a checkbox property's.
  if (isDerived(prop.type)) return value === false || (Array.isArray(value) && value.length === 0);
  if (prop.type === "relation" || holdsPeople(prop.type)) return !Array.isArray(value) || value.length === 0;
  if (prop.type === "checklist") return asChecklist(value).length === 0;
  if (prop.type === "files") return asFiles(value).length === 0;
  if (Array.isArray(value)) return selectedOptions(prop, value).length === 0;
  if (prop.type === "select" || prop.type === "status") return selectedOptions(prop, value).length === 0;
  if (prop.type === "checkbox") return value !== true;
  return false;
}

/** Read-only rendering of a property value (board cards, read-only panels). */
export function PropertyDisplay({ prop, value, wrap }: { prop: Property; value: unknown; wrap?: boolean }) {
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  const formatNumber = useFormatNumber();
  if (value === null || value === undefined || value === "") return null;
  switch (prop.type) {
    case "text":
      return <span className={cn(wrap ? "whitespace-pre-wrap break-words" : "truncate")}>{String(value)}</span>;
    case "number":
      return <span className="tabular-nums">{typeof value === "number" ? formatNumber(value, prop.options.number) : String(value)}</span>;
    case "url":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate text-fg underline decoration-border underline-offset-2 hover:decoration-fg-muted"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value).replace(/^https?:\/\//i, "")}
        </a>
      );
    case "email":
    case "phone":
      return (
        <a
          href={prop.type === "email" ? `mailto:${String(value)}` : phoneHref(String(value))}
          className="truncate text-fg underline decoration-border underline-offset-2 hover:decoration-fg-muted"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value)}
        </a>
      );
    case "date":
      return <span>{formatDate(String(value))}</span>;
    case "created_time":
    case "last_edited_time":
      return <span className="truncate">{formatDateTime(String(value))}</span>;
    case "checklist":
      return <ChecklistDisplay value={value} wrap={wrap} />;
    case "files":
      return <FilesDisplay value={value} wrap={wrap} />;
    case "checkbox":
      return <CheckboxBox checked={value === true} />;
    case "relation":
      return <RelationChips prop={prop} value={value} wrap={wrap} />;
    case "person":
    case "created_by":
    case "last_edited_by":
      return <PersonChips value={value} wrap={wrap} />;
    case "formula":
    case "rollup":
      return <DerivedDisplay prop={prop} value={value} wrap={wrap} />;
    case "select":
    case "multi_select":
    case "status": {
      const selected = selectedOptions(prop, value);
      if (!selected.length) return null;
      return (
        <span className={cn("flex min-w-0 gap-1", wrap ? "flex-wrap" : "overflow-hidden")}>
          {selected.map((o) => (
            <OptionChip key={o.id} option={o} dot={prop.type === "status"} />
          ))}
        </span>
      );
    }
  }
}

type RowValues = { properties: Record<string, unknown>; hidden?: string[] };

/**
 * The properties a card or list entry shows for a row: those with a value, and those whose value
 * the viewer may not see (a lock stands in for it, see RowValue).
 */
export function shownValues<P extends Property>(props: P[], row: RowValues): P[] {
  return props.filter((p) => row.hidden?.includes(p.id) || !isEmptyValue(p, row.properties[p.id]));
}

/** A row's value, read-only: its display, or a lock when the viewer may not see it (property access). */
export function RowValue({ prop, row, wrap }: { prop: Property; row: RowValues; wrap?: boolean }) {
  if (row.hidden?.includes(prop.id)) return <HiddenValue />;
  return <PropertyDisplay prop={prop} value={row.properties[prop.id]} wrap={wrap} />;
}

/**
 * A formula's value, shown as its result type; a row the formula fails on shows an error marker
 * with the reason on hover.
 */
function DerivedDisplay({ prop, value, wrap }: { prop: Property; value: unknown; wrap?: boolean }) {
  const t = useTranslations("database.formula");
  const errorMessage = useFormulaErrorMessage();
  const formatDate = useFormatDate();
  const formatDateTime = useFormatDateTime();
  const formatNumber = useFormatNumber();
  if (isErrorValue(value)) {
    const message = t("errorTitle", { message: errorMessage(value.error) });
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-xs text-danger" title={message} aria-label={message}>
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{t("error")}</span>
      </span>
    );
  }
  if (Array.isArray(value)) {
    return <span className={cn(wrap ? "whitespace-pre-wrap break-words" : "truncate")}>{value.map(String).join(", ")}</span>;
  }
  if (prop.type === "rollup" && typeof value === "number") return <RollupNumber prop={prop} value={value} />;
  switch (derivedType(prop)) {
    case "number":
      return <span className="tabular-nums">{typeof value === "number" ? formatNumber(value) : String(value)}</span>;
    case "checkbox":
      return <CheckboxBox checked={value === true} />;
    case "date": {
      const text = String(value);
      return <span className="truncate">{text.length > 10 ? formatDateTime(text) : formatDate(text)}</span>;
    }
    default:
      return <span className={cn(wrap ? "whitespace-pre-wrap break-words" : "truncate")}>{String(value)}</span>;
  }
}

/**
 * A rollup's number: a count or sum, a length of time in days, or a percentage shown as a
 * number, a bar or a ring (the rollup's display setting).
 */
function RollupNumber({ prop, value }: { prop: Property; value: number }) {
  const t = useTranslations("database.calculate");
  const format = useFormatter();
  const formatNumber = useFormatNumber();
  const relations = useRelations();
  const config = prop.options.rollup;
  const kind = rollupFormat(config?.function);
  if (kind === "days") return <span className="tabular-nums">{t("days", { count: value })}</span>;
  if (kind !== "percent") {
    // Averages and medians rarely end evenly; two decimals are plenty, as in table footers.
    const rounded = config?.function === "average" || config?.function === "median";
    // A sum of amounts is an amount: in the format of the number property it reads, when known here.
    const target = config && relations?.targets[config.relationPropertyId]?.properties.find((p) => p.id === config.targetPropertyId);
    const unit = config && target?.type === "number" ? calculationFormat(config.function, target.options) : undefined;
    return <span className="tabular-nums">{formatNumber(value, unit, rounded ? 2 : undefined)}</span>;
  }
  const text = format.number(value, { style: "percent", maximumFractionDigits: 1 });
  const share = Math.min(1, Math.max(0, value));
  const label = <span className="text-xs text-fg-muted tabular-nums">{text}</span>;
  if (config?.display === "bar") {
    return (
      <span className="flex min-w-0 items-center gap-2" title={text}>
        <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-bg-active">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
        {label}
      </span>
    );
  }
  if (config?.display === "ring") {
    const r = 6;
    const length = 2 * Math.PI * r;
    return (
      <span className="flex min-w-0 items-center gap-1.5" title={text}>
        <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-bg-active" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="stroke-accent"
            strokeDasharray={`${share * length} ${length}`}
          />
        </svg>
        {label}
      </span>
    );
  }
  return <span className="tabular-nums">{text}</span>;
}

/** A checklist's progress as a bar and "2/5"; wrapped (row panels, published pages) with its items. */
function ChecklistDisplay({ value, wrap }: { value: unknown; wrap?: boolean }) {
  const t = useTranslations("database.checklist");
  const progress = checklistProgress(value);
  if (!progress) return null;
  const bar = (
    <span className="flex min-w-0 items-center gap-2" title={t("progress", progress)}>
      <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-bg-active">
        <span
          className="block h-full rounded-full bg-accent"
          style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
        />
      </span>
      <span className="text-xs text-fg-muted tabular-nums">
        {progress.done}/{progress.total}
      </span>
    </span>
  );
  if (!wrap) return bar;
  return (
    <span className="flex min-w-0 flex-col gap-1 py-0.5">
      {bar}
      {asChecklist(value).map((item) => (
        <span key={item.id} className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5">
            <CheckboxBox checked={item.checked} />
          </span>
          <span className={cn("break-words", item.checked && "text-fg-muted line-through")}>{item.text}</span>
        </span>
      ))}
    </span>
  );
}

export function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border",
        checked ? "border-accent bg-accent text-accent-fg" : "border-fg-faint bg-bg",
      )}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </span>
  );
}

/**
 * Editable property value. Text-like values edit in a floating editor that covers the cell;
 * selects open an option picker; checkboxes toggle in place. Drafts are local, so refetches
 * never overwrite what the user is typing.
 */
export function PropertyCell({
  prop,
  value,
  onChange,
  onCreateOption,
  readOnly: readOnlyProp,
  hidden,
  variant = "table",
  wrap,
  autoEdit,
  draft,
  placeholder,
  upload,
}: {
  prop: Property;
  value: unknown;
  onChange: (value: unknown) => void;
  onCreateOption: CreateOption;
  readOnly?: boolean;
  /** The viewer may not see this value (property access): a lock stands in for it. */
  hidden?: boolean;
  variant?: "table" | "panel";
  wrap?: boolean;
  /** Start in edit mode (e.g. the title of a freshly created row). */
  autoEdit?: boolean;
  /** Text typed before the editor opened; a text editor starts with it instead of the value. */
  draft?: string;
  placeholder?: string;
  /** Files properties: where new files are stored (the row); without it files can only be removed. */
  upload?: UploadFile;
}) {
  const t = useTranslations("database.cell");
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  // Who created or last edited a row, and when, is filled in by Leafdesk and never edited; formulas
  // are worked out from the row.
  const readOnly = readOnlyProp || hidden || isReadOnlyType(prop.type);
  const [editing, setEditing] = useState(Boolean(autoEdit) && !readOnly);

  const base = cn(
    "flex w-full min-w-0 items-center text-sm",
    variant === "table" ? "min-h-[33px] px-2 py-1" : "min-h-[30px] rounded-md px-2 py-1",
    !readOnly && "cursor-pointer",
    !readOnly && variant === "panel" && "hover:bg-bg-hover",
  );

  if (hidden) {
    return (
      <div className={base}>
        <HiddenValue />
      </div>
    );
  }

  if (prop.type === "checkbox") {
    return (
      <div className={cn(base, "cursor-default")}>
        <button
          type="button"
          role="checkbox"
          aria-checked={value === true}
          aria-label={prop.name}
          disabled={readOnly}
          className="inline-flex disabled:cursor-default"
          onClick={() => onChange(!(value === true))}
        >
          <CheckboxBox checked={value === true} />
        </button>
      </div>
    );
  }

  // A checkbox formula shows its box ticked or not, like a checkbox property.
  const empty = derivedType(prop) === "checkbox" && value === false ? false : isEmptyValue(prop, value);
  return (
    <>
      <div
        ref={setAnchor}
        className={base}
        role={readOnly ? undefined : "button"}
        tabIndex={readOnly ? undefined : 0}
        onClick={() => !readOnly && setEditing(true)}
        onKeyDown={(e) => {
          if (!readOnly && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {empty ? (
          (placeholder ?? (variant === "panel" ? t("empty") : null)) && (
            <span className="truncate text-fg-faint">{placeholder ?? t("empty")}</span>
          )
        ) : (
          <PropertyDisplay prop={prop} value={value} wrap={wrap} />
        )}
      </div>
      {editing && (
        <CellEditor
          prop={prop}
          value={value}
          anchor={anchor}
          onChange={onChange}
          onCreateOption={onCreateOption}
          onClose={() => setEditing(false)}
          draft={draft}
          upload={upload}
        />
      )}
    </>
  );
}

function CellEditor({
  prop,
  value,
  anchor,
  onChange,
  onCreateOption,
  onClose,
  draft,
  upload,
}: {
  prop: Property;
  value: unknown;
  anchor: HTMLElement | null;
  onChange: (value: unknown) => void;
  onCreateOption: CreateOption;
  onClose: () => void;
  draft?: string;
  upload?: UploadFile;
}) {
  switch (prop.type) {
    case "text":
    case "number":
    case "url":
    case "email":
    case "phone":
      return <TextEditor prop={prop} value={value} anchor={anchor} onChange={onChange} onClose={onClose} startWith={draft} />;
    case "checklist":
      return (
        <Floating open anchor={anchor} onClose={onClose} className="w-80 p-0">
          <ChecklistEditor prop={prop} value={value} onChange={onChange} />
        </Floating>
      );
    case "files":
      return (
        <Floating open anchor={anchor} onClose={onClose} className="w-80 p-0">
          <FilesEditor name={prop.name} value={value} onChange={onChange} upload={upload} />
        </Floating>
      );
    case "date":
      return <DateEditor value={value} anchor={anchor} onChange={onChange} onClose={onClose} />;
    case "select":
    case "multi_select":
    case "status":
      return (
        <Floating open anchor={anchor} onClose={onClose} className="w-72 p-0">
          <OptionPicker
            prop={prop}
            value={value}
            onChange={onChange}
            onCreateOption={onCreateOption}
            onDone={onClose}
          />
        </Floating>
      );
    case "relation":
      return (
        <Floating open anchor={anchor} onClose={onClose} className="w-auto p-0">
          <RelationPicker prop={prop} value={value} onChange={onChange} />
        </Floating>
      );
    case "person":
      return (
        <Floating open anchor={anchor} onClose={onClose} className="w-auto p-0">
          <PersonPicker prop={prop} value={value} onChange={onChange} />
        </Floating>
      );
    default:
      return null;
  }
}

/** Parses editor input into a storable value; returns undefined when it is invalid. */
export function parseInput(prop: Pick<Property, "type"> & { options?: PropertyOptions }, raw: string, locale?: string): unknown {
  const s = raw.trim();
  if (!s) return null;
  if (prop.type === "number") return readNumber(s, prop.options?.number, locale);
  if (prop.type === "url") {
    if (/^(https?:\/\/|mailto:)/i.test(s)) return s;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return `mailto:${s}`;
    if (/^[^\s]+\.[^\s]+$/.test(s)) return `https://${s}`;
    return undefined;
  }
  if (prop.type === "email") {
    const email = s.replace(/^mailto:/i, "");
    return isEmailAddress(email) ? email : undefined;
  }
  if (prop.type === "phone") {
    const phone = s.replace(/^tel:/i, "").replace(/\s+/g, " ");
    return isPhoneNumber(phone) ? phone : undefined;
  }
  return raw;
}

/**
 * Initial editor text for a stored value. Numbers use the locale's decimal separator (no
 * grouping), and percentages percent points, so what the user sees is what `parseInput` reads
 * back.
 */
export function editText(value: unknown, locale: string, numberFormat?: NumberFormat | null) {
  if (value === null || value === undefined) return "";
  return typeof value === "number" ? numberText(value, locale, numberFormat) : String(value);
}

/** Hint under a text editor whose draft can't be saved, per property type (`database.cell.*`). */
export const INVALID_INPUT: Partial<Record<Property["type"], "enterNumber" | "enterUrl" | "enterEmail" | "enterPhone">> = {
  number: "enterNumber",
  url: "enterUrl",
  email: "enterEmail",
  phone: "enterPhone",
};

/** Keyboard hints for touch devices. */
export const INPUT_MODE: Partial<Record<Property["type"], "decimal" | "email" | "tel">> = {
  number: "decimal",
  email: "email",
  phone: "tel",
};

function TextEditor({
  prop,
  value,
  anchor,
  onChange,
  onClose,
  startWith,
}: {
  prop: Property;
  value: unknown;
  anchor: HTMLElement | null;
  onChange: (value: unknown) => void;
  onClose: () => void;
  startWith?: string;
}) {
  const t = useTranslations("database.cell");
  const locale = useLocale();
  const initial = editText(value, locale, prop.type === "number" ? prop.options.number : undefined);
  const [draft, setDraft] = useState(startWith || initial);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const commit = () => {
    if (draft !== initial) {
      const parsed = parseInput(prop, draft, locale);
      // A second close attempt with an invalid draft discards it instead of trapping the user.
      if (parsed === undefined && !invalid) {
        setInvalid(true);
        input.current?.focus();
        return false;
      }
      if (parsed !== undefined) onChange(parsed);
    }
    onClose();
    return true;
  };

  return (
    <Floating open cover anchor={anchor} onClose={commit} className="w-auto max-w-[min(28rem,calc(100vw-1rem))] p-0">
      <textarea
        ref={input}
        rows={1}
        value={draft}
        inputMode={INPUT_MODE[prop.type]}
        aria-label={prop.name}
        onChange={(e) => {
          setDraft(prop.type === "text" ? e.target.value : e.target.value.replace(/\n/g, ""));
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
        }}
        className={cn(
          "block w-full min-w-[240px] resize-none bg-transparent px-2 py-1.5 text-sm leading-5 outline-none",
          prop.type === "number" && "tabular-nums",
        )}
      />
      {invalid && (
        <div className="border-t border-border px-2 py-1 text-xs text-danger">
          {t(INVALID_INPUT[prop.type] ?? "enterUrl")}
        </div>
      )}
    </Floating>
  );
}

function DateEditor({
  value,
  anchor,
  onChange,
  onClose,
}: {
  value: unknown;
  anchor: HTMLElement | null;
  onChange: (value: unknown) => void;
  onClose: () => void;
}) {
  const t = useTranslations("database.cell");
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <Floating open anchor={anchor} onClose={onClose} className="w-64 p-2">
      <input
        ref={input}
        type="date"
        value={draft}
        aria-label={t("date")}
        onChange={(e) => {
          setDraft(e.target.value);
          // An emptied field clears the date, like the Clear button.
          onChange(e.target.value || null);
        }}
        onKeyDown={(e) => e.key === "Enter" && onClose()}
        className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
      />
      <div className="mt-2 flex justify-between gap-2">
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
          onClick={() => {
            const today = new Date();
            const iso = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
            setDraft(iso);
            onChange(iso);
          }}
        >
          {t("today")}
        </button>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
          onClick={() => {
            onChange(null);
            onClose();
          }}
        >
          {t("clear")}
        </button>
      </div>
    </Floating>
  );
}

/**
 * Edits a checklist in place: tick items off, rename them (saved on Enter or leaving the field),
 * remove them and add new ones at the end. Every change is saved right away; typing that is
 * still in progress is saved when the editor closes.
 */
function ChecklistEditor({ prop, value, onChange }: { prop: Property; value: unknown; onChange: (value: unknown) => void }) {
  const t = useTranslations("database.checklist");
  // Local list so quick successive edits build on each other instead of on the last server state.
  const [items, setItems] = useState<ChecklistItem[]>(() => asChecklist(value));
  const latest = useRef(items);
  const [draft, setDraft] = useState("");
  // Tracked outside the DOM: closing by clicking outside unmounts the editor before blur fires.
  const pending = useRef<{ draft: string; renames: Record<string, string> }>({ draft: "", renames: {} });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const update = (fn: (list: ChecklistItem[]) => ChecklistItem[]) => {
    const next = fn(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setItems(next);
    onChange(next.length ? next : null);
  };
  const withPending = (list: ChecklistItem[]) => {
    const { draft: text, renames } = pending.current;
    pending.current = { draft: "", renames: {} };
    let next = list.map((x) => (renames[x.id]?.trim() && renames[x.id].trim() !== x.text ? { ...x, text: renames[x.id].trim() } : x));
    if (next.every((x, i) => x === list[i])) next = list;
    return text.trim() ? [...next, { id: crypto.randomUUID(), text: text.trim(), checked: false }] : next;
  };
  const flush = () => update(withPending);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  const add = () => {
    flush();
    setDraft("");
  };
  const progress = checklistProgress(items);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-subtle px-2 py-1.5">
        <span className="truncate text-xs font-medium text-fg-muted">{prop.name}</span>
        {progress && (
          <span className="text-xs text-fg-muted tabular-nums">{t("progress", progress)}</span>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto p-1">
        {!items.length && <div className="px-2 py-1.5 text-xs text-fg-faint">{t("empty")}</div>}
        {items.map((item, i) => (
          <div key={item.id} className="group flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-bg-hover">
            <button
              type="button"
              role="checkbox"
              aria-checked={item.checked}
              aria-label={t("toggle", { text: item.text })}
              onClick={() =>
                update((list) => withPending(list).map((x) => (x.id === item.id ? { ...x, checked: !x.checked } : x)))
              }
              className="inline-flex"
            >
              <CheckboxBox checked={item.checked} />
            </button>
            <input
              defaultValue={item.text}
              aria-label={t("item", { index: i + 1 })}
              onChange={(e) => {
                pending.current.renames[item.id] = e.target.value;
              }}
              onBlur={(e) => {
                // A blank name keeps the old one; remove the item with its button instead.
                if (!e.target.value.trim()) e.target.value = item.text;
                flush();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                  input.current?.focus();
                }
              }}
              className={cn(
                "h-6 min-w-0 flex-1 bg-transparent text-sm outline-none",
                item.checked && "text-fg-muted line-through",
              )}
            />
            <button
              type="button"
              aria-label={t("remove", { text: item.text })}
              onClick={() => update((list) => withPending(list).filter((x) => x.id !== item.id))}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100 pointer-coarse:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-2.5 py-1.5">
        <Plus className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <input
          ref={input}
          value={draft}
          placeholder={t("addItem")}
          aria-label={t("newItem")}
          onChange={(e) => {
            setDraft(e.target.value);
            pending.current.draft = e.target.value;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
    </div>
  );
}

/**
 * Search/select/create options for select, multi-select and status values. Status options are
 * listed under their groups and only picked here; new ones are added in the property menu.
 */
export function OptionPicker({
  prop,
  value,
  onChange,
  onCreateOption,
  onDone,
}: {
  prop: Property;
  value: unknown;
  onChange: (value: unknown) => void;
  onCreateOption: CreateOption;
  onDone: () => void;
}) {
  const t = useTranslations("database.cell");
  const tGroup = useTranslations("database.statusGroups");
  const multi = prop.type === "multi_select";
  const status = prop.type === "status";
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  // Local selection so rapid multi-select toggles don't race the optimistic parent state.
  // Ids of deleted options are dropped: sending them back would make the server reject the edit.
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    (Array.isArray(value) ? (value as string[]) : typeof value === "string" ? [value] : []).filter((id) =>
      optionsOf(prop).some((o) => o.id === id),
    ),
  );
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const options = useMemo(() => (status ? sortStatusOptions(optionsOf(prop)) : optionsOf(prop)), [prop, status]);
  const q = searchFold(query.trim());
  const filtered = useMemo(() => options.filter((o) => searchFold(o.name).includes(q)), [options, q]);
  const exact = options.some((o) => searchFold(o.name) === q);
  const canCreate = !status && q.length > 0 && !exact;
  const items: ({ kind: "option"; option: SelectOption } | { kind: "create" })[] = [
    ...filtered.map((option) => ({ kind: "option" as const, option })),
    ...(canCreate ? [{ kind: "create" as const }] : []),
  ];

  const selected = selectedIds
    .map((id) => options.find((o) => o.id === id))
    .filter((o): o is SelectOption => Boolean(o));

  const setIds = (ids: string[]) => {
    setSelectedIds(ids);
    onChange(multi ? (ids.length ? ids : null) : (ids[0] ?? null));
  };

  const pick = (option: SelectOption) => {
    if (multi) {
      setIds(selectedIds.includes(option.id) ? selectedIds.filter((id) => id !== option.id) : [...selectedIds, option.id]);
      setQuery("");
    } else {
      setIds([option.id]);
      onDone();
    }
  };

  const create = async () => {
    const name = query.trim();
    if (!name || busy) return;
    setBusy(true);
    const option = await onCreateOption(prop.id, name);
    setBusy(false);
    if (!option) return;
    setQuery("");
    if (multi) setIds([...selectedIds.filter((id) => id !== option.id), option.id]);
    else {
      setIds([option.id]);
      onDone();
    }
  };

  /** Whether the i-th item is the first of its status group (status options list under group headings). */
  const groupStartsAt = (i: number) => {
    const item = items[i];
    const before = items[i - 1];
    if (item?.kind !== "option") return false;
    return before?.kind !== "option" || statusGroupOf(before.option) !== statusGroupOf(item.option);
  };

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === "create") void create();
    else pick(item.option);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-bg-subtle px-2 py-1.5">
        {selected.map((o) => (
          <OptionChip
            key={o.id}
            option={o}
            dot={status}
            onRemove={() => setIds(selectedIds.filter((id) => id !== o.id))}
          />
        ))}
        <input
          ref={input}
          value={query}
          placeholder={selected.length ? "" : t(status ? "searchStatus" : "searchOrCreate")}
          aria-label={t("optionInput", { property: prop.name })}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(active);
            } else if (e.key === "Backspace" && !query && selectedIds.length) {
              setIds(selectedIds.slice(0, -1));
            }
          }}
          className="h-6 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {!items.length && (!status || !options.length) && (
          <div className="px-2 py-1.5 text-xs text-fg-faint">{t(status ? "noStatusOptions" : "typeToCreate")}</div>
        )}
        {items.length > 0 && !status && (
          <div className="px-2 pt-1 pb-1.5 text-xs text-fg-muted">
            {multi ? t("selectOptions") : t("selectOption")}
          </div>
        )}
        {items.map((item, i) => (
          <Fragment key={item.kind === "create" ? "__create" : item.option.id}>
            {status && item.kind === "option" && groupStartsAt(i) && (
              <div className="px-2 pt-1.5 pb-1 text-xs text-fg-muted">{tGroup(statusGroupOf(item.option))}</div>
            )}
            <button
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm",
                i === active && "bg-bg-hover",
              )}
            >
              {item.kind === "create" ? (
                <>
                  <Plus className="h-3.5 w-3.5 text-fg-muted" />
                  <span className="text-fg-muted">{t("create")}</span>
                  <OptionChip option={{ id: "new", name: query.trim(), color: "gray" }} />
                </>
              ) : (
                <>
                  <OptionChip option={item.option} dot={status} />
                  <span className="flex-1" />
                  {selectedIds.includes(item.option.id) && <Check className="h-3.5 w-3.5 text-fg-muted" />}
                </>
              )}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** Small labelled icon link used for "Open" affordances. */
export function OpenLink({ href, children }: { href: string; children?: ReactNode }) {
  const t = useTranslations("database.rowMenu");
  return (
    <Link
      href={href}
      className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-bg px-1.5 text-xs text-fg-muted shadow-sm hover:bg-bg-hover hover:text-fg"
      onClick={(e) => e.stopPropagation()}
    >
      <ExternalLink className="h-3 w-3" />
      {children ?? t("open")}
    </Link>
  );
}
