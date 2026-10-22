"use client";

import { useEffect, useRef, useState } from "react";
import { propertyDescription } from "@/lib/property-description";
import { Floating } from "./floating";
import type { Property } from "./types";

/** How long the pointer rests on a property's name before its description shows. */
const HINT_DELAY_MS = 450;

/**
 * A property's description (see lib/property-description) as a hint by its name: it shows while
 * the pointer rests on `anchor` (a column header, a row page's label) or the keyboard is on it, and
 * not while `suppressed` (the property's menu is open). Nothing without a description.
 */
export function usePropertyHint(prop: Pick<Property, "name" | "options"> | null, anchor: HTMLElement | null, suppressed = false) {
  const description = prop ? propertyDescription(prop) : "";
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!anchor || !description) return;
    const show = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOpen(true), HINT_DELAY_MS);
    };
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      setOpen(false);
    };
    anchor.addEventListener("pointerenter", show);
    anchor.addEventListener("pointerleave", hide);
    anchor.addEventListener("focusin", show);
    anchor.addEventListener("focusout", hide);
    anchor.addEventListener("pointerdown", hide);
    return () => {
      hide();
      anchor.removeEventListener("pointerenter", show);
      anchor.removeEventListener("pointerleave", hide);
      anchor.removeEventListener("focusin", show);
      anchor.removeEventListener("focusout", hide);
      anchor.removeEventListener("pointerdown", hide);
    };
  }, [anchor, description]);

  const hint =
    description && prop ? (
      <Floating open={open && !suppressed} anchor={anchor} onClose={() => setOpen(false)} className="pointer-events-none w-72 px-3 py-2">
        <div role="tooltip" className="text-xs">
          <div className="truncate font-medium text-fg">{prop.name}</div>
          <p className="mt-0.5 whitespace-pre-wrap text-fg-muted">{description}</p>
        </div>
      </Floating>
    ) : null;
  return { hint, description };
}
