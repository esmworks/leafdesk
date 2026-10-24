"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { setOwnPageViewsAction } from "@/app/actions/page-views";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Switch } from "@/components/ui";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > Analytics: the owners' switch for recording page views in the workspace
 * (WorkspaceSettings `pageViews`, server/page-views.ts). Off, analytics show edits only.
 */
export function RecordPageViewsSetting({ workspaceId, enabled }: { workspaceId: string; enabled: boolean }) {
  const t = useTranslations("settings.analytics.recording");
  const [value, setValue] = useState(enabled);
  const { pending, error, run } = useAction();
  return (
    <SettingsRow
      anchor="pageViews"
      title={t("title")}
      description={error ? <span className="text-danger">{error}</span> : t("description")}
      control={
        <Switch
          checked={value}
          label={t("title")}
          disabled={pending}
          onChange={(next) => {
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { pageViews: next });
              if (!result.ok) setValue(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}

/**
 * Settings > General: each owner's and member's own switch for recording the pages they open in
 * the workspace; it can't be turned on while the workspace doesn't record views.
 */
export function OwnPageViewsSetting({ workspaceId, own, workspaceOn }: { workspaceId: string; own: boolean; workspaceOn: boolean }) {
  const t = useTranslations("settings.pageViews");
  const [value, setValue] = useState(own);
  const { pending, error, run } = useAction();
  return (
    <SettingsRow
      anchor="ownPageViews"
      title={t("title")}
      description={error ? <span className="text-danger">{error}</span> : workspaceOn ? t("description") : t("workspaceOff")}
      control={
        <Switch
          checked={workspaceOn && value}
          label={t("title")}
          disabled={pending || !workspaceOn}
          onChange={(next) => {
            setValue(next);
            run(async () => {
              const result = await setOwnPageViewsAction(workspaceId, next);
              if (!result.ok) setValue(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}
