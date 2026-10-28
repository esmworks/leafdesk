"use client";

import { MoreHorizontal, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  addGroupMembersAction,
  createGroupAction,
  deleteGroupAction,
  removeGroupMemberAction,
  renameGroupAction,
} from "@/app/actions/groups";
import { Floating, useFloating } from "@/components/database/floating";
import { SettingsHeader } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, IconButton, Input, MenuItem, MenuSeparator } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { MAX_GROUP_NAME } from "@/lib/groups";
import { searchFold } from "@/lib/search-fold";
import type { WorkspaceRole } from "@/db/schema/app";
import type { GroupSummary } from "@/server/groups";

type Person = { userId: string; name: string; email: string; image: string | null; role: WorkspaceRole };

function matches(query: string, ...values: string[]) {
  const q = searchFold(query.trim());
  return !q || values.some((v) => searchFold(v).includes(q));
}

/**
 * Settings > Groups: the workspace's member groups with who is in them and the teamspaces they
 * joined. Workspace owners and membership admins create, rename and delete groups and choose their
 * members; members see them.
 */
export function GroupsPanel({
  workspaceId,
  canManage,
  ownId,
  groups,
  members,
}: {
  workspaceId: string;
  canManage: boolean;
  /** The viewer, when they may not put themselves in a group (a membership admin): left out of the pickers. */
  ownId: string | null;
  groups: GroupSummary[];
  /** Everyone in the workspace; guests are left out of the pickers. */
  members: Person[];
}) {
  const t = useTranslations("settings.groups");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Looked up by id so the dialogs follow the refreshed props after each change.
  const renaming = groups.find((g) => g.id === renamingId);
  const deleting = groups.find((g) => g.id === deletingId);
  const open = groups.find((g) => g.id === openId);
  const shown = groups.filter((g) => matches(query, g.name, ...g.members.map((m) => m.name)));

  return (
    <div>
      <SettingsHeader title={t("heading")} description={t("description")} />
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
            <Input
              type="search"
              aria-label={t("search")}
              placeholder={t("search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="ps-7 sm:w-56"
            />
          </div>
          {canManage && (
            <Button variant="primary" className="ms-auto" onClick={() => setCreating(true)}>
              {t("newButton")}
            </Button>
          )}
        </div>
        {!canManage && <p className="text-xs text-fg-muted">{t("ownersOnly")}</p>}

        <div className="overflow-hidden rounded-xl border border-border">
          {shown.length ? (
            // `relative` keeps the absolutely positioned sr-only header text inside the scroller.
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 text-start font-normal">
                      {t("columns.group")}
                    </th>
                    <th scope="col" className="w-40 px-4 py-2.5 text-start font-normal">
                      {t("columns.members")}
                    </th>
                    <th scope="col" className="w-56 px-4 py-2.5 text-start font-normal">
                      {t("columns.teamspaces")}
                    </th>
                    <th scope="col" className="w-10">
                      <span className="sr-only">{t("columns.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((group) => (
                    <GroupRow
                      key={group.id}
                      group={group}
                      canManage={canManage}
                      onOpen={() => setOpenId(group.id)}
                      onRename={() => setRenamingId(group.id)}
                      onDelete={() => setDeletingId(group.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-fg-muted">
              {groups.length ? t("noMatches") : canManage ? t("emptyOwner") : t("empty")}
            </p>
          )}
        </div>
      </div>

      {creating && <NameDialog workspaceId={workspaceId} onClose={() => setCreating(false)} />}
      {renaming && <NameDialog workspaceId={workspaceId} group={renaming} onClose={() => setRenamingId(null)} />}
      {deleting && <DeleteDialog workspaceId={workspaceId} group={deleting} onClose={() => setDeletingId(null)} />}
      {open && (
        <GroupMembersDialog
          workspaceId={workspaceId}
          group={open}
          canManage={canManage}
          members={ownId ? members.filter((m) => m.userId !== ownId) : members}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function GroupRow({
  group,
  canManage,
  onOpen,
  onRename,
  onDelete,
}: {
  group: GroupSummary;
  canManage: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("settings.groups");
  const menu = useFloating<HTMLButtonElement>();
  return (
    <tr className="align-middle">
      <td className="px-4 py-3">
        <button type="button" onClick={onOpen} className="max-w-full truncate text-start font-medium hover:underline">
          {group.name}
        </button>
        {group.provisioned && (
          <div className="truncate text-xs text-fg-muted" data-group-provisioned>
            {t("provisioned")}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <button type="button" onClick={onOpen} className="flex items-center gap-2 text-fg-muted hover:text-fg">
          <span className="flex -space-x-1.5" aria-hidden>
            {group.members.slice(0, 3).map((m) => (
              <UserAvatar key={m.userId} name={m.name || m.email} image={m.image} size="sm" className="ring-2 ring-bg" />
            ))}
          </span>
          <span className="whitespace-nowrap">{t("memberCount", { count: group.memberCount })}</span>
        </button>
      </td>
      <td className="px-4 py-3 text-fg-muted">
        {group.teamspaces.length ? (
          <span className="line-clamp-2" title={group.teamspaces.map((ts) => ts.name).join(", ")}>
            {group.teamspaces.map((ts) => ts.name).join(", ")}
          </span>
        ) : (
          <span className="text-fg-faint">—</span>
        )}
      </td>
      <td className="px-1 py-2.5 text-end">
        <IconButton ref={menu.ref} label={t("actionsFor", { name: group.name })} onClick={menu.toggle}>
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
        {/* Portaled so the table's scroll container doesn't clip it. */}
        <Floating anchor={menu.el} open={menu.open} onClose={menu.close} align="end" className="text-start">
          <MenuItem
            onClick={() => {
              menu.close();
              onOpen();
            }}
          >
            {canManage ? t("manageMembers") : t("viewMembers")}
          </MenuItem>
          {canManage && (
            <>
              <MenuItem
                onClick={() => {
                  menu.close();
                  onRename();
                }}
              >
                {t("rename")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                onClick={() => {
                  menu.close();
                  onDelete();
                }}
              >
                {t("delete")}
              </MenuItem>
            </>
          )}
        </Floating>
      </td>
    </tr>
  );
}

/** Creates a group (no `group`) or renames one. */
function NameDialog({ workspaceId, group, onClose }: { workspaceId: string; group?: GroupSummary; onClose: () => void }) {
  const t = useTranslations("settings.groups");
  const tc = useTranslations("common");
  const [name, setName] = useState(group?.name ?? "");
  const { pending, error, run } = useAction();
  const clean = name.trim();
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean || clean === group?.name) return;
          if (group) run(() => renameGroupAction(workspaceId, group.id, clean), onClose);
          else run(() => createGroupAction(workspaceId, clean), onClose);
        }}
      >
        <DialogBody className="pt-5">
          <DialogTitle>{group ? t("renameTitle") : t("createTitle")}</DialogTitle>
          <label className="block space-y-1.5">
            <span className="text-sm text-fg-muted">{t("name")}</span>
            <Input
              autoFocus
              value={name}
              maxLength={MAX_GROUP_NAME}
              placeholder={t("namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !clean || clean === group?.name}>
            {group ? (pending ? tc("saving") : tc("save")) : pending ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ workspaceId, group, onClose }: { workspaceId: string; group: GroupSummary; onClose: () => void }) {
  const t = useTranslations("settings.groups");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <DialogBody className="pt-5">
        <div className="space-y-1.5">
          <DialogTitle>{t("deleteTitle", { name: group.name })}</DialogTitle>
          <p className="text-sm text-fg-muted">{t("deleteBody")}</p>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button variant="danger" disabled={pending} onClick={() => run(() => deleteGroupAction(workspaceId, group.id), onClose)}>
          {t("delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Who is in a group; workspace owners and membership admins add and remove people. */
function GroupMembersDialog({
  workspaceId,
  group,
  canManage,
  members,
  onClose,
}: {
  workspaceId: string;
  group: GroupSummary;
  canManage: boolean;
  members: Person[];
  onClose: () => void;
}) {
  const t = useTranslations("settings.groups.members");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  const inGroup = new Set(group.members.map((m) => m.userId));
  const candidates = members.filter((m) => m.role !== "guest" && !inGroup.has(m.userId));

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogBody className="pt-5">
        <DialogTitle className="truncate">{t("title", { name: group.name })}</DialogTitle>

        {canManage && group.provisioned && <p className="text-xs text-fg-muted">{t("provisionedHint")}</p>}

        {canManage && <AddPeople candidates={candidates} pending={pending} onAdd={(ids, done) => run(() => addGroupMembersAction(workspaceId, group.id, ids), done)} />}

        {error && <p className="text-xs text-danger">{error}</p>}

        {group.members.length ? (
          <ul aria-label={t("list")} className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {group.members.map((person) => (
              <li key={person.userId} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                <UserAvatar name={person.name || person.email} image={person.image} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{person.name}</div>
                  <div className="truncate text-xs text-fg-muted">{person.email}</div>
                </div>
                {canManage && (
                  <IconButton
                    label={t("remove", { name: person.name || person.email })}
                    disabled={pending}
                    onClick={() => run(() => removeGroupMemberAction(workspaceId, group.id, person.userId))}
                  >
                    <X className="h-4 w-4" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-fg-muted">{t("empty")}</p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tc("close")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function AddPeople({
  candidates,
  pending,
  onAdd,
}: {
  candidates: Person[];
  pending: boolean;
  onAdd: (userIds: string[], done: () => void) => void;
}) {
  const t = useTranslations("settings.groups.members");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
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
        <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
        <Input
          type="search"
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ps-7"
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
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-faint">{t("guestsHint")}</span>
        <Button
          variant="primary"
          disabled={pending || !chosen.length}
          onClick={() =>
            onAdd(chosen, () => {
              setSelected([]);
              setQuery("");
            })
          }
        >
          {t("addSelected", { count: chosen.length })}
        </Button>
      </div>
    </section>
  );
}
