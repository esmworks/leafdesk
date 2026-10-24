"use client";

import { ArrowDown, ArrowLeft, ArrowUp, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { cn, menuFieldClass } from "@/components/ui";
import { MAX_RELATION_SHOW, showableType, shownParts, TITLE_FIELD, type RelationOptionsInput } from "@/lib/relation-options";
import { PropertyTypeIcon } from "./property-icons";
import { useRelations } from "./relation-context";
import type { Property } from "./types";

const choiceClass = (on: boolean) =>
  on
    ? "h-7 truncate rounded-md border border-accent bg-bg-active px-1 text-xs text-fg"
    : "h-7 truncate rounded-md border border-border px-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg";

/**
 * A relation's settings (lib/relation-options): whether a row links to one row or any number,
 * whether row pages show the linked rows inline or as a section of their own, and which properties
 * of the related database linked rows show beside their title, in order. Each change is saved
 * right away; the parent applies it to `prop` optimistically.
 */
export function RelationOptionsEditor({
  prop,
  onChange,
  onBack,
}: {
  prop: Property;
  onChange: (input: RelationOptionsInput) => void;
  onBack: () => void;
}) {
  const t = useTranslations("database.relation");
  const tm = useTranslations("database.propertyMenu");
  const tc = useTranslations("common");
  const target = useRelations()?.targets[prop.id];
  const relation = prop.options.relation;
  // Edited here and saved per change, so quick changes build on each other.
  const [parts, setParts] = useState(() => shownParts(relation));
  const [limit, setLimit] = useState<"one" | "any">(relation?.limit === "one" ? "one" : "any");
  const [display, setDisplay] = useState<"section" | "inline">(relation?.display === "section" ? "section" : "inline");
  const parent = relation?.role === "parent";
  const properties = target?.properties ?? [];
  const nameOf = (id: string) => (id === TITLE_FIELD ? t("titlePart") : (properties.find((p) => p.id === id)?.name ?? ""));
  const typeOf = (id: string) => properties.find((p) => p.id === id)?.type;
  const offered = properties.filter((p) => showableType(p.type) && !parts.includes(p.id));
  const shownCount = parts.filter((id) => id !== TITLE_FIELD).length;

  const saveParts = (next: string[]) => {
    setParts(next);
    onChange({ show: next.some((id) => id !== TITLE_FIELD) ? next : null });
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...parts];
    const [part] = next.splice(index, 1);
    next.splice(index + by, 0, part);
    saveParts(next);
  };

  return (
    <div className="w-72">
      <div className="flex items-center gap-1 px-1 pt-1">
        <button
          type="button"
          aria-label={tm("back")}
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
        </button>
        <span className="truncate px-1 text-sm font-medium">{t("options")}</span>
      </div>
      <div className="space-y-3 p-2">
        {!parent && (
          <div>
            <span className="mb-1 block text-xs text-fg-muted">{t("limit")}</span>
            <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label={t("limit")}>
              {(["any", "one"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={limit === value}
                  onClick={() => {
                    if (limit === value) return;
                    setLimit(value);
                    onChange({ limit: value });
                  }}
                  className={choiceClass(limit === value)}
                >
                  {t(value === "one" ? "limitOne" : "limitAny")}
                </button>
              ))}
            </div>
            {limit === "one" && <p className="mt-1 text-xs text-fg-faint">{t("limitHint")}</p>}
          </div>
        )}
        <div>
          <span className="mb-1 block text-xs text-fg-muted">{t("rowPage")}</span>
          <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label={t("rowPage")}>
            {(["inline", "section"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={display === value}
                onClick={() => {
                  if (display === value) return;
                  setDisplay(value);
                  onChange({ display: value });
                }}
                className={choiceClass(display === value)}
              >
                {t(value === "section" ? "displaySection" : "displayInline")}
              </button>
            ))}
          </div>
          {display === "section" && <p className="mt-1 text-xs text-fg-faint">{t("sectionHint")}</p>}
        </div>
        <div>
          <span className="mb-1 block text-xs text-fg-muted">{t("shows")}</span>
          <ul className="space-y-0.5" aria-label={t("shows")}>
            {parts.map((id, i) => (
              <li key={id} className="group flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-bg-hover">
                <PropertyTypeIcon type={id === TITLE_FIELD ? "title" : (typeOf(id) ?? "text")} className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                <span className={cn("min-w-0 flex-1 truncate", id === TITLE_FIELD && "text-fg-muted")}>{nameOf(id) || tc("untitled")}</span>
                <OrderButton label={t("moveUp", { name: nameOf(id) })} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="h-3 w-3" />
                </OrderButton>
                <OrderButton label={t("moveDown", { name: nameOf(id) })} disabled={i === parts.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown className="h-3 w-3" />
                </OrderButton>
                {id !== TITLE_FIELD && (
                  <OrderButton label={t("hidePart", { name: nameOf(id) })} onClick={() => saveParts(parts.filter((p) => p !== id))}>
                    <X className="h-3 w-3" />
                  </OrderButton>
                )}
              </li>
            ))}
          </ul>
          {target?.database && shownCount < MAX_RELATION_SHOW && offered.length > 0 && (
            <select
              className={cn(menuFieldClass, "mt-1")}
              aria-label={t("addPart")}
              value=""
              onChange={(e) => e.target.value && saveParts([...parts, e.target.value])}
            >
              <option value="">{t("addPart")}</option>
              {offered.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <p className="mt-1 text-xs text-fg-faint">{t("showsHint")}</p>
        </div>
      </div>
    </div>
  );
}

function OrderButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-active hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
