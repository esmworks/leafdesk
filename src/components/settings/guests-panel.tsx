"use client";

import { ChevronDown, ChevronRight, Download, MoreHorizontal, Search } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { type SharingResult, removePageInvitationAction, removePagePermissionAction } from "@/app/actions/sharing";
import {
  type ActionResult,
  removeMemberAction,
  revokeInvitationAction,
  setMemberRoleAction,
} from "@/app/actions/workspaces";
import { SettingsHeader } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Floating, useFloating } from "@/components/database/floating";
import { Button, cn, Dialog, IconButton, Input, MenuItem, PageIcon } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { pageLabel } from "@/lib/labels";
import { searchFold } from "@/lib/search-fold";
import type { Guest, GuestPage } from "@/server/guests";

const fold = (text: string) => searchFold(text.trim());

/** Whether the guest's name or email matches, or only one of their pages does (then their pages open). */
function matchOf(query: string, guest: Guest, untitled: string): "none" | "person" | "page" {
  const q = fold(query);
  if (!q) return "person";
  if ([guest.name, guest.email].some((v) => searchFold(v).includes(q))) return "person";
  const titles = [...guest.pages, ...guest.invitations].map((p) => pageLabel(p.title, untitled));
  return titles.some((title) => searchFold(title).includes(q)) ? "page" : "none";
}

export function GuestsPanel({
  workspaceId,
  canManage,
  guests,
  now,
}: {
  workspaceId: string;
  /** Owners and membership admins also change a guest's role and remove them; members only take back page access. */
  canManage: boolean;
  guests: Guest[];
  /** Render time from the server, so "expired" matches between server and client render. */
  now: Date;
}) {
  const t = useTranslations("settings.guests");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const shown = useMemo(
    () =>
      guests.flatMap((guest) => {
        const match = matchOf(query, guest, tc("untitled"));
        return match === "none" ? [] : [{ guest, pageMatch: match === "page" }];
      }),
    [guests, query, tc],
  );

  return (
    <div>
      <SettingsHeader title={t("heading")} description={canManage ? t("description") : t("descriptionMember")} />
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-fg-muted">{t("count", { count: guests.length })}</span>
          <div className="ms-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
              <Input
                type="search"
                aria-label={t("search")}
                placeholder={t("search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-44 ps-7 sm:w-64"
              />
            </div>
            <a
              href={`/w/${workspaceId}/settings/guests.csv`}
              download
              aria-label={t("exportCsv")}
              title={t("exportCsv")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <Download className="h-4 w-4" />
            </a>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border">
          {shown.length ? (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 text-start font-normal">
                      {t("columns.guest")}
                    </th>
                    <th scope="col" className="w-36 px-4 py-2.5 text-start font-normal">
                      {t("columns.pages")}
                    </th>
                    <th scope="col" className="w-32 px-4 py-2.5 text-start font-normal">
                      {t("columns.added")}
                    </th>
                    <th scope="col" className="w-40 px-4 py-2.5 text-start font-normal">
                      {t("columns.invitedBy")}
                    </th>
                    <th scope="col" className="w-10">
                      <span className="sr-only">{t("columns.actions")}</span>
                    </th>
                  </tr>
                </thead>
                {shown.map(({ guest, pageMatch }) => (
                  <GuestRows
                    key={guest.userId ?? `invited:${guest.email}`}
                    workspaceId={workspaceId}
                    canManage={canManage}
                    guest={guest}
                    // A search that only matched a page title shows the pages it matched in.
                    open={pageMatch ? true : undefined}
                    now={now}
                  />
                ))}
              </table>
            </div>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-fg-muted">{guests.length ? t("noMatches") : t("empty")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

type Confirm = "makeMember" | "remove" | "revoke" | null;

/** A guest's row and, below it while open, the pages they were given. One tbody, so they stay together. */
function GuestRows({
  workspaceId,
  canManage,
  guest,
  open: forcedOpen,
  now,
}: {
  workspaceId: string;
  canManage: boolean;
  guest: Guest;
  open?: boolean;
  now: Date;
}) {
  const t = useTranslations("settings.guests");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [toggled, setToggled] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const menu = useFloating<HTMLButtonElement>();
  const { pending, error, run } = useAction();
  const open = forcedOpen ?? toggled;
  const label = guest.name || guest.email;
  const count = guest.pages.length + guest.hiddenPages + guest.invitations.length + guest.hiddenInvitations;
  const expired = guest.expiresAt !== null && guest.expiresAt.getTime() <= now.getTime();
  const detailsId = `guest-pages-${guest.userId ?? guest.email}`;
  // Owners and membership admins: making them a member and removing them for those who joined, withdrawing the
  // invitation for those who haven't.
  const actions = canManage && (guest.userId !== null || guest.invitationId !== null);

  function confirmed() {
    if (confirm === "makeMember" && guest.userId) {
      const userId = guest.userId;
      run(() => setMemberRoleAction(workspaceId, userId, "member"), () => setConfirm(null));
    } else if (confirm === "remove" && guest.userId) {
      const userId = guest.userId;
      run(() => removeMemberAction(workspaceId, userId), () => setConfirm(null));
    } else if (confirm === "revoke" && guest.invitationId) {
      const invitationId = guest.invitationId;
      run(() => revokeInvitationAction(workspaceId, invitationId), () => setConfirm(null));
    }
  }

  return (
    <tbody className="border-b border-border last:border-b-0">
      <tr className="align-middle">
        <td className="px-4 py-3">
          <div className="flex items-center gap-2.5">
            <UserAvatar name={label} image={guest.image} size="md" />
            <div className="min-w-0">
              <div className="truncate font-medium">{guest.name || guest.email}</div>
              {guest.userId ? (
                <div className="truncate text-xs text-fg-muted">{guest.email}</div>
              ) : (
                <div className={cn("truncate text-xs", expired ? "text-danger" : "text-fg-muted")}>
                  {expired ? t("invitationExpired") : t("invited")}
                </div>
              )}
            </div>
          </div>
          {error && !confirm && <p className="mt-1 text-xs text-danger">{error}</p>}
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={t("pagesOf", { name: label })}
            onClick={() => setToggled(!open)}
            disabled={forcedOpen !== undefined}
            className="-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 whitespace-nowrap text-fg-muted hover:bg-bg-hover hover:text-fg disabled:hover:bg-transparent"
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />}
            {t("pageCount", { count })}
          </button>
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-fg-muted">{format.dateTime(guest.addedAt, { dateStyle: "medium" })}</td>
        <td className="px-4 py-3 text-fg-muted">
          <span className="block truncate">{guest.invitedBy?.name || <span className="text-fg-faint">—</span>}</span>
        </td>
        <td className="px-1 py-2.5 text-end">
          {actions && (
            <>
              <IconButton ref={menu.ref} label={t("actionsFor", { name: label })} onClick={menu.toggle} disabled={pending}>
                <MoreHorizontal className="h-4 w-4" />
              </IconButton>
              {/* Portaled so the table's scroll container doesn't clip it. */}
              <Floating anchor={menu.el} open={menu.open} onClose={menu.close} align="end" className="text-start">
                {guest.userId ? (
                  <>
                    <MenuItem
                      onClick={() => {
                        menu.close();
                        setConfirm("makeMember");
                      }}
                    >
                      {t("makeMember")}
                    </MenuItem>
                    <MenuItem
                      danger
                      onClick={() => {
                        menu.close();
                        setConfirm("remove");
                      }}
                    >
                      {t("remove")}
                    </MenuItem>
                  </>
                ) : (
                  <MenuItem
                    danger
                    onClick={() => {
                      menu.close();
                      setConfirm("revoke");
                    }}
                  >
                    {t("revoke")}
                  </MenuItem>
                )}
              </Floating>
            </>
          )}
          <Dialog open={confirm !== null} onClose={() => setConfirm(null)} className="max-w-md text-start">
            <div className="space-y-3 p-5">
              <h2 className="text-base font-semibold">
                {confirm === "makeMember"
                  ? t("makeMemberTitle", { name: label })
                  : confirm === "remove"
                    ? t("removeTitle", { name: label })
                    : t("revokeTitle", { email: guest.email })}
              </h2>
              <p className="text-sm text-fg-muted">
                {confirm === "makeMember"
                  ? t("makeMemberBody", { name: label })
                  : confirm === "remove"
                    ? t("removeBody", { name: label })
                    : t("revokeBody", { email: guest.email })}
              </p>
              {error && <p className="text-xs text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirm(null)}>
                  {tc("cancel")}
                </Button>
                <Button variant={confirm === "makeMember" ? "primary" : "danger"} disabled={pending} onClick={confirmed}>
                  {confirm === "makeMember" ? t("makeMemberConfirm") : confirm === "remove" ? tc("remove") : t("revoke")}
                </Button>
              </div>
            </div>
          </Dialog>
        </td>
      </tr>
      {open && (
        <tr id={detailsId}>
          <td colSpan={5} className="bg-bg-subtle/60 px-4 py-3">
            <GuestPages workspaceId={workspaceId} guest={guest} />
          </td>
        </tr>
      )}
    </tbody>
  );
}

function GuestPages({ workspaceId, guest }: { workspaceId: string; guest: Guest }) {
  const t = useTranslations("settings.guests");
  const label = guest.name || guest.email;
  const nothing = !guest.pages.length && !guest.hiddenPages && !guest.invitations.length && !guest.hiddenInvitations;
  if (nothing) return <p className="text-sm text-fg-muted">{t("noPages")}</p>;
  return (
    <div className="space-y-3">
      {(guest.pages.length > 0 || guest.hiddenPages > 0) && (
        <PageList
          workspaceId={workspaceId}
          pages={guest.pages}
          hidden={guest.hiddenPages}
          label={t("pagesOf", { name: label })}
          remove={(p) => (guest.userId ? removePagePermissionAction(p.pageId, guest.userId) : null)}
          removeLabel={(title) => t("removeAccess", { name: label, page: title })}
          removeText={t("removeAccessShort")}
          byText={(name) => t("sharedBy", { name })}
        />
      )}
      {(guest.invitations.length > 0 || guest.hiddenInvitations > 0) && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-fg-muted">{t("waiting")}</h3>
          <PageList
            workspaceId={workspaceId}
            pages={guest.invitations}
            hidden={guest.hiddenInvitations}
            label={t("waitingFor", { name: label })}
            remove={(p) => removePageInvitationAction(p.pageId, guest.email)}
            removeLabel={(title) => t("cancelInvitationFor", { email: guest.email, page: title })}
            removeText={t("cancelInvitationShort")}
            byText={(name) => t("invitedBy", { name })}
          />
        </div>
      )}
    </div>
  );
}

function PageList({
  workspaceId,
  pages,
  hidden,
  label,
  remove,
  removeLabel,
  removeText,
  byText,
}: {
  workspaceId: string;
  pages: GuestPage[];
  hidden: number;
  label: string;
  remove: (page: GuestPage) => Promise<SharingResult> | null;
  removeLabel: (title: string) => string;
  removeText: string;
  byText: (name: string) => string;
}) {
  const t = useTranslations("settings.guests");
  return (
    <ul aria-label={label} className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg">
      {pages.map((p) => (
        <PageItem
          key={p.pageId}
          workspaceId={workspaceId}
          page={p}
          remove={remove}
          removeLabel={removeLabel}
          removeText={removeText}
          byText={byText}
        />
      ))}
      {hidden > 0 && <li className="px-3 py-2 text-xs text-fg-muted">{t("hidden", { count: hidden })}</li>}
    </ul>
  );
}

function PageItem({
  workspaceId,
  page,
  remove,
  removeLabel,
  removeText,
  byText,
}: {
  workspaceId: string;
  page: GuestPage;
  remove: (page: GuestPage) => Promise<SharingResult> | null;
  removeLabel: (title: string) => string;
  removeText: string;
  byText: (name: string) => string;
}) {
  const t = useTranslations("settings.guests");
  const tc = useTranslations("common");
  const tShare = useTranslations("page.share");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const title = pageLabel(page.title, tc("untitled"));

  // The sharing actions answer with a code; the row shows it the way the share panel does.
  const removeIt = () =>
    run(async (): Promise<ActionResult> => {
      const result = await remove(page);
      if (!result || result.ok) return { ok: true, data: undefined };
      return { ok: false, error: tShare(`errors.${result.code}`) };
    });

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <PageIcon icon={page.icon} kind={page.kind} className="shrink-0" />
        <Link href={`/w/${workspaceId}/p/${page.pageId}`} className="truncate font-medium hover:underline">
          {title}
        </Link>
        {page.inTrash && (
          <span className="shrink-0 rounded bg-bg-hover px-1.5 py-0.5 text-xs text-fg-muted">{t("inTrash")}</span>
        )}
      </div>
      <span className="w-28 shrink-0 text-fg-muted">{tShare(`levels.${page.level}`)}</span>
      <span className="w-48 shrink-0 truncate text-xs text-fg-muted" title={format.dateTime(page.at, { dateStyle: "medium", timeStyle: "short" })}>
        {page.by ? byText(page.by.name) : format.dateTime(page.at, { dateStyle: "medium" })}
        {page.by && <> · {format.dateTime(page.at, { dateStyle: "medium" })}</>}
      </span>
      <div className="flex w-32 shrink-0 justify-end">
        {page.canManage && (
          <Button size="sm" variant="ghost" className="whitespace-nowrap" aria-label={removeLabel(title)} disabled={pending} onClick={removeIt}>
            {removeText}
          </Button>
        )}
      </div>
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </li>
  );
}
