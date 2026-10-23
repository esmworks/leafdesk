"use client";

import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { wipeAllOfflineData } from "@/components/offline/offline-store";
import { Button } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

/** Why the workspace stays closed from this network, the address the server sees, and a way to try again. */
export function NetworkGate({
  workspaceId,
  workspaceName,
  address,
  email,
}: {
  workspaceId: string;
  workspaceName: string;
  /** The request's address as the server sees it; null when it couldn't tell. */
  address: string | null;
  email: string;
}) {
  const t = useTranslations("security.networkGate");

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-fg-muted" aria-hidden />
          <h1 className="text-base font-semibold">{t("title", { workspace: workspaceName })}</h1>
        </div>
        <p className="text-sm text-fg-muted">{t("body")}</p>
      </div>
      <div className="rounded-lg border border-border bg-bg-subtle px-4 py-3 text-sm">
        {address ? (
          <>
            <span className="text-fg-muted">{t("address")}</span>{" "}
            <span className="font-medium break-all" data-network-address>
              {address}
            </span>
          </>
        ) : (
          <span className="text-fg-muted">{t("addressUnknown")}</span>
        )}
      </div>
      <p className="text-sm text-fg-muted">{t("askOwner")}</p>
      <Button variant="primary" className="w-full" onClick={() => window.location.assign(`/w/${workspaceId}`)}>
        {t("tryAgain")}
      </Button>
      <p className="border-t border-border pt-4 text-xs text-fg-muted">
        {t("signedInAs", { email })}{" "}
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={async () => {
            await authClient.signOut();
            await wipeAllOfflineData();
            window.location.assign("/sign-in");
          }}
        >
          {t("signOut")}
        </button>
      </p>
    </div>
  );
}
