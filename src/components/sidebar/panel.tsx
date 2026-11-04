"use client";

import { cn } from "@/components/ui";

/**
 * What every panel of the sidebar is drawn from (docs/design.md "Sidebar panel"): one row, one
 * heading, one meta text, one empty line. A panel composes these and adds only what it alone has
 * (the pages' tree, the chat's selection, an agent's second line).
 */

/** A row: a 16 px icon, the item, meta at the end. 28 px tall, lit on hover. */
export const panelRow = "flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-bg-hover";
/** The row of the place that is open. */
export const panelRowActive = "bg-bg-active font-medium text-fg hover:bg-bg-active";
/** A row's icon. */
export const panelIcon = "h-4 w-4 shrink-0 text-fg-icon";
/** A block of rows after the first: the room between blocks. */
export const panelSection = "mt-3";
/**
 * A block's heading, in the rows' column. 28 px on phones too: there the drawer grows only what is
 * tapped (sidebar.tsx grows every `h-7`), so a plain heading's height is written another way.
 */
export const panelHeading = "flex h-[1.75rem] items-center px-2 text-xs font-medium text-fg-faint";
/** A count or a time at a row's end. */
export const panelMeta = "text-xs tabular-nums text-fg-faint";
/** A row that shows more of a block (all places, the whole list): quieter than the rows above it. */
export const panelMore = "mt-px flex h-7 w-full items-center rounded-md px-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg";

/** One line where a block has nothing to list. */
export function PanelEmpty({ children, className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p {...rest} className={cn("px-2 py-1 text-xs text-fg-faint", className)}>
      {children}
    </p>
  );
}
