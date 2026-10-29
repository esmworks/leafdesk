"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button, cn, Input, MenuSeparator } from "@/components/ui";
import { cleanRowButtonOptions, MAX_ROW_BUTTON_LABEL, ROW_BUTTON_COLORS, rowButtonColor, type RowButtonColor, type RowButtonOptions } from "@/lib/row-buttons";
import { SubmenuHeader } from "./property-menu";
import type { Property } from "./types";

// Loaded when a button property's "Label and color" opens, not with every property menu.

/** A button property's label (its name when empty) and color, shown on every row (lib/row-buttons). */
export function RowButtonEditor({ prop, onBack, onSave }: { prop: Property; onBack: () => void; onSave: (options: RowButtonOptions) => void }) {
  const t = useTranslations("database.propertyMenu");
  const tc = useTranslations("common");
  const tColor = useTranslations("database.colors");
  const [label, setLabel] = useState(prop.options.button?.label ?? "");
  const [color, setColor] = useState<RowButtonColor | null>(rowButtonColor(prop));
  const labelId = useId();
  const save = () => onSave(cleanRowButtonOptions({ label, color }));
  return (
    <div className="w-64">
      <SubmenuHeader title={t("buttonLook")} onBack={onBack} />
      <MenuSeparator />
      <div className="space-y-3 p-2">
        <Input
          value={label}
          autoFocus
          placeholder={prop.name}
          aria-label={t("buttonLabel")}
          maxLength={MAX_ROW_BUTTON_LABEL}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          className="h-7"
        />
        <div>
          <span id={labelId} className="mb-1 block text-xs text-fg-muted">
            {t("buttonColor")}
          </span>
          <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
            {[null, ...ROW_BUTTON_COLORS].map((option) => {
              const name = option ? tColor(option) : t("buttonColorPlain");
              return (
                <button
                  key={option ?? "plain"}
                  type="button"
                  role="radio"
                  aria-checked={option === color}
                  aria-label={name}
                  title={name}
                  onClick={() => setColor(option)}
                  className={cn(
                    "h-6 w-6 rounded-md border",
                    option ? `opt-${option} border-transparent high-contrast:border-(--opt-fg)` : "border-border bg-bg",
                    option === color ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "hover:ring-1 hover:ring-border",
                  )}
                />
              );
            })}
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={save}>
            {tc("save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
