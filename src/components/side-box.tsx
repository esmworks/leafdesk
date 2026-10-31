"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { cn } from "@/components/ui";

/**
 * A box that folds away to its title (and how many things it holds). A long list scrolls inside it,
 * and in a column the window's height holds (`flex-col`), the boxes give up room to fit it.
 */
export function SideBox({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-border bg-bg">
      <h2 className="shrink-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-start text-sm font-medium hover:bg-bg-hover"
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {count !== undefined && <span className="text-xs font-normal text-fg-muted tabular-nums">{count}</span>}
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-fg-muted transition-transform", !open && "-rotate-90 rtl:rotate-90")} aria-hidden />
        </button>
      </h2>
      {/* The list fades out at its edges instead of cutting a line in half; the padding is as deep
          as the fade, so at either end only the empty padding fades. */}
      {open && (
        <ul
          id={id}
          className="max-h-80 min-h-0 overflow-y-auto overscroll-contain border-t border-border pt-2 pb-5 [mask-image:linear-gradient(to_bottom,transparent,black_0.5rem,black_calc(100%-1.25rem),transparent)]"
        >
          {children}
        </ul>
      )}
    </section>
  );
}

/** One line of a box: an icon, its text and what's beside it; a link, a button or plain. */
export function SideItem({
  icon,
  children,
  meta,
  href,
  external,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  meta?: React.ReactNode;
  href?: string;
  /** `href` is another site's: it opens in a new tab. */
  external?: boolean;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center text-fg-muted">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {meta && <span className="shrink-0 text-xs text-fg-muted">{meta}</span>}
    </>
  );
  const row = "flex w-full items-start gap-2 px-3 py-1.5 text-start text-sm";
  return (
    <li>
      {href && external ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cn(row, "hover:bg-bg-hover")}>
          {inner}
        </a>
      ) : href ? (
        <Link href={href} className={cn(row, "hover:bg-bg-hover")}>
          {inner}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={cn(row, "hover:bg-bg-hover")}>
          {inner}
        </button>
      ) : (
        <div className={row}>{inner}</div>
      )}
    </li>
  );
}
