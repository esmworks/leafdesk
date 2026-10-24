"use client";

import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconGrid } from "@/components/page/icon-picker";
import { MenuItem } from "@/components/ui";
import { Floating, useFloating } from "./floating";
import { PropertyTypeIcon, ViewIcon } from "./property-icons";
import type { Property, View } from "./types";

/**
 * Choosing the icon of a database view (its tab) or of a property (its column and row-page line),
 * with the icon picker; without one, the type's icon shows.
 */

/** "Icon" in a view tab's menu: opens the picker beside it. */
export function ViewIconMenuItem({ view, onIcon, onDone }: { view: View; onIcon: (icon: string | null) => void; onDone: () => void }) {
  const t = useTranslations("database.viewTabs");
  const picker = useFloating<HTMLDivElement>();
  return (
    <div ref={picker.ref}>
      <MenuItem
        icon={<ViewIcon type={view.type} icon={view.config.icon} />}
        trailing={<ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />}
        onClick={picker.toggle}
      >
        {t("icon")}
      </MenuItem>
      <Floating open={picker.open} anchor={picker.el} onClose={picker.close} className="p-0">
        <IconGrid
          icon={view.config.icon ?? null}
          onChange={(icon) => {
            picker.close();
            onDone();
            onIcon(icon);
          }}
        />
      </Floating>
    </div>
  );
}

/** The button before a property's name in its menu: shows its icon, and opens the picker. */
export function PropertyIconButton({ prop, onIcon }: { prop: Property; onIcon?: (icon: string | null) => void }) {
  const t = useTranslations("database.propertyMenu");
  const picker = useFloating<HTMLButtonElement>();
  if (!onIcon) {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center text-fg-muted">
        <PropertyTypeIcon type={prop.type} icon={prop.options.icon} />
      </span>
    );
  }
  return (
    <>
      <button
        ref={picker.ref}
        type="button"
        aria-label={t("icon")}
        title={t("icon")}
        onClick={picker.toggle}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <PropertyTypeIcon type={prop.type} icon={prop.options.icon} />
      </button>
      <Floating open={picker.open} anchor={picker.el} onClose={picker.close} className="p-0">
        <IconGrid
          icon={prop.options.icon ?? null}
          onChange={(icon) => {
            picker.close();
            onIcon(icon);
          }}
        />
      </Floating>
    </>
  );
}
