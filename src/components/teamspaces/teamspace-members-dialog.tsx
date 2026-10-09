"use client";

import { Search, UsersRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import {
  addTeamspaceGroupsAction,
  addTeamspaceMembersAction,
  listTeamspaceGroupsAction,
  listTeamspaceMembersAction,
  removeTeamspaceGroupAction,
  removeTeamspaceMemberAction,
  setTeamspaceRoleAction,
} from "@/app/actions/teamspaces";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, IconButton, Input, selectClass } from "@/components/ui";
import type { TeamspaceRole } from "@/db/schema/app";
import type { TeamspaceGroupSummary, TeamspacePerson, TeamspaceSummary } from "@/server/teamspaces";
import { searchFold } from "@/lib/search-fold";

type WorkspacePerson = { userId: string; name: string; email: string; role: "owner" | "member" | "guest" };

/**
 * Who is in a teamspace: people, and groups whose members are all in it. Its managers change
 * roles, remove people and add owners and members of the workspace or its groups; everyone else
 * sees the lists. A default teamspace has everyone in it, so there it only picks owners.
 */
export function TeamspaceMembersDialog({
  workspaceId,
  teamspace,
  open,
  onClose,
  workspaceMembers,
  currentUserId,
  onChanged,
}: {
  workspaceId: string;
  teamspace: TeamspaceSummary;
  open: boolean;
  onClose: () => void;
  /** Everyone in the workspace; guests are left out of the picker. */
  workspaceMembers: WorkspacePerson[];
  currentUserId: string;
  /** After any change, e.g. to refresh member counts. */
  onChanged?: () => void;
}) {
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <MembersBody
        workspaceId={workspaceId}
        teamspace={teamspace}
        onClose={onClose}
        workspaceMembers={workspaceMembers}
        currentUserId={currentUserId}
        onChanged={onChanged}
      />
    </Dialog>
  );
}

function matches(query: string, ...values: string[]) {
  const q = searchFold(query.trim());
  return !q || values.some((v) => searchFold(v).includes(q));
}

function MembersBody({
  workspaceId,
  teamspace,
  onClose,
  workspaceMembers,
  currentUserId,
  onChanged,
}: {
  workspaceId: string;
  teamspace: TeamspaceSummary;
  onClose: () => void;
  workspaceMembers: WorkspacePerson[];
  currentUserId: string;
  onChanged?: () => void;
}) {
  const t = useTranslations("teamspaces");
  const tc = useTranslations("common");
  const [people, setPeople] = useState<TeamspacePerson[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const { pending, error, run } = useAction();
  const isDefault = teamspace.access === "default";
  const canManage = teamspace.canManage;

  useEffect(() => {
    let cancelled = false;
    listTeamspaceMembersAction(teamspace.id)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPeople(result.data);
          setLoadError(null);
        } else setLoadError(result.error);
      })
      .catch(() => !cancelled && setLoadError(tc("genericError")));
    return () => {
      cancelled = true;
    };
  }, [teamspace.id, version, tc]);

  function changed() {
    setVersion((v) => v + 1);
    onChanged?.();
  }

  return (
    <div className="space-y-4 p-5">
      <div className="space-y-1">
        <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">
          {teamspace.icon && <span className="leading-none">{teamspace.icon}</span>}
          <span className="truncate">{t("members.title", { name: teamspace.name })}</span>
        </h2>
        {(isDefault || !canManage) && (
          <p className="text-sm text-fg-muted">{isDefault ? t("members.everyone") : t("members.readOnly")}</p>
        )}
      </div>

      {canManage && !isDefault && people && (
        <AddPeople
          workspaceId={workspaceId}
          teamspaceId={teamspace.id}
          candidates={workspaceMembers.filter((m) => m.role !== "guest" && !people.some((p) => p.userId === m.userId))}
          pending={pending}
          run={run}
          onAdded={changed}
        />
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
      {loadError && <p className="text-xs text-danger">{loadError}</p>}

      {people === null ? (
        !loadError && <p className="py-6 text-center text-sm text-fg-muted">{tc("loading")}</p>
      ) : people.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-muted">{t("members.empty")}</p>
      ) : (
        <ul aria-label={t("members.list")} className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {people.map((person) => (
            <li key={person.userId} className="flex items-center gap-2.5 px-3 py-2 text-sm">
              <Avatar name={person.name || person.email} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {person.name}
                  {person.userId === currentUserId && <span className="font-normal text-fg-muted"> {t("members.you")}</span>}
                </div>
                <div className="truncate text-xs text-fg-muted">
                  {person.direct ? person.email : t("members.viaGroups", { groups: person.groups.join(", ") })}
                </div>
              </div>
              {canManage ? (
                <select
                  aria-label={t("members.roleOf", { name: person.name })}
                  className={cn(selectClass, "h-7 shrink-0")}
                  value={person.role}
                  disabled={pending}
                  onChange={(e) =>
                    run(
                      () => setTeamspaceRoleAction(workspaceId, teamspace.id, person.userId, e.target.value as TeamspaceRole),
                      changed,
                    )
                  }
                >
                  <option value="owner">{t("roles.owner")}</option>
                  <option value="member">{t("roles.member")}</option>
                </select>
              ) : (
                <span className="shrink-0 text-fg-muted">{t(`roles.${person.role}`)}</span>
              )}
              {/* Nobody leaves a default teamspace; there only the role changes. People in it through
                  a group leave with the group. */}
              {canManage && !isDefault && person.direct && (
                <IconButton
                  label={t("members.remove", { name: person.name })}
                  disabled={pending}
                  onClick={() => run(() => removeTeamspaceMemberAction(workspaceId, teamspace.id, person.userId), changed)}
                >
                  <X className="h-4 w-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}

      {!isDefault && (
        <Groups
          workspaceId={workspaceId}
          teamspaceId={teamspace.id}
          canManage={canManage}
          version={version}
          pending={pending}
          run={run}
          onChanged={changed}
        />
      )}

      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          {tc("close")}
        </Button>
      </div>
    </div>
  );
}

/** The groups in the teamspace; its managers add the workspace's groups and take them out. */
function Groups({
  workspaceId,
  teamspaceId,
  canManage,
  version,
  pending,
  run,
  onChanged,
}: {
  workspaceId: string;
  teamspaceId: string;
  canManage: boolean;
  /** Changes after every change in the dialog, to load the list again. */
  version: number;
  pending: boolean;
  run: ReturnType<typeof useAction>["run"];
  onChanged: () => void;
}) {
  const t = useTranslations("teamspaces.members");
  const [data, setData] = useState<{ groups: TeamspaceGroupSummary[]; options: { id: string; name: string }[] } | null>(null);
  const [choice, setChoice] = useState("");

  useEffect(() => {
    let cancelled = false;
    listTeamspaceGroupsAction(workspaceId, teamspaceId)
      .then((result) => !cancelled && result.ok && setData(result.data))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, teamspaceId, version]);

  if (!data) return null;
  const available = data.options.filter((o) => !data.groups.some((g) => g.id === o.id));
  // Nothing to show or do: no groups in it, and none the viewer could add.
  if (!data.groups.length && !(canManage && available.length)) return null;

  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">{t("groups")}</h3>
        <p className="text-xs text-fg-muted">{t("groupsHint")}</p>
      </div>
      {data.groups.length ? (
        <ul aria-label={t("groups")} className="divide-y divide-border rounded-md border border-border">
          {data.groups.map((group) => (
            <li key={group.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-active text-fg-muted" aria-hidden>
                <UsersRound className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{group.name}</div>
                <div className="truncate text-xs text-fg-muted">{t("groupMemberCount", { count: group.memberCount })}</div>
              </div>
              {canManage && (
                <IconButton
                  label={t("removeGroup", { name: group.name })}
                  disabled={pending}
                  onClick={() => run(() => removeTeamspaceGroupAction(workspaceId, teamspaceId, group.id), onChanged)}
                >
                  <X className="h-4 w-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">{t("noGroups")}</p>
      )}
      {canManage && available.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            aria-label={t("chooseGroup")}
            className={cn(selectClass, "min-w-0 flex-1")}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">{t("chooseGroup")}</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <Button
            disabled={pending || !choice}
            onClick={() =>
              run(
                () => addTeamspaceGroupsAction(workspaceId, teamspaceId, [choice]),
                () => {
                  setChoice("");
                  onChanged();
                },
              )
            }
          >
            {t("addGroupButton")}
          </Button>
        </div>
      )}
    </section>
  );
}

function AddPeople({
  workspaceId,
  teamspaceId,
  candidates,
  pending,
  run,
  onAdded,
}: {
  workspaceId: string;
  teamspaceId: string;
  candidates: WorkspacePerson[];
  pending: boolean;
  run: ReturnType<typeof useAction>["run"];
  onAdded: () => void;
}) {
  const t = useTranslations("teamspaces.members");
  const tr = useTranslations("teamspaces.roles");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<TeamspaceRole>("member");
  const shown = useMemo(
    () => candidates.filter((c) => matches(query, c.name, c.email)).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)),
    [candidates, query],
  );
  // People who got added meanwhile drop out of the selection.
  const chosen = selected.filter((id) => candidates.some((c) => c.userId === id));

  if (!candidates.length) return <p className="text-sm text-fg-muted">{t("noOneToAdd")}</p>;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t("add")}</h3>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
        <Input
          type="search"
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-7"
        />
      </div>
      <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {shown.length ? (
          shown.map((person) => (
            <li key={person.userId}>
              <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-bg-hover">
                <input
                  type="checkbox"
                  aria-label={t("select", { name: person.name || person.email })}
                  checked={chosen.includes(person.userId)}
                  onChange={(e) =>
                    setSelected((s) => (e.target.checked ? [...s, person.userId] : s.filter((id) => id !== person.userId)))
                  }
                  className="accent-accent"
                />
                <span className="min-w-0 flex-1 truncate">
                  {person.name}
                  <span className="text-fg-muted"> {person.email}</span>
                </span>
              </label>
            </li>
          ))
        ) : (
          <li className="px-3 py-3 text-center text-sm text-fg-muted">{t("noMatches")}</li>
        )}
      </ul>
      <div className="flex items-center justify-end gap-2">
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          {t("addAs")}
          <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value as TeamspaceRole)}>
            <option value="member">{tr("member")}</option>
            <option value="owner">{tr("owner")}</option>
          </select>
        </label>
        <Button
          variant="primary"
          disabled={pending || !chosen.length}
          onClick={() =>
            run(
              () => addTeamspaceMembersAction(workspaceId, teamspaceId, chosen, role),
              () => {
                setSelected([]);
                setQuery("");
                onAdded();
              },
            )
          }
        >
          {t("addSelected", { count: chosen.length })}
        </Button>
      </div>
    </section>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = (name.trim()[0] ?? "?").toLocaleUpperCase();
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-active text-xs font-medium text-fg-muted"
    >
      {initial}
    </span>
  );
}
