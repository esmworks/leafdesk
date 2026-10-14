"use client";

import { useTranslations } from "next-intl";
import { revokeConnectedAppAction } from "@/app/actions/oauth";
import { ConfirmButton } from "./confirm-button";

export function RevokeAppButton({ clientId, name }: { clientId: string; name: string }) {
  const t = useTranslations("settings.connectedApps");
  return (
    <ConfirmButton
      label={t("revoke")}
      confirmLabel={t("disconnect", { name })}
      working={t("revoking")}
      failed={t("revokeError")}
      act={async () => {
        await revokeConnectedAppAction(clientId);
        return null;
      }}
    />
  );
}
