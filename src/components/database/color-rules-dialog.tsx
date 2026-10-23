"use client";

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { Button, cn, Dialog } from "@/components/ui";
import type { ColorRule, ViewConfig } from "@/db/schema/app";
import { isColorRuleColor, MAX_COLOR_RULES, newColorRuleId } from "@/lib/color-rules";
import { SELECT_COLORS } from "@/lib/properties";
import type { Property, View } from "./types";
import { columnsOf, defaultRule, FilterEditor, NativeSelect } from "./view-bar";

/** The target value of "the whole row" in the target picker (property ids are never empty). */
const ROW = "";

/**
 * A view's color rules (see lib/color-rules): each a color, what it colors (the row or one
 * property's value) and the filters a row must match. The first matching rule per target wins,
 * so rules can be moved up and down. Every change is saved as it is made.
 */
export function ColorRulesDialog({
  view,
  properties,
  onConfig,
  onClose,
}: {
  view: View;
  properties: Property[];
  onConfig: (config: ViewConfig) => void;
  onClose: () => void;
}) {
  const t = useTranslations("database.colorRules");
  const tc = useTranslations("common");
  const tColor = useTranslations("database.colors");
  const tDb = useTranslations("database");
  const columns = columnsOf(properties, tDb("nameColumn"));
  // The dialog's copy is what it edits: filter editors save a moment after typing, and each save
  // starts from the latest rules rather than from the view as it was when they rendered.
  const [rules, setRules] = useState<ColorRule[]>(() => view.config.colorRules ?? []);
  const latest = useRef({ rules, config: view.config });
  latest.current.config = view.config;
  const save = (next: ColorRule[]) => {
    latest.current.rules = next;
    setRules(next);
    onConfig({ ...latest.current.config, colorRules: next.length ? next : undefined });
  };
  const update = (id: string, patch: Partial<ColorRule>) =>
    save(latest.current.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...latest.current.rules];
    const [rule] = next.splice(index, 1);
    next.splice(index + by, 0, rule);
    save(next);
  };
  const add = () => {
    const current = latest.current.rules;
    const color = SELECT_COLORS[(SELECT_COLORS.indexOf("red") + current.length) % SELECT_COLORS.length];
    save([...current, { id: newColorRuleId(current), color, filters: columns.length ? [defaultRule(columns[0])] : [] }]);
  };
  // A menu open over the dialog (a filter's values) closes first, on its own.
  const close = useCallback(() => {
    if (!document.querySelector("[data-floating]")) onClose();
  }, [onClose]);
  const targets = [{ value: ROW, label: t("wholeRow") }, ...columns.map((c) => ({ value: c.id, label: c.name }))];

  return (
    <Dialog open onClose={close} className="max-w-2xl">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="mt-0.5 text-sm text-fg-muted">{t("description")}</p>
        </div>
        <button
          type="button"
          aria-label={tc("close")}
          title={tc("close")}
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[65vh] space-y-3 overflow-y-auto px-5 py-4">
        {!rules.length && <p className="py-4 text-center text-sm text-fg-muted">{t("empty")}</p>}
        {rules.map((rule, i) => (
          <section key={rule.id} aria-label={t("ruleLabel", { color: isColorRuleColor(rule.color) ? tColor(rule.color) : rule.color })} className="rounded-lg border border-border">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
              <div role="radiogroup" aria-label={t("color")} className="flex gap-1">
                {SELECT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={color === rule.color}
                    aria-label={tColor(color)}
                    title={tColor(color)}
                    onClick={() => color !== rule.color && update(rule.id, { color })}
                    className={cn(
                      `opt-${color} h-5 w-5 rounded`,
                      color === rule.color ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "hover:ring-1 hover:ring-border",
                    )}
                  />
                ))}
              </div>
              <label className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-fg-muted">
                <span className="shrink-0">{t("colors")}</span>
                <NativeSelect
                  label={t("target")}
                  value={rule.propertyId ?? ROW}
                  onChange={(target) => update(rule.id, { propertyId: target === ROW ? undefined : target })}
                  options={targets}
                  className="min-w-0 flex-1 basis-32 text-fg"
                />
              </label>
              <div className="ms-auto flex items-center">
                <RuleButton label={t("moveUp")} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </RuleButton>
                <RuleButton label={t("moveDown")} disabled={i === rules.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </RuleButton>
                <RuleButton label={t("delete")} danger onClick={() => save(latest.current.rules.filter((r) => r.id !== rule.id))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </RuleButton>
              </div>
            </div>
            <div className="overflow-x-auto">
              <FilterEditor
                columns={columns}
                filters={rule.filters}
                combinator={rule.filterCombinator ?? "and"}
                onChange={(filters, combinator) => update(rule.id, { filters, filterCombinator: combinator === "or" ? "or" : undefined })}
              />
            </div>
          </section>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
        <p className="text-xs text-fg-muted">{t("firstMatchWins")}</p>
        <Button size="sm" onClick={add} disabled={rules.length >= MAX_COLOR_RULES || !columns.length}>
          <Plus className="h-3.5 w-3.5" />
          {t("add")}
        </Button>
      </div>
    </Dialog>
  );
}

function RuleButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-40",
        danger ? "hover:text-danger" : "hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
