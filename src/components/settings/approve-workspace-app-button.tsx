"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setWorkspaceAppApprovedAction } from "@/app/actions/oauth";
import { Button } from "@/components/ui";

/** Approves an app for the workspace from the owner's list, or withdraws the approval. */
export function ApproveWorkspaceAppButton({ workspaceId, clientId, approved }: { workspaceId: string; clientId: string; approved: boolean }) {
  const t = useTranslations("settings.security.workspaceApps");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex shrink-0 flex-col gap-1 sm:items-end">
      <Button
        size="sm"
        variant={approved ? "ghost" : "secondary"}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            try {
              const result = await setWorkspaceAppApprovedAction(workspaceId, clientId, !approved);
              if (result.ok) router.refresh();
              else setError(result.error);
            } catch {
              setError(t("approveError"));
            }
          })
        }
      >
        {t(approved ? "unapprove" : "approve")}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
