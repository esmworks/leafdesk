"use client";

import { ArrowLeft, Check, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { compileFormulas, formulaForEditing, formulaForStorage, relatedSchemasFrom } from "@/lib/derived";
import {
  FORMULA_ERROR_CODES,
  FORMULA_FUNCTIONS,
  MAX_RELATED_ROWS,
  STYLE_COLORS,
  type FormulaError,
  type FormulaErrorCode,
  type FormulaFunctionGroup,
  type FormulaType,
} from "@/lib/formula";
import { quote } from "@/lib/formula/lexer";
import { PropertyTypeIcon } from "./property-icons";
import { useRelations } from "./relation-context";
import { useSchema } from "./schema-context";
import type { Property } from "./types";

const GROUPS: FormulaFunctionGroup[] = ["logic", "text", "number", "date", "list", "style", "conversion"];
const TYPE_NAMES: FormulaType[] = ["number", "text", "checkbox", "date", "list", "numbers", "rows", "row"];
/** Params that hold type names ("text|list"), translated before they go into a message. */
const TYPE_PARAMS: Partial<Record<FormulaErrorCode, string[]>> = {
  argumentType: ["expected", "actual"],
  operatorType: ["left", "right"],
  unaryType: ["type"],
  branchTypes: ["left", "right"],
};

/** Translates a formula error (the English message stays for MCP; see lib/formula/types). */
export function useFormulaErrorMessage() {
  const t = useTranslations("database.formula");
  const typeName = (raw: string) =>
    raw
      .split("|")
      .map((type) => (TYPE_NAMES.includes(type as FormulaType) ? t(`types.${type as FormulaType}`) : type))
      .join(` ${t("or")} `);
  return (error: FormulaError) => {
    const params: Record<string, string | number> = { ...error.params };
    for (const key of TYPE_PARAMS[error.code] ?? []) if (typeof params[key] === "string") params[key] = typeName(params[key] as string);
    if (error.code === "argumentCount") {
      const min = Number(params.min);
      const max = params.max === "" ? null : Number(params.max);
      const variant = max === null ? "atLeast" : min === max ? "exact" : "range";
      return t(`errors.argumentCount.${variant}`, { ...params, min, max: max ?? 0 });
    }
    return FORMULA_ERROR_CODES.includes(error.code) ? t(`errors.${error.code}`, params) : error.message;
  };
}

/**
 * Writes and checks a formula. The expression is edited with property names; it is checked on
 * every keystroke against the database's properties and saved with ids (see lib/derived). Invalid
 * formulas can't be saved; the reason shows under the field.
 */
export function FormulaEditor({
  prop,
  name,
  onSave,
  onBack,
}: {
  /** The formula property being edited; null while adding one. */
  prop: Property | null;
  /** Its name (a new property's name, for self-references). */
  name: string;
  onSave: (expression: string) => void;
  onBack?: () => void;
}) {
  const t = useTranslations("database.formula");
  const tName = useTranslations("database");
  const properties = useSchema();
  const targets = useRelations()?.targets;
  const titleName = tName("nameColumn");
  const errorMessage = useFormulaErrorMessage();
  // Properties of related databases (as the viewer may know them), which prop(current, "…") reads.
  const related = useMemo(() => relatedSchemasFrom(targets), [targets]);
  const relatedProps = useMemo(() => Object.values(targets ?? {}).flatMap((target) => target.properties), [targets]);
  const [text, setText] = useState(() =>
    formulaForEditing(prop?.options.formula?.expression ?? "", properties, titleName, relatedProps),
  );
  const area = useRef<HTMLTextAreaElement>(null);
  const selfId = prop?.id ?? "\u0000new";
  // A property called like the Name column wins over it; the title is then written prop("title").
  const titleKey = properties.some((p) => p.name.trim().toLowerCase() === titleName.trim().toLowerCase()) ? "title" : titleName;
  const others = useMemo(() => properties.filter((p) => p.id !== selfId), [properties, selfId]);

  const stored = formulaForStorage(text, [...others, { id: selfId, name }], [titleName], related);
  const check = useMemo(() => {
    const self = { id: selfId, name, type: "formula" as const, options: { formula: { expression: stored } } };
    return compileFormulas([...others, self], related).get(selfId)!;
  }, [others, selfId, name, stored, related]);

  const insert = (snippet: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const save = () => {
    if (check.error) return;
    onSave(stored);
  };

  return (
    <div className="w-96 max-w-[calc(100vw-2rem)]">
      <div className="flex items-center gap-1 px-1 pt-1">
        {onBack && (
          <button
            type="button"
            aria-label={t("back")}
            onClick={onBack}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="truncate px-1 text-sm font-medium">{t("titleFor", { name })}</span>
      </div>
      <div className="p-2">
        <textarea
          ref={area}
          autoFocus
          rows={3}
          value={text}
          spellCheck={false}
          aria-label={t("expression")}
          placeholder={t("placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          className={cn(
            "block w-full resize-y rounded-md border bg-bg px-2 py-1.5 font-mono text-xs leading-5 outline-none placeholder:text-fg-faint",
            check.error ? "border-danger" : "border-border focus:border-accent",
          )}
        />
        <div className="mt-1.5 flex min-h-5 items-start gap-1.5 text-xs" aria-live="polite">
          {check.error ? (
            <>
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <span className="text-danger">{errorMessage(check.error)}</span>
            </>
          ) : text.trim() ? (
            <>
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-muted" />
              <span className="text-fg-muted">{t("result", { type: t(`types.${check.type}`) })}</span>
            </>
          ) : (
            <span className="text-fg-faint">{t("empty")}</span>
          )}
        </div>
      </div>
      <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto border-t border-border px-2 py-1.5">
        <div className="min-w-0">
          <div className="px-1 pb-1 text-xs text-fg-muted">{t("properties")}</div>
          <ReferenceButton label={titleName} onClick={() => insert(`prop(${quote(titleKey)})`)} icon="title" />
          {others.map((p) => (
            <div key={p.id}>
              <ReferenceButton label={p.name} icon={p.type} onClick={() => insert(`prop(${quote(p.name)})`)} />
              {/* A relation's rows: their properties, read as prop(current, "…") in map(), filter()… */}
              {p.type === "relation" &&
                (targets?.[p.id]?.properties ?? []).map((r) => (
                  <ReferenceButton key={r.id} label={r.name} icon={r.type} nested onClick={() => insert(`prop(current, ${quote(r.name)})`)} />
                ))}
            </div>
          ))}
          {others.some((p) => p.type === "relation") && (
            <p className="px-1 pt-1 text-[11px] leading-4 text-fg-faint">{t("relatedHint", { max: MAX_RELATED_ROWS })}</p>
          )}
        </div>
        <div className="min-w-0">
          <div className="px-1 pb-1 text-xs text-fg-muted">{t("functions")}</div>
          {GROUPS.map((group) => (
            <div key={group} className="pb-1">
              <div className="px-1 pt-0.5 text-[11px] text-fg-faint">{t(`groups.${group}`)}</div>
              {group === "style" && (
                <p className="px-1 pb-0.5 text-[11px] leading-4 text-fg-faint">{t("styleHint", { colors: STYLE_COLORS.join(", ") })}</p>
              )}
              {FORMULA_FUNCTIONS.filter((f) => f.group === group).map((f) => (
                <button
                  key={f.name}
                  type="button"
                  title={f.signature}
                  aria-label={t("insert", { name: f.signature })}
                  onClick={() => insert(`${f.name}(`)}
                  className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-xs text-fg hover:bg-bg-hover"
                >
                  {f.signature}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-2">
        <Button size="sm" variant="primary" disabled={Boolean(check.error)} onClick={save}>
          {prop ? t("save") : t("create")}
        </Button>
      </div>
    </div>
  );
}

function ReferenceButton({
  label,
  icon,
  onClick,
  nested,
}: {
  label: string;
  icon: Property["type"] | "title";
  onClick: () => void;
  /** A property of a relation's rows, listed under the relation. */
  nested?: boolean;
}) {
  const t = useTranslations("database.formula");
  return (
    <button
      type="button"
      title={label}
      aria-label={t("insert", { name: label })}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-bg-hover",
        nested && "pl-5 text-fg-muted",
      )}
    >
      <PropertyTypeIcon type={icon} className="h-3 w-3 shrink-0 text-fg-muted" />
      <span className="truncate">{label}</span>
    </button>
  );
}
