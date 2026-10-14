"use client";

import { useTranslations } from "next-intl";
import { disconnectWorkspaceAppAction } from "@/app/actions/oauth";
import { ConfirmButton } from "./confirm-button";

/** Disconnects one person's app from the owner's list, after saying what that does. */
export function DisconnectWorkspaceAppButton({
  workspaceId,
  target,
  name,
  person,
  allWorkspaces,
}: {
  workspaceId: string;
  target: { kind: "connected_app" | "api_token"; userId: string; id: string };
  name: string;
  person: string;
  allWorkspaces: boolean;
}) {
  const t = useTranslations("settings.security.workspaceApps");
  return (
    <ConfirmButton
      label={t(target.kind === "api_token" ? "revoke" : "disconnect")}
      working={t("working")}
      note={t(allWorkspaces ? "confirmEverywhere" : "confirmHere", { name, person, kind: target.kind })}
      failed={t("error")}
      act={async () => {
        const result = await disconnectWorkspaceAppAction(workspaceId, target);
        return result.ok ? null : result.error;
      }}
    />
  );
}
