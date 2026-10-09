"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { renameWorkspaceAction, type ActionResult } from "@/app/actions/workspaces";
import { Button, Input } from "@/components/ui";
import { SettingsRow } from "./section";

export function useAction() {
  const tc = useTranslations("common");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run<T>(action: () => Promise<ActionResult<T>>, onOk?: (data: T) => void) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) onOk?.(result.data);
        else setError(result.error);
      } catch {
        setError(tc("genericError"));
      }
    });
  }
  return { pending, error, run };
}

export function WorkspaceNameForm({ workspaceId, name, canEdit }: { workspaceId: string; name: string; canEdit: boolean }) {
  const t = useTranslations("settings.workspace");
  const tc = useTranslations("common");
  const [value, setValue] = useState(name);
  const [saved, setSaved] = useState(false);
  const { pending, error, run } = useAction();
  const dirty = value.trim() !== name && value.trim() !== "";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty) return;
        setSaved(false);
        run(() => renameWorkspaceAction(workspaceId, value), () => setSaved(true));
      }}
    >
      <SettingsRow
        title={t("nameLabel")}
        htmlFor="workspace-name"
        description={
          error ? (
            <span className="text-danger">{error}</span>
          ) : saved ? (
            tc("saved")
          ) : canEdit ? (
            t("nameDescription")
          ) : (
            t("ownersOnly")
          )
        }
        control={
          <>
            <Input
              id="workspace-name"
              value={value}
              maxLength={80}
              disabled={!canEdit}
              className="w-full sm:w-60"
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
            />
            {canEdit && (
              <Button type="submit" variant="primary" disabled={!dirty || pending}>
                {pending ? tc("saving") : tc("save")}
              </Button>
            )}
          </>
        }
      />
    </form>
  );
}
