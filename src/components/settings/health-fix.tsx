"use client";

import { fixFindingAction, type CheckFix } from "@/app/actions/workspace-check";
import { useAction } from "@/components/settings/workspace-settings";
import { Button } from "@/components/ui";

/** A one-click fix of Settings > Health; the report is checked again once it is done. */
export function HealthFix({ workspaceId, fix, label, confirm }: { workspaceId: string; fix: CheckFix; label: string; confirm?: string }) {
  const { pending, error, run } = useAction();
  return (
    <span className="flex shrink-0 items-center gap-2">
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          run(() => fixFindingAction(workspaceId, fix));
        }}
      >
        {label}
      </Button>
    </span>
  );
}
