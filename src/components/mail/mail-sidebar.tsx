"use client";

import { AlertOctagon, Archive, Clock, Folder, Inbox, Mails, Send, Star, FileText, Trash2, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback } from "react";
import { PanelEmpty, panelHeading, panelIcon, panelMeta, panelRow, panelRowActive, panelSection } from "@/components/sidebar/panel";
import { useSidebar } from "@/components/sidebar/sidebar-context";
import { cn } from "@/components/ui";
import { ALL_INBOXES, STARRED, type MailboxTabView, type MailFolderRole, type MailFolderView } from "@/lib/mail-client";
import { initialOf, textOn, userColor } from "@/lib/presence";
import { inboxUnread, mailHref, pickOpen, stayInMail, useMailboxes } from "./mail-store";

export const FOLDER_ICONS: Record<MailFolderRole, LucideIcon> = {
  inbox: Inbox,
  drafts: FileText,
  sent: Send,
  snoozed: Clock,
  archive: Archive,
  junk: AlertOctagon,
  trash: Trash2,
};

/** A folder's name: what it is for in the person's language, else its own name. The same function across renders. */
export function useFolderName() {
  const t = useTranslations("mail.folders");
  return useCallback((folder: Pick<MailFolderView, "role" | "name">) => (folder.role ? t(folder.role) : folder.name), [t]);
}

function FolderLink({ workspaceId, box, folder, active, onPick }: { workspaceId: string; box: MailboxTabView; folder: MailFolderView; active: boolean; onPick: (e: React.MouseEvent, href: string) => void }) {
  const name = useFolderName();
  const Icon = folder.role ? FOLDER_ICONS[folder.role] : Folder;
  // The unread count is what the inbox and own folders are read by; the trash and junk don't nag.
  const count = folder.role === "trash" || folder.role === "junk" || folder.role === "sent" ? 0 : folder.unseen;
  const href = mailHref(workspaceId, { box: box.id, f: folder.id });
  return (
    <Link
      href={href}
      onClick={(e) => onPick(e, href)}
      aria-current={active ? "page" : undefined}
      className={cn(panelRow, active && panelRowActive)}
      style={folder.depth ? { paddingInlineStart: `${0.5 + folder.depth * 0.75}rem` } : undefined}
    >
      <Icon className={panelIcon} />
      <span className={cn("min-w-0 flex-1 truncate", count > 0 && "font-medium text-fg")}>{name(folder)}</span>
      {count > 0 && <span className={panelMeta}>{count}</span>}
    </Link>
  );
}

/** The starred conversations of a mailbox, or of all of them: no count, they are kept rather than read through. */
function StarredLink({ href, label, active, onPick }: { href: string; label: string; active: boolean; onPick: (e: React.MouseEvent, href: string) => void }) {
  return (
    <Link href={href} onClick={(e) => onPick(e, href)} aria-current={active ? "page" : undefined} className={cn(panelRow, active && panelRowActive)}>
      <Star className={panelIcon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Link>
  );
}

/** A mailbox's letter, in a color of its own from its address. */
export function MailboxMark({ address, className }: { address: string; className?: string }) {
  const color = userColor(address);
  const locale = useLocale();
  return (
    <span aria-hidden className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold", className)} style={{ background: color, color: textOn(color) }}>
      {initialOf(address, locale)}
    </span>
  );
}

/** What the sidebar shows in its Mail tab: the open mailbox with New message, its folders, the other mailboxes. */
export function MailSidebar({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("mail");
  const search = useSearchParams();
  const { boxes, error } = useMailboxes(workspaceId);
  const { box, folder, all, starred } = pickOpen(boxes, search.get("box"), search.get("f"));
  const closeDrawer = useSidebar()?.close;
  // A phone's drawer may show this list over another page, and on the Mail page a folder only changes
  // the address's query, which leaves the drawer open.
  const pick = (e: React.MouseEvent, href: string) => {
    stayInMail(e, href);
    closeDrawer?.();
  };

  if (error) return <PanelEmpty className="text-fg-muted">{error}</PanelEmpty>;
  if (!boxes || !box) {
    return (
      <div className="space-y-1.5 px-2 pt-1" aria-busy>
        {[70, 50, 60, 45, 55].map((w) => (
          <div key={w} className="h-4 animate-pulse rounded bg-bg-hover" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  const roles = (box.folders ?? []).filter((f) => f.role);
  const own = (box.folders ?? []).filter((f) => !f.role);
  const others = boxes.filter((b) => b.id !== box.id);
  const allHref = mailHref(workspaceId, { box: ALL_INBOXES });
  const allUnread = inboxUnread(boxes);

  return (
    <div className="flex flex-col">
      {/* Several mailboxes: their inboxes as one list, and their starred, above the open mailbox. */}
      {boxes.length > 1 && (
        <div className="space-y-px">
          <Link
            href={allHref}
            onClick={(e) => pick(e, allHref)}
            aria-current={all && !starred ? "page" : undefined}
            className={cn(panelRow, all && !starred && panelRowActive)}
          >
            <Mails className={panelIcon} />
            <span className={cn("min-w-0 flex-1 truncate", allUnread > 0 && "font-medium text-fg")}>{t("allInboxes")}</span>
            {allUnread > 0 && <span className={panelMeta}>{allUnread}</span>}
          </Link>
          <StarredLink href={mailHref(workspaceId, { box: ALL_INBOXES, f: STARRED })} label={t("allStarred")} active={all && starred} onPick={pick} />
        </div>
      )}
      {/* The open mailbox, its address as the heading of its folders. New message is in the
          sidebar panel's head (sidebar.tsx). */}
      <section className={cn(boxes.length > 1 && panelSection)} aria-label={box.address}>
        <h2 className={cn(panelHeading, "gap-2")} title={box.address}>
          <MailboxMark address={box.address} />
          <span className="min-w-0 truncate">{box.address}</span>
        </h2>
        {box.folders === null ? (
          <div className="space-y-1.5 px-2 pt-2" aria-busy>
            {[60, 45, 55, 40].map((w) => (
              <div key={w} className="h-4 animate-pulse rounded bg-bg-hover" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : (
          <nav className="space-y-px" aria-label={t("foldersLabel")}>
            {roles.map((f) => (
              <Fragment key={f.id}>
                <FolderLink workspaceId={workspaceId} box={box} folder={f} active={!all && !starred && f.id === folder?.id} onPick={pick} />
                {f.role === "inbox" && <StarredLink href={mailHref(workspaceId, { box: box.id, f: STARRED })} label={t("starred")} active={!all && starred} onPick={pick} />}
              </Fragment>
            ))}
          </nav>
        )}
      </section>
      {own.length > 0 && (
        <section className={panelSection}>
          <h2 className={panelHeading}>{t("ownFolders")}</h2>
          <div className="space-y-px">
            {own.map((f) => (
              <FolderLink key={f.id} workspaceId={workspaceId} box={box} folder={f} active={!all && !starred && f.id === folder?.id} onPick={pick} />
            ))}
          </div>
        </section>
      )}
      {others.length > 0 && (
        <section className={panelSection}>
          <h2 className={panelHeading}>{t("otherMailboxes")}</h2>
          <div className="space-y-px">
            {others.map((other) => {
              const unread = other.folders?.find((f) => f.role === "inbox")?.unseen ?? 0;
              return (
                <Link key={other.id} href={mailHref(workspaceId, { box: other.id })} onClick={(e) => pick(e, mailHref(workspaceId, { box: other.id }))} className={panelRow} title={other.address}>
                  <MailboxMark address={other.address} />
                  <span className="min-w-0 flex-1 truncate">{other.address}</span>
                  {unread > 0 && <span className={panelMeta}>{unread}</span>}
                </Link>
              );
            })}
          </div>
        </section>
      )}
      {box.status === "error" && <PanelEmpty className="text-danger">{t("mailboxFailing")}</PanelEmpty>}
    </div>
  );
}
