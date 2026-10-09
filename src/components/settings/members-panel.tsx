"use client";

import { ArrowDown, ArrowUp, ChevronDown, Download, MoreHorizontal, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  addMembersAction,
  approveJoinRequestAction,
  declineJoinRequestAction,
  removeMemberAction,
  revokeInvitationAction,
  setJoinLinkAction,
  setMemberRoleAction,
  transferOwnershipAction,
} from "@/app/actions/workspaces";
import { CopyButton } from "@/components/settings/copy-button";
import { SettingsGroup, SettingsHeader, SettingsRow } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Floating, useFloating } from "@/components/database/floating";
import { Button, cn, Dialog, IconButton, Input, MenuItem, selectClass, Switch } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { WorkspaceRole } from "@/db/schema/app";
import { MAX_BULK_EMAILS, parseEmailList } from "@/lib/emails";
import type { JoinRequestItem } from "@/server/join-requests";
import type { BulkAddResult } from "@/server/workspaces";
import { searchFold } from "@/lib/search-fold";

export type Member = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: WorkspaceRole;
  joinedAt: Date;
  lastEditedAt: Date | null;
};
export type Invitation = { id: string; email: string; role: WorkspaceRole; expiresAt: Date; link: string };
export type MemberTeamspace = { id: string; name: string; icon: string | null };
export type MemberGroup = { id: string; name: string };

type SortKey = "name" | "role" | "joined" | "edited";
type Tab = "members" | "invitations" | "requests";
type Sort = { key: SortKey; dir: "asc" | "desc" };

function matches(query: string, ...values: string[]) {
  const q = searchFold(query.trim());
  return !q || values.some((v) => searchFold(v).includes(q));
}

const ROLE_ORDER: Record<WorkspaceRole, number> = { owner: 0, member: 1, guest: 2 };

function compareMembers(a: Member, b: Member, key: SortKey) {
  switch (key) {
    case "name":
      return (a.name || a.email).localeCompare(b.name || b.email);
    case "role":
      // Owners, then members, then guests when ascending.
      return ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.name || a.email).localeCompare(b.name || b.email);
    case "joined":
      return a.joinedAt.getTime() - b.joinedAt.getTime();
    case "edited":
      // Never edited sorts as oldest.
      return (a.lastEditedAt?.getTime() ?? 0) - (b.lastEditedAt?.getTime() ?? 0);
  }
}

export function MembersPanel({
  workspaceId,
  currentUserId,
  isOwner,
  initialTab = "members",
  addMembers,
  members,
  invitations,
  requests,
  joinLink,
  joinLinkAsks,
  teamspaces,
  groups,
  now,
}: {
  workspaceId: string;
  currentUserId: string;
  isOwner: boolean;
  initialTab?: Tab;
  /** How the viewer may add members (Settings > Security): right away, by asking an owner, or not. */
  addMembers: "direct" | "request" | null;
  /** Render time from the server, so relative dates match between server and client render. */
  now: Date;
  members: Member[];
  /** Pending invitations; only owners get them. */
  invitations: Invitation[];
  /** Join requests waiting for an owner; only owners get them. */
  requests: JoinRequestItem[];
  /** The join link, or null when off. Only owners get it. */
  joinLink: string | null;
  /** The link asks an owner instead of adding people ("Who can ask to join": anyone with the link). */
  joinLinkAsks: boolean;
  /** By user id: the teamspaces (that the viewer can see) each person is in. Guests have none. */
  teamspaces: Record<string, MemberTeamspace[]>;
  /** By user id: the groups each person is in. Guests are in none. */
  groups: Record<string, MemberGroup[]>;
}) {
  const t = useTranslations("settings.members");
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const [adding, setAdding] = useState(false);

  const shownMembers = useMemo(() => {
    const list = members.filter((m) => matches(query, m.name, m.email));
    list.sort((a, b) => compareMembers(a, b, sort.key) * (sort.dir === "asc" ? 1 : -1));
    return list;
  }, [members, query, sort]);
  const shownInvitations = invitations.filter((i) => matches(query, i.email));

  return (
    <div>
      <SettingsHeader title={t("heading")} description={t("description")} />

      <div className="space-y-10">
        {isOwner && (
          <SettingsGroup>
            <JoinLinkCard workspaceId={workspaceId} link={joinLink} asks={joinLinkAsks} />
          </SettingsGroup>
        )}

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label={t("heading")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
              <TabButton active={tab === "members"} onClick={() => setTab("members")}>
                {t("tabs.members")} <span className="text-fg-faint">{members.length}</span>
              </TabButton>
              {isOwner && (
                <TabButton active={tab === "invitations"} onClick={() => setTab("invitations")}>
                  {t("tabs.invitations")} <span className="text-fg-faint">{invitations.length}</span>
                </TabButton>
              )}
              {isOwner && (
                <TabButton active={tab === "requests"} onClick={() => setTab("requests")}>
                  {t("tabs.requests")} <span className="text-fg-faint">{requests.length}</span>
                </TabButton>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
                <Input
                  type="search"
                  aria-label={t("search")}
                  placeholder={t("search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-44 pl-7 sm:w-56"
                />
              </div>
              {isOwner && (
                <a
                  href={`/w/${workspaceId}/settings/members.csv`}
                  download
                  aria-label={t("exportCsv")}
                  title={t("exportCsv")}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <Download className="h-4 w-4" />
                </a>
              )}
              {addMembers && (
                <Button variant="primary" onClick={() => setAdding(true)} className="shrink-0 whitespace-nowrap">
                  {t("addButton")}
                </Button>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border">
            {tab === "members" ? (
              <MembersTable
                now={now}
                workspaceId={workspaceId}
                currentUserId={currentUserId}
                isOwner={isOwner}
                members={shownMembers}
                teamspaces={teamspaces}
                groups={groups}
                sort={sort}
                onSort={(key) =>
                  setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "edited" ? "desc" : "asc" }))
                }
                empty={members.length ? t("noMatches") : null}
              />
            ) : tab === "requests" ? (
              <RequestsTable
                now={now}
                workspaceId={workspaceId}
                requests={requests.filter((r) => matches(query, r.email, r.askerName ?? ""))}
                empty={requests.length ? t("noMatches") : t("noRequests")}
              />
            ) : (
              <InvitationsTable
                now={now}
                workspaceId={workspaceId}
                invitations={shownInvitations}
                empty={invitations.length ? t("noMatches") : t("noInvitations")}
              />
            )}
          </div>
        </div>
      </div>

      {addMembers && (
        <AddMembersDialog
          workspaceId={workspaceId}
          open={adding}
          onClose={() => setAdding(false)}
          canPickRole={isOwner}
          asks={addMembers === "request"}
        />
      )}
    </div>
  );
}

export function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
        active ? "bg-bg font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function JoinLinkCard({ workspaceId, link, asks }: { workspaceId: string; link: string | null; asks: boolean }) {
  const t = useTranslations("settings.members.joinLink");
  const { pending, error, run } = useAction();
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <>
      <SettingsRow
        title={t("heading")}
        description={
          <>
            {link ? (asks ? t("descriptionAsks") : t("descriptionOn")) : t("descriptionOff")}{" "}
            {link && (
              <button
                type="button"
                className="underline underline-offset-2 hover:text-fg"
                disabled={pending}
                onClick={() => setConfirmReset(true)}
              >
                {t("regenerate")}
              </button>
            )}
            {error && <span className="mt-1 block text-danger">{error}</span>}
          </>
        }
        control={
          <>
            {link && <CopyButton value={link} label={t("copy")} />}
            <Switch
              checked={Boolean(link)}
              disabled={pending}
              label={t("toggle")}
              onChange={(on) => run(() => setJoinLinkAction(workspaceId, on ? "enable" : "disable"))}
            />
          </>
        }
      />
      {/* Mounted only while open, so an earlier attempt's error doesn't linger. */}
      {confirmReset && <RegenerateLinkDialog workspaceId={workspaceId} onClose={() => setConfirmReset(false)} />}
    </>
  );
}

function RegenerateLinkDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useTranslations("settings.members.joinLink");
  const tc = useTranslations("common");
  // Its own action state, so a failure shows here instead of behind the dialog.
  const { pending, error, run } = useAction();
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-3 p-5">
        <h2 className="text-base font-semibold">{t("regenerateTitle")}</h2>
        <p className="text-sm text-fg-muted">{t("regenerateBody")}</p>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => run(() => setJoinLinkAction(workspaceId, "regenerate"), onClose)}
          >
            {t("regenerateConfirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === column;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("px-4 py-2.5 text-left font-normal", className)}
    >
      <button type="button" onClick={() => onSort(column)} className="inline-flex items-center gap-1 hover:text-fg">
        {label}
        {active && <Arrow className="h-3 w-3" />}
      </button>
    </th>
  );
}

function MembersTable({
  now,
  workspaceId,
  currentUserId,
  isOwner,
  members,
  teamspaces,
  groups,
  sort,
  onSort,
  empty,
}: {
  now: Date;
  workspaceId: string;
  currentUserId: string;
  isOwner: boolean;
  members: Member[];
  teamspaces: Record<string, MemberTeamspace[]>;
  groups: Record<string, MemberGroup[]>;
  sort: Sort;
  onSort: (key: SortKey) => void;
  empty: string | null;
}) {
  const t = useTranslations("settings.members");
  if (!members.length) return empty ? <p className="px-4 py-8 text-center text-sm text-fg-muted">{empty}</p> : null;
  return (
    // `relative` keeps the absolutely positioned sr-only header text inside the scroller.
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
          <tr>
            <SortHeader label={t("columns.user")} column="name" sort={sort} onSort={onSort} />
            <SortHeader label={t("columns.role")} column="role" sort={sort} onSort={onSort} className="w-36" />
            <th scope="col" className="w-36 px-4 py-2.5 text-left font-normal">
              {t("columns.teamspaces")}
            </th>
            <th scope="col" className="w-32 px-4 py-2.5 text-left font-normal">
              {t("columns.groups")}
            </th>
            <SortHeader label={t("columns.joined")} column="joined" sort={sort} onSort={onSort} className="w-32" />
            <SortHeader label={t("columns.lastEdited")} column="edited" sort={sort} onSort={onSort} className="w-40" />
            <th scope="col" className="w-10">
              <span className="sr-only">{t("columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {members.map((m) => (
            <MemberRow
              key={m.userId}
              now={now}
              workspaceId={workspaceId}
              member={m}
              teamspaces={teamspaces[m.userId] ?? []}
              groups={groups[m.userId] ?? []}
              isSelf={m.userId === currentUserId}
              isOwner={isOwner}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}


type PendingConfirm = "remove" | "transfer" | null;

function MemberRow({
  now,
  workspaceId,
  member,
  teamspaces,
  groups,
  isSelf,
  isOwner,
}: {
  now: Date;
  workspaceId: string;
  member: Member;
  teamspaces: MemberTeamspace[];
  groups: MemberGroup[];
  isSelf: boolean;
  isOwner: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("settings.members");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const menu = useFloating<HTMLButtonElement>();
  const { pending, error, run } = useAction();
  const canRemove = isOwner || isSelf;
  // Ownership goes to members only; a guest has to be made a member first.
  const canTransfer = isOwner && !isSelf && member.role === "member";

  return (
    <tr className="align-middle">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <UserAvatar name={member.name || member.email} image={member.image} size="md" />
          <div className="min-w-0">
            <div className="truncate font-medium">
              {member.name}
              {isSelf && <span className="font-normal text-fg-muted"> {t("you")}</span>}
            </div>
            <div className="truncate text-xs text-fg-muted">{member.email}</div>
          </div>
        </div>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </td>
      <td className="px-4 py-3">
        {isOwner ? (
          <select
            aria-label={t("roleOf", { name: member.name })}
            className={selectClass}
            value={member.role}
            disabled={pending}
            onChange={(e) => run(() => setMemberRoleAction(workspaceId, member.userId, e.target.value as WorkspaceRole))}
          >
            <option value="owner">{t("roles.owner")}</option>
            <option value="member">{t("roles.member")}</option>
            <option value="guest">{t("roles.guest")}</option>
          </select>
        ) : (
          <span className="text-fg-muted">{t(`roles.${member.role}`)}</span>
        )}
      </td>
      <td className="px-4 py-3">
        <TeamspacesCell name={member.name || member.email} teamspaces={member.role === "guest" ? [] : teamspaces} />
      </td>
      <td className="px-4 py-3">
        <GroupsCell name={member.name || member.email} groups={member.role === "guest" ? [] : groups} />
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-fg-muted">{format.dateTime(member.joinedAt, { dateStyle: "medium" })}</td>
      <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
        {member.lastEditedAt ? (
          <time dateTime={member.lastEditedAt.toISOString()} title={format.dateTime(member.lastEditedAt, { dateStyle: "medium", timeStyle: "short" })}>
            {format.relativeTime(member.lastEditedAt, now)}
          </time>
        ) : (
          <span className="text-fg-faint">{t("neverEdited")}</span>
        )}
      </td>
      <td className="px-1 py-2.5 text-right">
        {(canRemove || canTransfer) && (
          <>
            <IconButton
              ref={menu.ref}
              label={t("actionsFor", { name: member.name })}
              onClick={menu.toggle}
              disabled={pending}
            >
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
            {/* Portaled so the table's scroll container doesn't clip it. */}
            <Floating anchor={menu.el} open={menu.open} onClose={menu.close} align="end" className="text-left">
              {canTransfer && (
                <MenuItem
                  onClick={() => {
                    menu.close();
                    setConfirm("transfer");
                  }}
                >
                  {t("transfer")}
                </MenuItem>
              )}
              {canRemove && (
                <MenuItem
                  danger
                  onClick={() => {
                    menu.close();
                    setConfirm("remove");
                  }}
                >
                  {isSelf ? t("leave") : tc("remove")}
                </MenuItem>
              )}
            </Floating>
          </>
        )}
        <Dialog open={confirm !== null} onClose={() => setConfirm(null)} className="max-w-md text-left">
          <div className="space-y-3 p-5">
            <h2 className="text-base font-semibold">
              {confirm === "transfer"
                ? t("transferTitle", { name: member.name })
                : isSelf
                  ? t("leaveTitle")
                  : t("removeTitle", { name: member.name })}
            </h2>
            <p className="text-sm text-fg-muted">
              {confirm === "transfer" ? t("transferBody", { name: member.name }) : isSelf ? t("leaveBody") : t("removeBody", { name: member.name })}
            </p>
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                {tc("cancel")}
              </Button>
              <Button
                variant={confirm === "transfer" ? "primary" : "danger"}
                disabled={pending}
                onClick={() =>
                  confirm === "transfer"
                    ? run(() => transferOwnershipAction(workspaceId, member.userId), () => setConfirm(null))
                    : run(
                        () => removeMemberAction(workspaceId, member.userId),
                        () => {
                          setConfirm(null);
                          if (isSelf) {
                            router.push("/");
                            router.refresh();
                          }
                        },
                      )
                }
              >
                {confirm === "transfer" ? t("transferConfirm") : isSelf ? t("leave") : tc("remove")}
              </Button>
            </div>
          </div>
        </Dialog>
      </td>
    </tr>
  );
}

/** "2 teamspaces", opening the list of them; a dash for guests and people in none. */
function TeamspacesCell({ name, teamspaces }: { name: string; teamspaces: MemberTeamspace[] }) {
  const t = useTranslations("settings.members");
  const list = useFloating<HTMLButtonElement>();
  if (!teamspaces.length) return <span className="text-fg-faint">—</span>;
  return (
    <>
      <button
        ref={list.ref}
        type="button"
        aria-label={t("teamspacesOf", { name })}
        aria-expanded={list.open}
        onClick={list.toggle}
        className="-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 whitespace-nowrap text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        {t("teamspaceCount", { count: teamspaces.length })}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {/* Portaled so the table's scroll container doesn't clip it. */}
      <Floating anchor={list.el} open={list.open} onClose={list.close} className="text-left">
        <ul aria-label={t("teamspacesOf", { name })} className="max-h-64 max-w-64 overflow-y-auto">
          {teamspaces.map((ts) => (
            <li key={ts.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
              <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center leading-none text-fg-muted">
                {ts.icon ?? (ts.name.trim()[0] ?? "?").toLocaleUpperCase()}
              </span>
              <span className="truncate">{ts.name}</span>
            </li>
          ))}
        </ul>
      </Floating>
    </>
  );
}

/** "2 groups", opening the list of them; a dash for guests and people in none. */
function GroupsCell({ name, groups }: { name: string; groups: MemberGroup[] }) {
  const t = useTranslations("settings.members");
  const list = useFloating<HTMLButtonElement>();
  if (!groups.length) return <span className="text-fg-faint">—</span>;
  return (
    <>
      <button
        ref={list.ref}
        type="button"
        aria-label={t("groupsOf", { name })}
        aria-expanded={list.open}
        onClick={list.toggle}
        className="-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 whitespace-nowrap text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        {t("groupCount", { count: groups.length })}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {/* Portaled so the table's scroll container doesn't clip it. */}
      <Floating anchor={list.el} open={list.open} onClose={list.close} className="text-left">
        <ul aria-label={t("groupsOf", { name })} className="max-h-64 max-w-64 overflow-y-auto">
          {groups.map((group) => (
            <li key={group.id} className="truncate rounded px-2 py-1.5 text-sm">
              {group.name}
            </li>
          ))}
        </ul>
      </Floating>
    </>
  );
}

function InvitationsTable({
  now,
  workspaceId,
  invitations,
  empty,
}: {
  now: Date;
  workspaceId: string;
  invitations: Invitation[];
  empty: string;
}) {
  const t = useTranslations("settings.members");
  if (!invitations.length) return <p className="px-4 py-8 text-center text-sm text-fg-muted">{empty}</p>;
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 text-left font-normal">
              {t("columns.email")}
            </th>
            <th scope="col" className="w-36 px-4 py-2.5 text-left font-normal">
              {t("columns.role")}
            </th>
            <th scope="col" className="w-48 px-4 py-2.5 text-left font-normal">
              {t("columns.status")}
            </th>
            <th scope="col" className="w-64">
              <span className="sr-only">{t("columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {invitations.map((invitation) => (
            <InvitationRow key={invitation.id} now={now} workspaceId={workspaceId} invitation={invitation} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvitationRow({ now, workspaceId, invitation }: { now: Date; workspaceId: string; invitation: Invitation }) {
  const t = useTranslations("settings.members");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const expired = invitation.expiresAt.getTime() <= now.getTime();

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="truncate font-medium">{invitation.email}</div>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </td>
      <td className="px-4 py-3 text-fg-muted">{t(`roles.${invitation.role}`)}</td>
      <td className={cn("px-4 py-3", expired ? "text-danger" : "text-fg-muted")}>
        {expired ? t("expired") : t("expires", { date: format.dateTime(invitation.expiresAt, { dateStyle: "medium" }) })}
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-2">
          {!expired && <CopyButton value={invitation.link} label={t("copyLink")} />}
          <Button
            size="sm"
            className="whitespace-nowrap"
            disabled={pending}
            onClick={() => run(() => revokeInvitationAction(workspaceId, invitation.id))}
          >
            {t("cancelInvitation")}
          </Button>
        </div>
      </td>
    </tr>
  );
}

function AddMembersDialog({
  workspaceId,
  open,
  onClose,
  canPickRole,
  asks,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Owners choose the role; members add members only. */
  canPickRole: boolean;
  /** The workspace wants the viewer's additions approved by an owner first. */
  asks: boolean;
}) {
  const t = useTranslations("settings.members");
  const tc = useTranslations("common");
  const tErrors = useTranslations("settings.errors");
  const [text, setText] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [results, setResults] = useState<BulkAddResult[] | null>(null);
  const { pending, error, run } = useAction();
  const count = parseEmailList(text).length;
  const tooMany = count > MAX_BULK_EMAILS;

  function close() {
    setText("");
    setRole("member");
    setResults(null);
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} className="max-w-lg">
      {results ? (
        <div className="space-y-3 p-5">
          <h2 className="text-base font-semibold">{t("add.resultsTitle")}</h2>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {results.map((r) => (
              <li key={r.email} className="space-y-1.5 px-3 py-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-medium">{r.email}</span>
                  <span className={cn("shrink-0 text-xs", r.kind === "error" ? "text-danger" : "text-fg-muted")}>
                    {r.kind === "added"
                      ? t("add.added")
                      : r.kind === "invited"
                        ? t(r.delivery === "sent" ? "add.emailed" : r.delivery === "failed" ? "add.emailFailed" : "add.linkOnly")
                        : r.kind === "requested"
                          ? t("add.requested")
                          : tErrors(r.code)}
                  </span>
                </div>
                {r.kind === "invited" && r.delivery !== "sent" && (
                  <div className="flex items-center gap-2">
                    <Input readOnly value={r.link} onFocus={(e) => e.currentTarget.select()} aria-label={t("inviteLink")} />
                    <CopyButton value={r.link} label={t("copyLink")} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-fg-muted">{asks ? t("add.requestedNote") : t("add.linkValidity")}</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setText("");
                setResults(null);
              }}
            >
              {t("add.addMore")}
            </Button>
            <Button variant="primary" onClick={close}>
              {tc("close")}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!count || tooMany) return;
            run(() => addMembersAction(workspaceId, parseEmailList(text), role), setResults);
          }}
        >
          <h2 className="text-base font-semibold">{t("add.title")}</h2>
          <p className="text-sm text-fg-muted">{asks ? t("add.descriptionAsks") : t("add.description")}</p>
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{t("add.emailsLabel")}</span>
            <textarea
              autoFocus
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("add.emailsPlaceholder")}
              className="w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent"
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <span className={cn("text-xs", tooMany ? "text-danger" : "text-fg-muted")}>
              {tooMany ? tErrors("tooManyEmails") : t("add.count", { count })}
            </span>
            {canPickRole && (
              <label className="flex items-center gap-2 text-sm text-fg-muted">
                {t("roleLabel")}
                <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
                  <option value="member">{t("roles.member")}</option>
                  <option value="owner">{t("roles.owner")}</option>
                  <option value="guest">{t("roles.guest")}</option>
                </select>
              </label>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !count || tooMany}>
              {pending ? t("add.submitting") : asks ? t("add.submitAsk") : t("add.submit")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

const SOURCE_KEYS = { domain: "domain", link: "link", switcher: "switcher", member: "member" } as const;

/** Settings > Members > Requests: people asking to join, and members asking to invite someone. Owners only. */
function RequestsTable({
  now,
  workspaceId,
  requests,
  empty,
}: {
  now: Date;
  workspaceId: string;
  requests: JoinRequestItem[];
  empty: string;
}) {
  const t = useTranslations("settings.members");
  if (!requests.length) return <p className="px-4 py-8 text-center text-sm text-fg-muted">{empty}</p>;
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 text-left font-normal">
              {t("columns.user")}
            </th>
            <th scope="col" className="w-56 px-4 py-2.5 text-left font-normal">
              {t("columns.request")}
            </th>
            <th scope="col" className="w-32 px-4 py-2.5 text-left font-normal">
              {t("columns.asked")}
            </th>
            <th scope="col" className="w-48">
              <span className="sr-only">{t("columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {requests.map((request) => (
            <RequestRow key={request.id} now={now} workspaceId={workspaceId} request={request} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequestRow({ now, workspaceId, request }: { now: Date; workspaceId: string; request: JoinRequestItem }) {
  const t = useTranslations("settings.members");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const joining = request.kind === "join";
  // Someone asking to join is shown as themselves; for an invitation, the address to invite.
  const name = joining ? request.askerName || request.email : request.email;

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <UserAvatar name={name} image={joining ? request.askerImage : null} size="md" />
          <div className="min-w-0">
            <div className="truncate font-medium">{name}</div>
            {joining && request.askerName && <div className="truncate text-xs text-fg-muted">{request.email}</div>}
          </div>
        </div>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </td>
      <td className="px-4 py-3 text-fg-muted">
        {joining
          ? t("requests.join", { source: t(`requests.sources.${SOURCE_KEYS[request.source ?? "switcher"]}`) })
          : t("requests.invite", { name: request.askerName || request.askerEmail || t("requests.someone") })}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
        <time
          dateTime={request.createdAt.toISOString()}
          title={format.dateTime(request.createdAt, { dateStyle: "medium", timeStyle: "short" })}
        >
          {format.relativeTime(request.createdAt, now)}
        </time>
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={pending} onClick={() => run(() => declineJoinRequestAction(workspaceId, request.id))}>
            {t("requests.decline")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={pending}
            onClick={() => run(() => approveJoinRequestAction(workspaceId, request.id))}
          >
            {t("requests.approve")}
          </Button>
        </div>
      </td>
    </tr>
  );
}
