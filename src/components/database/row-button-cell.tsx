"use client";

import { Check, Loader2, MousePointerClick } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { pressRowButtonAction } from "@/app/actions/buttons";
import { cn } from "@/components/ui";
import { showToast } from "@/components/toast";
import { rowButtonColor, rowButtonLabel } from "@/lib/row-buttons";
import type { Property } from "./types";

/** How long a button shows its tick after a click started its automations. */
const DONE_MS = 1_500;

/**
 * A button property's button on one row (lib/row-buttons.ts): a click starts the automations made
 * for it on that row. A click never opens the cell or the card under it. Without a row (a form's
 * preview) or for someone who may not change the row, it shows disabled.
 */
export function RowButtonCell({
  prop,
  rowId,
  readOnly,
  variant,
}: {
  prop: Property;
  rowId?: string;
  readOnly?: boolean;
  variant: "table" | "panel" | "list" | "card";
}) {
  const t = useTranslations("database.rowButton");
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const label = rowButtonLabel(prop);
  const color = rowButtonColor(prop);

  useEffect(() => {
    if (state !== "done") return;
    const timer = setTimeout(() => setState("idle"), DONE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const press = async () => {
    if (!rowId || state === "running") return;
    setState("running");
    try {
      const res = await pressRowButtonAction(rowId, prop.id);
      if (!res.ok) {
        setState("idle");
        showToast({ message: res.error });
        return;
      }
      setState("done");
    } catch {
      setState("idle");
      showToast({ message: t("failed.error") });
    }
  };

  return (
    <div
      className={cn(
        "flex min-w-0 items-center",
        variant === "table" && "min-h-[33px] w-full px-2 py-1",
        variant === "panel" && "min-h-[30px] w-full px-2 py-1",
      )}
    >
      <button
        type="button"
        disabled={readOnly || !rowId || state === "running"}
        data-cell-edit={readOnly ? undefined : ""}
        aria-busy={state === "running" || undefined}
        title={state === "done" ? t("started") : undefined}
        onClick={(e) => {
          e.stopPropagation();
          void press();
        }}
        className={cn(
          "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border font-medium transition-colors",
          variant === "list" || variant === "card" ? "h-5 px-1.5 text-xs" : "h-6 px-2 text-xs",
          "focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-70",
          // Colored like an option chip (opt-*), a shade deeper on hover, as the page's buttons are.
          color
            ? `opt-${color} border-transparent enabled:hover:brightness-95 dark:enabled:hover:brightness-110 high-contrast:border-(--opt-fg)`
            : "border-border bg-bg text-fg enabled:hover:bg-bg-hover",
        )}
      >
        {state === "running" ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        ) : state === "done" ? (
          <Check className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <MousePointerClick className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span className="truncate">{label}</span>
      </button>
      {state === "done" && (
        <span role="status" className="sr-only">
          {t("started")}
        </span>
      )}
    </div>
  );
}
