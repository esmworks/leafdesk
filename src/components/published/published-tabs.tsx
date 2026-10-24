"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { isRtl } from "@/components/direction";
import { cn, PageIcon } from "@/components/ui";

/**
 * A published dashboard laid out as tabs (lib/dashboard): every tab's view comes drawn from the
 * server, already only the databases published with the page; the visitor picks which one shows.
 */
export function PublishedTabs({
  label,
  tabs,
  children,
}: {
  label: string;
  tabs: { id: string; name: string; icon: string | null }[];
  /** One panel per tab, in order. */
  children: ReactNode[];
}) {
  const [active, setActive] = useState(0);
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const back = isRtl(e.currentTarget) ? "ArrowRight" : "ArrowLeft";
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : e.key === back ? active - 1 : e.key === "ArrowLeft" || e.key === "ArrowRight" ? active + 1 : null;
    if (next === null) return;
    e.preventDefault();
    const to = (next + tabs.length) % tabs.length;
    setActive(to);
    refs.current[to]?.focus();
  };
  return (
    <div className="min-w-0">
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex min-w-0 items-end gap-0.5 overflow-x-auto border-b border-border">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => void (refs.current[i] = el)}
            type="button"
            role="tab"
            id={`${base}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${base}-panel-${i}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={cn(
              "-mb-px flex max-w-56 min-w-0 shrink-0 items-center gap-1.5 rounded-t border-b-2 px-2.5 py-1.5 text-sm hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent",
              i === active ? "border-accent font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            <PageIcon icon={tab.icon} kind="database" className="text-sm" />
            <span className="truncate">{tab.name}</span>
          </button>
        ))}
      </div>
      {children.map((panel, i) => (
        <div key={tabs[i]?.id ?? i} role="tabpanel" id={`${base}-panel-${i}`} aria-labelledby={`${base}-tab-${i}`} hidden={i !== active} className="min-w-0 pt-2">
          {panel}
        </div>
      ))}
    </div>
  );
}
