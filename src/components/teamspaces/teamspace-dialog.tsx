"use client";

import { SmilePlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createTeamspaceAction, updateTeamspaceAction } from "@/app/actions/teamspaces";
import { IconPicker } from "@/components/page/icon-picker";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, Input, selectClass, textareaClass } from "@/components/ui";
import type { TeamspaceAccess, TeamspaceMemberLevel } from "@/db/schema/app";
import type { TeamspaceSummary } from "@/server/teamspaces";

// Same limits as the server, which trims silently; the inputs stop earlier instead.
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

// Widest to narrowest; kept here so the client bundle doesn't pull in the database schema.
export const ACCESS_OPTIONS: readonly TeamspaceAccess[] = ["default", "open", "closed", "private"];
export const MEMBER_LEVEL_OPTIONS: readonly TeamspaceMemberLevel[] = ["full", "edit", "comment", "view"];

/** Creates a teamspace, or edits `teamspace` when given. Mounts its form only while open. */
export function TeamspaceDialog({
  workspaceId,
  open,
  onClose,
  teamspace,
  isWorkspaceOwner,
  onSaved,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Edit this teamspace instead of creating one. */
  teamspace?: TeamspaceSummary;
  isWorkspaceOwner: boolean;
  /** After saving, with the teamspace's id (the new one's when creating). */
  onSaved?: (id: string) => void;
}) {
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <TeamspaceForm
        workspaceId={workspaceId}
        teamspace={teamspace}
        isWorkspaceOwner={isWorkspaceOwner}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Dialog>
  );
}

function TeamspaceForm({
  workspaceId,
  teamspace,
  isWorkspaceOwner,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  teamspace?: TeamspaceSummary;
  isWorkspaceOwner: boolean;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const t = useTranslations("teamspaces");
  const tc = useTranslations("common");
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [name, setName] = useState(teamspace?.name ?? "");
  const [icon, setIcon] = useState<string | null>(teamspace?.icon ?? null);
  const [description, setDescription] = useState(teamspace?.description ?? "");
  const [access, setAccess] = useState<TeamspaceAccess>(teamspace?.access ?? "open");
  const [memberLevel, setMemberLevel] = useState<TeamspaceMemberLevel>(teamspace?.memberLevel ?? "full");
  const [topLevelLocked, setTopLevelLocked] = useState(teamspace?.topLevelLocked ?? false);

  // Making a teamspace default, or one default no longer, changes everyone's sidebar: owners only.
  const accessLocked = !isWorkspaceOwner && teamspace?.access === "default";
  // So does what everyone gets in a teamspace everyone is in.
  const memberLocked = !isWorkspaceOwner && (teamspace?.access === "default" || access === "default");
  const options = ACCESS_OPTIONS.filter((a) => a !== "default" || isWorkspaceOwner || teamspace?.access === "default");
  const initialAccess = teamspace?.access ?? "open";
  const accessNote =
    teamspace && access !== initialAccess
      ? access === "default"
        ? t("dialog.becomesDefault")
        : initialAccess === "default"
          ? t("dialog.leavesDefault")
          : null
      : null;

  function saved(id: string) {
    onSaved?.(id);
    router.refresh();
    onClose();
  }

  function submit() {
    const cleanName = name.trim();
    if (!cleanName) return;
    const cleanDescription = description.trim();
    if (!teamspace) {
      run(
        () => createTeamspaceAction(workspaceId, { name: cleanName, icon, description: cleanDescription, access, memberLevel }),
        (data) => saved(data.id),
      );
      return;
    }
    // Only what changed, so an unchanged access never needs a workspace owner.
    const patch: {
      name?: string;
      icon?: string | null;
      description?: string;
      access?: TeamspaceAccess;
      memberLevel?: TeamspaceMemberLevel;
      topLevelLocked?: boolean;
    } = {};
    if (cleanName !== teamspace.name) patch.name = cleanName;
    if (icon !== teamspace.icon) patch.icon = icon;
    if (cleanDescription !== teamspace.description) patch.description = cleanDescription;
    if (access !== teamspace.access) patch.access = access;
    if (memberLevel !== teamspace.memberLevel) patch.memberLevel = memberLevel;
    if (topLevelLocked !== teamspace.topLevelLocked) patch.topLevelLocked = topLevelLocked;
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    run(() => updateTeamspaceAction(workspaceId, teamspace.id, patch), () => saved(teamspace.id));
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <DialogHeader title={teamspace ? t("dialog.editTitle") : t("dialog.createTitle")} onClose={onClose} closeLabel={tc("close")} />
      <DialogBody>
        <div className="space-y-1.5">
          <label htmlFor="teamspace-name" className="block text-sm text-fg-muted">
            {t("dialog.name")}
          </label>
          <div className="flex items-center gap-2">
            <IconPicker icon={icon} onChange={setIcon}>
              {(toggle) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-label={t("dialog.icon")}
                  title={t("dialog.icon")}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-base leading-none hover:bg-bg-hover"
                >
                  {icon ?? <SmilePlus className="h-4 w-4 text-fg-faint" aria-hidden />}
                </button>
              )}
            </IconPicker>
            <Input
              id="teamspace-name"
              autoFocus
              required
              maxLength={MAX_NAME}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("dialog.namePlaceholder")}
            />
          </div>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm text-fg-muted">{t("dialog.description")}</span>
          <textarea
            rows={2}
            maxLength={MAX_DESCRIPTION}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("dialog.descriptionPlaceholder")}
            className={textareaClass}
          />
        </label>

        <fieldset className="space-y-1.5" disabled={accessLocked}>
          <legend className="mb-1.5 text-sm text-fg-muted">{t("dialog.access")}</legend>
          {options.map((option) => (
            <label
              key={option}
              className={cn(
                "flex cursor-pointer gap-3 rounded-md border px-3 py-2 transition-colors",
                access === option ? "border-accent" : "border-border hover:bg-bg-hover",
                accessLocked && "cursor-default opacity-60 hover:bg-transparent",
              )}
            >
              <input
                type="radio"
                name="teamspace-access"
                value={option}
                checked={access === option}
                onChange={() => setAccess(option)}
                className="mt-0.5 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t(`access.${option}`)}</span>
                <span className="block text-xs text-fg-muted">{t(`accessHint.${option}`)}</span>
              </span>
            </label>
          ))}
          {accessLocked && <p className="text-xs text-fg-muted">{t("dialog.defaultLocked")}</p>}
          {accessNote && <p className="text-xs text-fg-muted">{accessNote}</p>}
        </fieldset>

        <label className="block space-y-1.5">
          <span className="block text-sm text-fg-muted">{t("dialog.memberLevel")}</span>
          <select
            className={selectClass}
            value={memberLevel}
            disabled={memberLocked}
            onChange={(e) => setMemberLevel(e.target.value as TeamspaceMemberLevel)}
          >
            {MEMBER_LEVEL_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {t(`memberLevel.${level}`)}
              </option>
            ))}
          </select>
          <span className="block text-xs text-fg-muted">{memberLocked ? t("dialog.memberLevelLocked") : t("dialog.memberLevelHint")}</span>
        </label>

        {teamspace && (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={topLevelLocked}
              onChange={(e) => setTopLevelLocked(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block">{t("dialog.topLevelLocked")}</span>
              <span className="block text-xs text-fg-muted">{t("dialog.topLevelLockedHint")}</span>
            </span>
          </label>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
          {teamspace ? (pending ? tc("saving") : tc("save")) : pending ? t("dialog.creating") : t("dialog.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
