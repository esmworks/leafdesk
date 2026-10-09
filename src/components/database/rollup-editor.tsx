"use client";

import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, menuFieldClass } from "@/components/ui";
import { ROLLUP_DISPLAYS, rollupFunctions, type RollupDisplay, type RollupFn } from "@/lib/aggregate";
import { rollupFormat, TITLE_FIELD, valueType } from "@/lib/derived";
import { useRelations } from "./relation-context";
import { useSchema } from "./schema-context";
import type { Property, RollupInput } from "./types";

/**
 * Sets up a rollup: which relation, which property of the related database, and what to
 * calculate (the functions a table footer offers for that property, or listing the values). A
 * percentage can show as a number, a bar or a ring.
 */
export function RollupEditor({
  prop,
  name,
  onSave,
  onBack,
}: {
  /** The rollup property being edited; null while adding one. */
  prop: Property | null;
  name: string;
  onSave: (rollup: RollupInput) => void;
  onBack?: () => void;
}) {
  const t = useTranslations("database.rollup");
  const tc = useTranslations("database.calculate");
  const tDb = useTranslations("database");
  const properties = useSchema();
  const targets = useRelations()?.targets ?? {};
  const relations = properties.filter((p) => p.type === "relation");
  const current = prop?.options.rollup;
  const [relationId, setRelationId] = useState(current?.relationPropertyId ?? relations[0]?.id ?? "");
  const [targetId, setTargetId] = useState(current?.targetPropertyId ?? TITLE_FIELD);
  const [fn, setFn] = useState<RollupFn>(current?.function ?? "show_original");
  const [display, setDisplay] = useState<RollupDisplay>(current?.display ?? "number");

  const target = targets[relationId];
  const targetProps = (target?.properties ?? []).filter((p) => p.id !== prop?.id);
  const targetProp = targetProps.find((p) => p.id === targetId);
  const targetType = targetId === TITLE_FIELD ? TITLE_FIELD : targetProp ? valueType(targetProp) : null;
  const functions = targetType ? rollupFunctions(targetType) : [];
  const chosenFn = functions.includes(fn) ? fn : "show_original";
  const percent = rollupFormat(chosenFn) === "percent";
  const ready = Boolean(relationId && target?.database && targetType);

  const header = (
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
  );

  if (!relations.length) {
    return (
      <div className="w-72">
        {header}
        <p className="px-3 py-2 text-xs text-fg-muted">{t("noRelations")}</p>
      </div>
    );
  }

  return (
    <div className="w-72">
      {header}
      <div className="space-y-2 p-2">
        <label className="block">
          <span className="mb-1 block text-xs text-fg-muted">{t("relation")}</span>
          <select
            className={menuFieldClass}
            value={relationId}
            onChange={(e) => {
              setRelationId(e.target.value);
              setTargetId(TITLE_FIELD);
            }}
          >
            {relations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {target && !target.database ? (
          <p className="text-xs text-fg-muted">{t("hiddenDatabase")}</p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">{t("property")}</span>
              <select
                className={menuFieldClass}
                value={targetProp || targetId === TITLE_FIELD ? targetId : ""}
                onChange={(e) => setTargetId(e.target.value)}
              >
                {!targetProp && targetId !== TITLE_FIELD && <option value="">{t("choose")}</option>}
                <option value={TITLE_FIELD}>{tDb("nameColumn")}</option>
                {targetProps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">{t("function")}</span>
              <select className={menuFieldClass} value={chosenFn} onChange={(e) => setFn(e.target.value as RollupFn)} disabled={!targetType}>
                {functions.map((f) => (
                  <option key={f} value={f}>
                    {f === "show_original" ? t("showOriginal") : tc(`menu.${f}`)}
                  </option>
                ))}
              </select>
            </label>
            {percent && (
              <div>
                <span className="mb-1 block text-xs text-fg-muted">{t("display")}</span>
                <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label={t("display")}>
                  {ROLLUP_DISPLAYS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      role="radio"
                      aria-checked={display === d}
                      onClick={() => setDisplay(d)}
                      className={
                        display === d
                          ? "h-7 rounded-md border border-accent bg-bg-active text-xs text-fg"
                          : "h-7 rounded-md border border-border text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
                      }
                    >
                      {t(`displays.${d}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex justify-end border-t border-border p-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!ready}
          onClick={() =>
            onSave({
              relationPropertyId: relationId,
              targetPropertyId: targetId,
              function: chosenFn,
              ...(percent ? { display } : {}),
            })
          }
        >
          {prop ? t("save") : t("create")}
        </Button>
      </div>
    </div>
  );
}
