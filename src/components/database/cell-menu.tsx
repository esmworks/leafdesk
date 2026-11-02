"use client";

import { ClipboardPaste, Copy, CopyPlus, Eraser, Link2, Maximize2, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { MenuItem, MenuSeparator } from "@/components/ui";
import type { ScreenBox } from "@/lib/placement";
import { comboText, FILL_DOWN_COMBO, isMac, type Combo } from "@/lib/shortcuts";
import { Floating } from "./floating";

const icon = (Icon: React.ComponentType<{ className?: string }>) => <Icon className="h-3.5 w-3.5" />;

const COPY: Combo = ["Mod", "C"];
const PASTE: Combo = ["Mod", "V"];
const CLEAR: Combo = ["Del"];

/**
 * What a right click on a table's cells opens, and a tap on the selected cell on a touch screen,
 * where there are no keys for it: editing the cell, opening its row, copying, pasting and clearing
 * the cells selected, then the row's own actions. With cells of several rows selected (`rows`),
 * duplicating and trashing take all of them. Items left out (`undefined`) don't show; each closes
 * the menu.
 */
export function CellMenu({
  anchor,
  at,
  rows,
  onClose,
  onEdit,
  onOpenRow,
  onCopy,
  onPaste,
  onClear,
  onComment,
  onCopyLink,
  onDuplicate,
  onTrash,
}: {
  anchor: HTMLElement | null;
  /** A right click's point, which the menu opens at. */
  at?: ScreenBox;
  rows: number;
  onClose: () => void;
  onEdit?: () => void;
  onOpenRow: () => void;
  onCopy: () => void;
  onPaste?: () => void;
  onClear?: () => void;
  onComment?: () => void;
  onCopyLink?: () => void;
  onDuplicate?: () => void;
  onTrash?: () => void;
}) {
  const t = useTranslations("database");
  const th = useTranslations("page.header");
  const mac = isMac();
  const item = (run: () => void) => () => {
    onClose();
    run();
  };
  const keys = (combo: Combo) => <kbd className="font-sans text-xs text-fg-faint pointer-coarse:hidden">{comboText(combo, mac)}</kbd>;
  return (
    <Floating anchor={anchor} at={at} open onClose={onClose} className="min-w-52">
      {onEdit && <MenuItem icon={icon(Pencil)} onClick={item(onEdit)}>{t("table.cellEdit")}</MenuItem>}
      <MenuItem icon={icon(Maximize2)} onClick={item(onOpenRow)}>{t("table.cellOpenRow")}</MenuItem>
      <MenuItem icon={icon(Copy)} trailing={keys(COPY)} onClick={item(onCopy)}>{t("table.cellCopy")}</MenuItem>
      {onPaste && <MenuItem icon={icon(ClipboardPaste)} trailing={keys(PASTE)} onClick={item(onPaste)}>{t("table.cellPaste")}</MenuItem>}
      {onClear && <MenuItem icon={icon(Eraser)} trailing={keys(CLEAR)} onClick={item(onClear)}>{t("table.cellClear")}</MenuItem>}
      <MenuSeparator />
      {rows > 1 && <p className="px-2 pt-1 pb-1 text-xs font-medium text-fg-faint">{t("bulk.selected", { count: rows })}</p>}
      {onComment && <MenuItem icon={icon(MessageSquare)} onClick={item(onComment)}>{t("rowMenu.comment")}</MenuItem>}
      {onCopyLink && <MenuItem icon={icon(Link2)} onClick={item(onCopyLink)}>{t("rowMenu.copyLink")}</MenuItem>}
      {onDuplicate && (
        // Mod+D duplicates the row only while the cells selected are in one row (it fills down otherwise).
        <MenuItem icon={icon(CopyPlus)} trailing={rows === 1 ? keys(FILL_DOWN_COMBO) : undefined} onClick={item(onDuplicate)}>
          {t("rowMenu.duplicate")}
        </MenuItem>
      )}
      {onTrash && <MenuItem icon={icon(Trash2)} danger onClick={item(onTrash)}>{th("moveToTrash")}</MenuItem>}
    </Floating>
  );
}
