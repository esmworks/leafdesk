"use client";

import { AlertOctagon, Archive, Folder, FolderInput, Inbox, Mail, MailOpen, Star, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { SelectBox } from "@/components/selection";
import { IconButton, MenuItem, Popover } from "@/components/ui";
import { movableTo, type MailAction, type MailboxTabView, type MailFolderView, type MailThreadItem } from "@/lib/mail-client";
import { useFolderName } from "./mail-sidebar";

/**
 * In place of the list's title while conversations are selected: how many, select all, and the
 * moves and flags of a conversation's menu for all of them. Loaded with the Mail page, shown with
 * the first selection.
 */
export function SelectionBar({
  items,
  all,
  box,
  folder,
  onToggleAll,
  onClear,
  onAction,
}: {
  items: MailThreadItem[];
  /** Every conversation the list has loaded is selected. */
  all: boolean;
  box: MailboxTabView;
  folder: MailFolderView;
  onToggleAll: () => void;
  onClear: () => void;
  onAction: (action: MailAction, to?: MailFolderView) => void;
}) {
  const t = useTranslations("mail");
  const folderName = useFolderName();
  const away = folder.role === "trash" || folder.role === "junk";
  const targets = (box.folders ?? []).filter((f) => f.id !== folder.id && movableTo(f));
  const unread = items.some((i) => i.unread);
  const starred = items.every((i) => i.starred);
  const button = "h-8 w-8 text-fg-icon";

  return (
    <div role="toolbar" aria-label={t("bulk.toolbar")} className="-ms-2 flex items-center gap-0.5">
      <SelectBox checked={all} indeterminate={!all} label={t("bulk.selectAll")} visible onToggle={onToggleAll} />
      <span aria-live="polite" className="min-w-0 flex-1 truncate ps-1 text-sm font-medium tabular-nums">
        {t("bulk.selected", { count: items.length })}
      </span>
      {away || folder.role === "archive" ? (
        <IconButton label={t("actions.inbox")} className={button} onClick={() => onAction("inbox")}>
          <Inbox className="h-4 w-4" />
        </IconButton>
      ) : (
        <IconButton label={t("actions.archive")} className={button} onClick={() => onAction("archive")}>
          <Archive className="h-4 w-4" />
        </IconButton>
      )}
      {folder.role === "trash" ? (
        <IconButton label={t("actions.delete")} className={`${button} hover:text-danger`} onClick={() => onAction("delete")}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      ) : (
        <IconButton label={t("actions.trash")} className={button} onClick={() => onAction("trash")}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      )}
      {folder.role !== "junk" && (
        <IconButton label={t("actions.junk")} className={button} onClick={() => onAction("junk")}>
          <AlertOctagon className="h-4 w-4" />
        </IconButton>
      )}
      <IconButton label={t(unread ? "actions.read" : "actions.unread")} className={button} onClick={() => onAction(unread ? "read" : "unread")}>
        {unread ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
      </IconButton>
      <IconButton label={t(starred ? "actions.unstar" : "actions.star")} className={button} onClick={() => onAction(starred ? "unstar" : "star")}>
        <Star className={starred ? "h-4 w-4 fill-current text-amber-500" : "h-4 w-4"} />
      </IconButton>
      {targets.length > 0 && (
        <Popover
          align="end"
          className="w-64"
          trigger={({ open, toggle }) => (
            <IconButton label={t("actions.move")} aria-expanded={open} className={button} onClick={toggle}>
              <FolderInput className="h-4 w-4" />
            </IconButton>
          )}
        >
          {(close) => (
            <div className="max-h-80 overflow-y-auto">
              {targets.map((f) => (
                <div key={f.id} style={f.depth ? { paddingInlineStart: `${f.depth * 0.75}rem` } : undefined}>
                  <MenuItem
                    icon={f.role === "inbox" ? <Inbox className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
                    onClick={() => {
                      close();
                      onAction("move", f);
                    }}
                  >
                    {folderName(f)}
                  </MenuItem>
                </div>
              ))}
            </div>
          )}
        </Popover>
      )}
      <IconButton label={t("bulk.clear")} className={button} onClick={onClear}>
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  );
}
