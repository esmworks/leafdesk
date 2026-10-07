"use client";

import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button, cn, IconButton } from "@/components/ui";
import { useReorderDrag } from "@/components/use-reorder-drag";
import { moveBeside } from "@/lib/reorder";
import type { SidebarSection } from "@/lib/sidebar-sections";

/**
 * The sidebar's sections while the person arranges them ("Customize sidebar"): drag
 * (or the arrows) to reorder, the eye to hide or show. Changes apply at once; Done goes back.
 */
export function CustomizeSections({
  sections,
  hidden,
  onChange,
  onDone,
}: {
  /** Every section they can have, in the current order. */
  sections: { key: SidebarSection; label: string }[];
  hidden: Set<SidebarSection>;
  onChange: (order: SidebarSection[], hidden: SidebarSection[]) => void;
  onDone: () => void;
}) {
  const t = useTranslations("sidebar.customize");
  const keys = sections.map((s) => s.key);
  const setOrder = (order: SidebarSection[]) => onChange(order, [...hidden]);
  const move = (from: number, to: number) => {
    const order = [...keys];
    order.splice(to, 0, ...order.splice(from, 1));
    setOrder(order);
  };
  const drag = useReorderDrag("y", (moved, target, side) =>
    setOrder(moveBeside(keys, moved as SidebarSection, target as SidebarSection, side)),
  );
  const toggle = (key: SidebarSection) =>
    onChange(keys, hidden.has(key) ? [...hidden].filter((k) => k !== key) : [...hidden, key]);

  return (
    <div className="px-1 pt-1">
      <p className="px-1 pb-1.5 text-xs text-fg-muted">{t("heading")}</p>
      <ul className="space-y-px">
        {sections.map(({ key, label }, i) => {
          const handlers = drag.handlers(key);
          const isHidden = hidden.has(key);
          return (
            <li
              key={key}
              data-sidebar-section={key}
              draggable
              onDragStart={handlers.onDragStart}
              onDragOver={handlers.onDragOver}
              onDrop={handlers.onDrop}
              onDragEnd={handlers.onDragEnd}
              className={cn("group/row relative flex h-8 items-center gap-1 rounded-md pr-1 hover:bg-bg-hover", handlers.dragging && "opacity-50")}
            >
              {handlers.dropSide && (
                <span
                  aria-hidden
                  className={cn("pointer-events-none absolute inset-x-1 h-0.5 rounded bg-accent", handlers.dropSide === "before" ? "-top-px" : "-bottom-px")}
                />
              )}
              <GripVertical aria-hidden className="ml-1 h-3.5 w-3.5 shrink-0 cursor-grab text-fg-faint" />
              <span className={cn("min-w-0 flex-1 truncate pl-1", isHidden && "text-fg-faint")}>{label}</span>
              <span className="flex items-center opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                <IconButton className="disabled:opacity-30 disabled:hover:bg-transparent" label={t("moveUp", { section: label })} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton className="disabled:opacity-30 disabled:hover:bg-transparent" label={t("moveDown", { section: label })} disabled={i === sections.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </IconButton>
              </span>
              <IconButton className="disabled:opacity-30 disabled:hover:bg-transparent" label={isHidden ? t("show", { section: label }) : t("hide", { section: label })} onClick={() => toggle(key)}>
                {isHidden ? <EyeOff className="h-3.5 w-3.5 text-fg-faint" /> : <Eye className="h-3.5 w-3.5" />}
              </IconButton>
            </li>
          );
        })}
      </ul>
      <div className="px-1 pt-3">
        <Button size="sm" variant="primary" onClick={onDone} className="w-full justify-center">
          {t("done")}
        </Button>
      </div>
    </div>
  );
}
