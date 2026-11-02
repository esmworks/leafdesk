"use client";

import { ClipboardPaste, Copy, Eraser, Maximize2, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { MenuItem } from "@/components/ui";
import { Floating } from "./floating";

const icon = (Icon: React.ComponentType<{ className?: string }>) => <Icon className="h-3.5 w-3.5" />;

/**
 * What a tap on a table's selected cell opens on a touch screen, where there are no keys for it:
 * editing the cell, opening its row, and copying, pasting and clearing the cell. Items left out
 * (`undefined`) don't show; each closes the menu.
 */
export function CellMenu({
  anchor,
  onClose,
  onEdit,
  onOpenRow,
  onCopy,
  onPaste,
  onClear,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  onEdit?: () => void;
  onOpenRow: () => void;
  onCopy: () => void;
  onPaste?: () => void;
  onClear?: () => void;
}) {
  const t = useTranslations("database.table");
  const item = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <Floating anchor={anchor} open onClose={onClose} className="min-w-40">
      {onEdit && <MenuItem icon={icon(Pencil)} onClick={item(onEdit)}>{t("cellEdit")}</MenuItem>}
      <MenuItem icon={icon(Maximize2)} onClick={item(onOpenRow)}>{t("cellOpenRow")}</MenuItem>
      <MenuItem icon={icon(Copy)} onClick={item(onCopy)}>{t("cellCopy")}</MenuItem>
      {onPaste && <MenuItem icon={icon(ClipboardPaste)} onClick={item(onPaste)}>{t("cellPaste")}</MenuItem>}
      {onClear && <MenuItem icon={icon(Eraser)} onClick={item(onClear)}>{t("cellClear")}</MenuItem>}
    </Floating>
  );
}
