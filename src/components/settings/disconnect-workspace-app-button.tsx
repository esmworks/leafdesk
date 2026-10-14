"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { disconnectWorkspaceAppAction } from "@/app/actions/oauth";
import { Button } from "@/components/ui";

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
  const router = useRouter();
  const t = useTranslations("settings.security.workspaceApps");
  const tc = useTranslations("common");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <Button size="sm" className="shrink-0 self-start" onClick={() => setConfirming(true)}>
        {t(target.kind === "api_token" ? "revoke" : "disconnect")}
      </Button>
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 sm:max-w-64 sm:items-end">
      <p className="text-xs text-fg-muted sm:text-right">
        {t(allWorkspaces ? "confirmEverywhere" : "confirmHere", { name, person, kind: target.kind })}
      </p>
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              try {
                const result = await disconnectWorkspaceAppAction(workspaceId, target);
                if (!result.ok) setError(result.error);
                else router.refresh();
              } catch {
                setError(t("error"));
              }
            })
          }
        >
          {pending ? t("working") : t(target.kind === "api_token" ? "revoke" : "disconnect")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
