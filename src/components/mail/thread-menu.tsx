"use client";

import { AlertOctagon, Archive, ChevronLeft, ChevronRight, ExternalLink, Folder, FolderInput, Forward, Inbox, Link2, Mail, MailOpen, Reply, ReplyAll, Search, SquareCheck, Star, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { showToast } from "@/components/toast";
import { MenuItem, MenuSeparator, Popover } from "@/components/ui";
import { movableTo, type MailAction, type MailboxTabView, type MailFolderView, type MailThreadItem } from "@/lib/mail-client";
import type { ComposeMode } from "./compose-start";
import { useFolderName } from "./mail-sidebar";

/**
 * A conversation's menu in the list, opened with a right click: answers, the moves and flags of
 * the thread's toolbar (and the keys that do them), moving to any folder, its sender's mail, and
 * its link. On one of several selected conversations, only the moves and flags, for all of them.
 * Loaded with the first right click.
 */

const Key = ({ children }: { children: ReactNode }) => <kbd className="font-sans text-xs text-fg-faint">{children}</kbd>;

export function ThreadMenu({
  at,
  item,
  many,
  box,
  folder,
  acrossMailboxes,
  href,
  onClose,
  onAction,
  onCompose,
  onFind,
  onSelect,
}: {
  at: { x: number; y: number };
  /** The conversation, or with `many`, the selection's: unread if any is, starred if all are. */
  item: MailThreadItem;
  /** How many selected conversations the menu is for, or 0 for one. */
  many: number;
  box: MailboxTabView;
  folder: MailFolderView;
  /** The selection is of several mailboxes (all inboxes): no folder of one takes them all. */
  acrossMailboxes: boolean;
  href: string;
  onClose: () => void;
  onAction: (action: MailAction, to?: MailFolderView) => void;
  onCompose: (mode: ComposeMode) => void;
  onFind: (search: string) => void;
  onSelect: () => void;
}) {
  const t = useTranslations("mail");
  const folderName = useFolderName();
  const [moving, setMoving] = useState(false);
  const run = (then: () => void) => () => {
    onClose();
    then();
  };
  const away = folder.role === "trash" || folder.role === "junk";
  const sender = item.senders.find((s) => s.address !== box.address);
  const targets = acrossMailboxes ? [] : (box.folders ?? []).filter((f) => f.id !== folder.id && movableTo(f));

  return (
    <Popover at={at} open onOpenChange={(open) => !open && onClose()} className="w-72" trigger={() => null}>
      {moving ? (
        <div className="max-h-80 overflow-y-auto">
          <MenuItem icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setMoving(false)}>
            {t("actions.move")}
          </MenuItem>
          <MenuSeparator />
          {targets.map((f) => (
            <div key={f.id} style={f.depth ? { paddingInlineStart: `${f.depth * 0.75}rem` } : undefined}>
              <MenuItem icon={f.role === "inbox" ? <Inbox className="h-4 w-4" /> : <Folder className="h-4 w-4" />} onClick={run(() => onAction("move", f))}>
                {folderName(f)}
              </MenuItem>
            </div>
          ))}
        </div>
      ) : (
        <>
          {many ? (
            <div className="px-2 py-1 text-xs font-medium text-fg-muted">{t("bulk.selected", { count: many })}</div>
          ) : (
            <>
              <MenuItem icon={<Reply className="h-4 w-4" />} trailing={<Key>R</Key>} onClick={run(() => onCompose("reply"))}>
                {t("actions.reply")}
              </MenuItem>
              <MenuItem icon={<ReplyAll className="h-4 w-4" />} trailing={<Key>A</Key>} onClick={run(() => onCompose("replyAll"))}>
                {t("actions.replyAll")}
              </MenuItem>
              <MenuItem icon={<Forward className="h-4 w-4" />} trailing={<Key>F</Key>} onClick={run(() => onCompose("forward"))}>
                {t("actions.forward")}
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          {away || folder.role === "archive" ? (
            <MenuItem icon={<Inbox className="h-4 w-4" />} trailing={<Key>E</Key>} onClick={run(() => onAction("inbox"))}>
              {t("actions.inbox")}
            </MenuItem>
          ) : (
            <MenuItem icon={<Archive className="h-4 w-4" />} trailing={<Key>E</Key>} onClick={run(() => onAction("archive"))}>
              {t("actions.archive")}
            </MenuItem>
          )}
          {folder.role === "trash" ? (
            <MenuItem icon={<Trash2 className="h-4 w-4" />} trailing={<Key>#</Key>} danger onClick={run(() => onAction("delete"))}>
              {t("actions.delete")}
            </MenuItem>
          ) : (
            <MenuItem icon={<Trash2 className="h-4 w-4" />} trailing={<Key>#</Key>} onClick={run(() => onAction("trash"))}>
              {t("actions.trash")}
            </MenuItem>
          )}
          {folder.role !== "junk" && (
            <MenuItem icon={<AlertOctagon className="h-4 w-4" />} trailing={<Key>!</Key>} onClick={run(() => onAction("junk"))}>
              {t("actions.junk")}
            </MenuItem>
          )}
          {item.unread ? (
            <MenuItem icon={<MailOpen className="h-4 w-4" />} trailing={<Key>⇧I</Key>} onClick={run(() => onAction("read"))}>
              {t("actions.read")}
            </MenuItem>
          ) : (
            <MenuItem icon={<Mail className="h-4 w-4" />} trailing={<Key>U</Key>} onClick={run(() => onAction("unread"))}>
              {t("actions.unread")}
            </MenuItem>
          )}
          <MenuItem icon={<Star className="h-4 w-4" />} trailing={<Key>S</Key>} onClick={run(() => onAction(item.starred ? "unstar" : "star"))}>
            {t(item.starred ? "actions.unstar" : "actions.star")}
          </MenuItem>
          {targets.length > 0 && (
            <MenuItem icon={<FolderInput className="h-4 w-4" />} trailing={<ChevronRight className="h-4 w-4" />} onClick={() => setMoving(true)}>
              {t("actions.move")}
            </MenuItem>
          )}
          {!many && (
            <MenuItem icon={<SquareCheck className="h-4 w-4" />} trailing={<Key>X</Key>} onClick={run(onSelect)}>
              {t("bulk.select")}
            </MenuItem>
          )}
          {sender && !many && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Search className="h-4 w-4" />} onClick={run(() => onFind(`from:${sender.address}`))}>
                {t("actions.fromSender", { name: sender.name || sender.address })}
              </MenuItem>
            </>
          )}
          {!many && (
            <>
              <MenuSeparator />
              <MenuItem icon={<ExternalLink className="h-4 w-4" />} onClick={run(() => window.open(href, "_blank", "noopener"))}>
                {t("actions.openInNewTab")}
              </MenuItem>
              <MenuItem
                icon={<Link2 className="h-4 w-4" />}
                onClick={run(() =>
                  void navigator.clipboard.writeText(new URL(href, window.location.origin).toString()).then(
                    () => showToast({ message: t("actions.linkCopied") }),
                    () => {},
                  ),
                )}
              >
                {t("actions.copyLink")}
              </MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  );
}
