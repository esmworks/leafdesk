"use client";

import { Archive, ArrowDown, ArrowUp, Check, ChevronDown, KeyRound, MoreHorizontal, Search, UserRound, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  joinTeamspaceAction,
  leaveTeamspaceAction,
  setTeamspaceArchivedAction,
  updateTeamspaceAction,
} from "@/app/actions/teamspaces";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Floating, useFloating } from "@/components/database/floating";
import { SettingsHeader } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { ACCESS_OPTIONS, TeamspaceDialog } from "@/components/teamspaces/teamspace-dialog";
import { TeamspaceMembersDialog } from "@/components/teamspaces/teamspace-members-dialog";
import { Button, cn, Dialog, IconButton, Input, MenuItem, MenuSeparator, Switch } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { TeamspaceAccess } from "@/db/schema/app";
import type { TeamspaceSummary } from "@/server/teamspaces";
import { searchFold } from "@/lib/search-fold";

type Person = { userId: string; name: string; email: string; role: "owner" | "member" | "guest" };

function matches(query: string, ...values: string[]) {
  const q = searchFold(query.trim());
  return !q || values.some((v) => searchFold(v).includes(q));
}

/**
 * Settings > Teamspaces: the default teamspaces and who may create
 * teamspaces on top, then every teamspace the viewer can see, filtered and searched.
 */
export function TeamspacesPanel({
  workspaceId,
  currentUserId,
  isOwner,
  teamspaces,
  canCreate,
  teamspaceCreation,
  members,
}: {
  workspaceId: string;
  currentUserId: string;
  /** The viewer owns the workspace. */
  isOwner: boolean;
  /** Active and archived ones alike. */
  teamspaces: TeamspaceSummary[];
  canCreate: boolean;
  teamspaceCreation: "owners" | "members";
  /** Everyone in the workspace, for adding people to a teamspace. */
  members: Person[];
}) {
  const t = useTranslations("settings.teamspaces");
  const ta = useTranslations("teamspaces.access");
  const router = useRouter();
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [owner, setOwner] = useState("");
  const [access, setAccess] = useState<TeamspaceAccess | "">("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  // Looked up by id so the dialogs follow the refreshed props after each change.
  const editing = teamspaces.find((ts) => ts.id === editingId);
  const managing = teamspaces.find((ts) => ts.id === managingId);

  const active = teamspaces.filter((ts) => !ts.archivedAt);
  const archived = teamspaces.filter((ts) => ts.archivedAt);
  const inStatus = status === "active" ? active : archived;
  const owners = useMemo(() => {
    const byId = new Map<string, string>();
    for (const ts of teamspaces) for (const o of ts.owners) byId.set(o.id, o.name);
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [teamspaces]);
  const shown = inStatus
    .filter(
      (ts) =>
        matches(query, ts.name) && (!owner || ts.owners.some((o) => o.id === owner)) && (!access || ts.access === access),
    )
    .sort((a, b) => (newestFirst ? -1 : 1) * (a.updatedAt.getTime() - b.updatedAt.getTime()));

  return (
    <div>
      <SettingsHeader title={t("heading")} description={t("description")} />

      <DefaultTeamspaces workspaceId={workspaceId} isOwner={isOwner} teamspaces={active} />
      <hr className="my-6 border-border" />
      <CreationSetting workspaceId={workspaceId} value={teamspaceCreation} canEdit={isOwner} />
      <hr className="my-6 border-border" />

      <section className="space-y-3">
        <div>
          <h2 className="text-[15px] font-semibold">{t("listHeading")}</h2>
          <p className="mt-1 text-sm text-fg-muted">{t("listDescription")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <FilterMenu
            icon={<Archive className="h-3.5 w-3.5" />}
            label={t(`status.${status}`)}
            ariaLabel={t("statusFilter")}
            value={status}
            options={[
              { value: "active", label: t("status.active"), count: active.length },
              { value: "archived", label: t("status.archived"), count: archived.length },
            ]}
            onChange={(v) => setStatus(v as "active" | "archived")}
          />
          <FilterMenu
            icon={<UserRound className="h-3.5 w-3.5" />}
            label={owners.find((o) => o.id === owner)?.name ?? t("ownerFilter")}
            ariaLabel={t("ownerFilter")}
            value={owner}
            highlighted={owner !== ""}
            options={[{ value: "", label: t("anyOwner") }, ...owners.map((o) => ({ value: o.id, label: o.name }))]}
            onChange={setOwner}
          />
          <FilterMenu
            icon={<KeyRound className="h-3.5 w-3.5" />}
            label={access ? ta(access) : t("accessFilter")}
            ariaLabel={t("accessFilter")}
            value={access}
            highlighted={access !== ""}
            options={[{ value: "", label: t("anyAccess") }, ...ACCESS_OPTIONS.map((a) => ({ value: a, label: ta(a) }))]}
            onChange={(v) => setAccess(v as TeamspaceAccess | "")}
          />
          <div className="ml-auto flex items-center gap-2">
            {searching || query ? (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
                <Input
                  type="search"
                  autoFocus
                  aria-label={t("search")}
                  placeholder={t("search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onBlur={() => setSearching(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setQuery("");
                      setSearching(false);
                    }
                  }}
                  className="w-44 pl-7 sm:w-56"
                />
              </div>
            ) : (
              <IconButton label={t("search")} onClick={() => setSearching(true)} className="h-8 w-8">
                <Search className="h-4 w-4" />
              </IconButton>
            )}
            {canCreate && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t("newButton")}
              </Button>
            )}
          </div>
        </div>

        {shown.length ? (
          // `relative` keeps the absolutely positioned sr-only header text inside the scroller.
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-y border-border text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-2 py-2 text-left font-normal">
                    {t("columns.teamspace")}
                  </th>
                  <th scope="col" className="w-48 px-2 py-2 text-left font-normal">
                    {t("columns.owners")}
                  </th>
                  <th scope="col" className="w-36 px-2 py-2 text-left font-normal">
                    {t("columns.access")}
                  </th>
                  <th
                    scope="col"
                    className="w-28 px-2 py-2 text-left font-normal"
                    aria-sort={newestFirst ? "descending" : "ascending"}
                  >
                    <button
                      type="button"
                      onClick={() => setNewestFirst((v) => !v)}
                      className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:bg-bg-hover hover:text-fg"
                    >
                      {t("columns.updated")}
                      {newestFirst ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
                    </button>
                  </th>
                  <th scope="col" className="w-10">
                    <span className="sr-only">{t("columns.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-b border-border">
                {shown.map((ts) => (
                  <TeamspaceRow
                    key={ts.id}
                    workspaceId={workspaceId}
                    teamspace={ts}
                    isOwner={isOwner}
                    onEdit={() => setEditingId(ts.id)}
                    onMembers={() => setManagingId(ts.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-y border-border px-2 py-8 text-center text-sm text-fg-muted">
            {inStatus.length ? t("noMatches") : status === "active" ? t("empty") : t("emptyArchived")}
          </p>
        )}
      </section>

      <TeamspaceDialog
        workspaceId={workspaceId}
        open={creating}
        onClose={() => setCreating(false)}
        isWorkspaceOwner={isOwner}
      />
      {editing && (
        <TeamspaceDialog
          workspaceId={workspaceId}
          open
          onClose={() => setEditingId(null)}
          teamspace={editing}
          isWorkspaceOwner={isOwner}
        />
      )}
      {managing && (
        <TeamspaceMembersDialog
          workspaceId={workspaceId}
          teamspace={managing}
          open
          onClose={() => setManagingId(null)}
          workspaceMembers={members}
          currentUserId={currentUserId}
          onChanged={() => router.refresh()}
        />
      )}
    </div>
  );
}

/** A filter button in the toolbar ("Active ▾", "Owner ▾") with its choices in a menu. */
function FilterMenu({
  icon,
  label,
  ariaLabel,
  value,
  options,
  onChange,
  highlighted,
}: {
  icon: React.ReactNode;
  label: string;
  ariaLabel: string;
  value: string;
  options: { value: string; label: string; count?: number }[];
  onChange: (value: string) => void;
  /** A filter is set: shown in the accent color. */
  highlighted?: boolean;
}) {
  const menu = useFloating<HTMLButtonElement>();
  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        aria-label={`${ariaLabel}: ${label}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        className={cn(
          "inline-flex h-8 max-w-48 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-bg-hover",
          highlighted ? "text-accent" : "text-fg-muted hover:text-fg",
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
      <Floating anchor={menu.el} open={menu.open} onClose={menu.close}>
        {options.map((o) => (
          <MenuItem
            key={o.value}
            icon={o.value === value ? <Check className="h-3.5 w-3.5" /> : <span />}
            onClick={() => {
              menu.close();
              onChange(o.value);
            }}
          >
            {o.label}
            {o.count !== undefined && <span className="ml-1.5 text-fg-faint tabular-nums">{o.count}</span>}
          </MenuItem>
        ))}
      </Floating>
    </>
  );
}

function TeamspaceBadge({ teamspace, size = "md" }: { teamspace: Pick<TeamspaceSummary, "icon" | "name">; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-bg-active leading-none font-medium text-fg-muted",
        size === "sm" ? "h-5 w-5 text-xs" : "h-7 w-7 text-sm",
      )}
    >
      {teamspace.icon ?? (teamspace.name.trim()[0] ?? "?").toLocaleUpperCase()}
    </span>
  );
}

type PendingConfirm = "leave" | "archive" | { access: TeamspaceAccess } | null;

function TeamspaceRow({
  workspaceId,
  teamspace,
  isOwner,
  onEdit,
  onMembers,
}: {
  workspaceId: string;
  teamspace: TeamspaceSummary;
  isOwner: boolean;
  onEdit: () => void;
  onMembers: () => void;
}) {
  const t = useTranslations("settings.teamspaces");
  const ta = useTranslations("teamspaces.access");
  const tt = useTranslations("teamspaces");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const menu = useFloating<HTMLButtonElement>();
  const accessMenu = useFloating<HTMLButtonElement>();
  const { pending, error, run } = useAction();
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [firstOwner, ...otherOwners] = teamspace.owners;
  const done = () => {
    setConfirm(null);
    router.refresh();
  };
  const pick = (action: () => void) => () => {
    menu.close();
    action();
  };
  // Like the edit dialog: which teamspaces everyone is in is the workspace owners' call.
  const accessOptions = ACCESS_OPTIONS.filter((a) => a !== "default" || isOwner || teamspace.access === "default");
  const canChangeAccess = teamspace.canManage && !teamspace.archivedAt && (isOwner || teamspace.access !== "default");
  const changeAccess = (next: TeamspaceAccess) =>
    run(() => updateTeamspaceAction(workspaceId, teamspace.id, { access: next }), done);

  return (
    <tr className="align-middle">
      <td className="px-2 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5" title={teamspace.description || undefined}>
          <TeamspaceBadge teamspace={teamspace} />
          <div className="min-w-0">
            <div className="truncate">{teamspace.name}</div>
            <div className="truncate text-xs text-fg-muted">
              {t("memberCount", { count: teamspace.memberCount })}
              {teamspace.joined && <> · {t("joined")}</>}
            </div>
          </div>
        </div>
        {error && !confirm && <p className="mt-1 text-xs text-danger">{error}</p>}
      </td>
      <td className="max-w-48 px-2 py-2.5">
        {firstOwner ? (
          <div
            className="flex min-w-0 items-center gap-2"
            title={teamspace.owners.map((o) => o.name).join(", ")}
          >
            <UserAvatar name={firstOwner.name} image={firstOwner.image} size="xs" />
            <span className="truncate">{firstOwner.name}</span>
            {otherOwners.length > 0 && <span className="shrink-0 text-fg-muted">+{otherOwners.length}</span>}
          </div>
        ) : (
          <span className="text-fg-faint">{t("noOwners")}</span>
        )}
      </td>
      <td className="px-2 py-2.5 whitespace-nowrap">
        {canChangeAccess ? (
          <>
            <button
              ref={accessMenu.ref}
              type="button"
              aria-label={t("accessFor", { name: teamspace.name })}
              aria-haspopup="menu"
              aria-expanded={accessMenu.open}
              disabled={pending}
              onClick={accessMenu.toggle}
              className="-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              {ta(teamspace.access)}
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </button>
            <Floating anchor={accessMenu.el} open={accessMenu.open} onClose={accessMenu.close} className="w-72">
              {accessOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    accessMenu.close();
                    if (option === teamspace.access) return;
                    // Everyone joins or may leave: say so first, as the edit dialog does.
                    if (option === "default" || teamspace.access === "default") setConfirm({ access: option });
                    else changeAccess(option);
                  }}
                  className="flex w-full gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{ta(option)}</span>
                    <span className="block text-xs whitespace-normal text-fg-muted">{tt(`accessHint.${option}`)}</span>
                  </span>
                  {option === teamspace.access && <Check className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />}
                </button>
              ))}
            </Floating>
          </>
        ) : (
          <span className="text-fg-muted">{ta(teamspace.access)}</span>
        )}
      </td>
      <td className="px-2 py-2.5 whitespace-nowrap text-fg-muted">
        <time
          dateTime={teamspace.updatedAt.toISOString()}
          title={format.dateTime(teamspace.updatedAt, { dateStyle: "medium", timeStyle: "short" })}
        >
          {format.dateTime(teamspace.updatedAt, { dateStyle: "short" })}
        </time>
      </td>
      <td className="px-1 py-2 text-right">
        <IconButton ref={menu.ref} label={t("actionsFor", { name: teamspace.name })} onClick={menu.toggle} disabled={pending}>
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
        {/* Portaled so the table's scroll container doesn't clip it. */}
        <Floating anchor={menu.el} open={menu.open} onClose={menu.close} align="end" className="text-left">
          {teamspace.canManage && <MenuItem onClick={pick(onEdit)}>{t("edit")}</MenuItem>}
          <MenuItem onClick={pick(onMembers)}>{teamspace.canManage ? t("manageMembers") : t("viewMembers")}</MenuItem>
          {(teamspace.canJoin || teamspace.canLeave || teamspace.canManage) && <MenuSeparator />}
          {teamspace.canJoin && (
            <MenuItem onClick={pick(() => run(() => joinTeamspaceAction(workspaceId, teamspace.id), done))}>{t("join")}</MenuItem>
          )}
          {teamspace.canLeave && <MenuItem onClick={pick(() => setConfirm("leave"))}>{t("leave")}</MenuItem>}
          {teamspace.canManage &&
            (teamspace.archivedAt ? (
              <MenuItem
                onClick={pick(() => run(() => setTeamspaceArchivedAction(workspaceId, teamspace.id, false), done))}
              >
                {t("restore")}
              </MenuItem>
            ) : (
              <MenuItem danger onClick={pick(() => setConfirm("archive"))}>
                {t("archive")}
              </MenuItem>
            ))}
        </Floating>
        <Dialog open={confirm !== null} onClose={() => setConfirm(null)} className="max-w-md text-left">
          {confirm && (
            <div className="space-y-3 p-5">
              <h2 className="text-base font-semibold">
                {typeof confirm === "object"
                  ? t("accessConfirmTitle", { name: teamspace.name, access: ta(confirm.access) })
                  : confirm === "leave"
                    ? t("leaveTitle", { name: teamspace.name })
                    : t("archiveTitle", { name: teamspace.name })}
              </h2>
              <p className="text-sm text-fg-muted">
                {typeof confirm === "object"
                  ? tt(confirm.access === "default" ? "dialog.becomesDefault" : "dialog.leavesDefault")
                  : confirm === "leave"
                    ? t("leaveBody")
                    : t("archiveBody")}
              </p>
              {error && <p className="text-xs text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirm(null)}>
                  {tc("cancel")}
                </Button>
                <Button
                  variant={typeof confirm === "object" ? "primary" : "danger"}
                  disabled={pending}
                  onClick={() =>
                    typeof confirm === "object"
                      ? changeAccess(confirm.access)
                      : confirm === "leave"
                        ? run(() => leaveTeamspaceAction(workspaceId, teamspace.id), done)
                        : run(() => setTeamspaceArchivedAction(workspaceId, teamspace.id, true), done)
                  }
                >
                  {typeof confirm === "object" ? t("accessConfirm") : confirm === "leave" ? t("leave") : t("archive")}
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </td>
    </tr>
  );
}

/**
 * The teamspaces everyone is in. Being in them is implicit (for everyone who joins later too), so
 * there is nothing to sync: owners pick them in the field and apply the change with Update.
 */
function DefaultTeamspaces({
  workspaceId,
  isOwner,
  teamspaces,
}: {
  workspaceId: string;
  isOwner: boolean;
  /** The active teamspaces. */
  teamspaces: TeamspaceSummary[];
}) {
  const t = useTranslations("settings.teamspaces.defaults");
  const tc = useTranslations("common");
  const router = useRouter();
  const { pending, error, run } = useAction();
  const add = useFloating<HTMLButtonElement>();
  const [confirming, setConfirming] = useState(false);
  const current = teamspaces.filter((ts) => ts.access === "default");
  const currentIds = current.map((ts) => ts.id).join();
  // The picked ones, until Update; reset whenever the saved ones change.
  const [picked, setPicked] = useState<{ base: string; ids: string[] }>({ base: currentIds, ids: current.map((ts) => ts.id) });
  const ids = picked.base === currentIds ? picked.ids : current.map((ts) => ts.id);
  const setIds = (next: string[]) => setPicked({ base: currentIds, ids: next });
  const selected = ids.map((id) => teamspaces.find((ts) => ts.id === id)).filter((ts) => ts !== undefined);
  // Private ones stay out: making one default would show it to everyone.
  const candidates = teamspaces.filter(
    (ts) => !ids.includes(ts.id) && (ts.access === "default" || (ts.access !== "private" && ts.canManage)),
  );
  const added = selected.filter((ts) => ts.access !== "default");
  const removed = current.filter((ts) => !ids.includes(ts.id));
  const dirty = added.length > 0 || removed.length > 0;
  const names = (list: TeamspaceSummary[]) => list.map((ts) => ts.name).join(", ");

  function update() {
    run(
      async () => {
        for (const ts of added) {
          const result = await updateTeamspaceAction(workspaceId, ts.id, { access: "default" });
          if (!result.ok) return result;
        }
        for (const ts of removed) {
          const result = await updateTeamspaceAction(workspaceId, ts.id, { access: "open" });
          if (!result.ok) return result;
        }
        return { ok: true as const, data: undefined };
      },
      () => {
        setConfirming(false);
        router.refresh();
      },
    );
  }

  return (
    <section>
      <h2 className="text-[15px] font-semibold">{t("heading")}</h2>
      <p className="mt-1 text-sm text-fg-muted">{t("description")}</p>
      <div className="mt-3 flex items-start gap-2">
        <div
          className={cn(
            "flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-border bg-bg-subtle px-1.5 py-1",
          )}
        >
          {selected.map((ts) => (
            <span key={ts.id} className="inline-flex h-6 max-w-full items-center gap-1.5 rounded bg-bg-active pr-0.5 pl-1.5 text-sm">
              <TeamspaceBadge teamspace={ts} size="sm" />
              <span className="truncate">{ts.name}</span>
              {isOwner && (
                <button
                  type="button"
                  aria-label={t("removeFor", { name: ts.name })}
                  title={t("removeFor", { name: ts.name })}
                  disabled={pending}
                  onClick={() => setIds(ids.filter((id) => id !== ts.id))}
                  className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
          {isOwner && candidates.length > 0 ? (
            <>
              <button
                ref={add.ref}
                type="button"
                aria-haspopup="menu"
                aria-expanded={add.open}
                disabled={pending}
                onClick={add.toggle}
                className="h-6 min-w-24 flex-1 rounded px-1 text-left text-sm text-fg-faint hover:text-fg-muted"
              >
                {t("addPlaceholder")}
              </button>
              <Floating anchor={add.el} open={add.open} onClose={add.close}>
                {candidates.map((ts) => (
                  <MenuItem
                    key={ts.id}
                    icon={<TeamspaceBadge teamspace={ts} size="sm" />}
                    onClick={() => {
                      add.close();
                      setIds([...ids, ts.id]);
                    }}
                  >
                    {ts.name}
                  </MenuItem>
                ))}
              </Floating>
            </>
          ) : (
            selected.length === 0 && <span className="px-1 text-sm text-fg-faint">{t("empty")}</span>
          )}
        </div>
        {isOwner && (
          <Button variant="primary" className="h-9" disabled={!dirty || pending} onClick={() => setConfirming(true)}>
            {t("update")}
          </Button>
        )}
      </div>
      {error && !confirming && <p className="mt-2 text-xs text-danger">{error}</p>}
      <Dialog open={confirming} onClose={() => setConfirming(false)} className="max-w-md">
        <div className="space-y-3 p-5">
          <h2 className="text-base font-semibold">{t("confirmTitle")}</h2>
          {added.length > 0 && (
            <p className="text-sm text-fg-muted">
              <span className="font-medium text-fg">{t("confirmAdd", { names: names(added) })}</span> {t("makeBody")}
            </p>
          )}
          {removed.length > 0 && (
            <p className="text-sm text-fg-muted">
              <span className="font-medium text-fg">{t("confirmRemove", { names: names(removed) })}</span> {t("removeBody")}
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {tc("cancel")}
            </Button>
            <Button variant="primary" disabled={pending} onClick={update}>
              {t("update")}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

/** Who may create teamspaces. Owners change it; members see what is set. */
function CreationSetting({
  workspaceId,
  value: initial,
  canEdit,
}: {
  workspaceId: string;
  value: "owners" | "members";
  canEdit: boolean;
}) {
  const t = useTranslations("settings.teamspaces.creation");
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const { pending, error, run } = useAction();

  return (
    <div className="flex items-center gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t("title")}</div>
        <div className="mt-1 text-sm text-fg-muted">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : (
            <>
              {t("description")}
              {!canEdit && <> {t("ownersOnly")}</>}
            </>
          )}
        </div>
      </div>
      <Switch
        checked={value === "owners"}
        label={t("title")}
        disabled={!canEdit || pending}
        onChange={(ownersOnly) => {
          const next = ownersOnly ? "owners" : "members";
          const previous = value;
          setValue(next);
          run(async () => {
            const result = await updateWorkspaceSettingsAction(workspaceId, { teamspaceCreation: next });
            if (!result.ok) setValue(previous);
            else router.refresh();
            return result;
          });
        }}
      />
    </div>
  );
}
