"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { setAppAllToolsAction } from "@/app/actions/oauth";
import { Switch } from "@/components/ui";

/** Whether a connected app lists every Leafdesk tool, or the ones used most and finds the rest when it needs them. */
export function AppToolsSwitch({ clientId, allTools }: { clientId: string; allTools: boolean }) {
  const t = useTranslations("settings.connectedApps");
  const [on, setOn] = useState(allTools);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    setOn(next);
    const result = await setAppAllToolsAction(clientId, next);
    setBusy(false);
    if (!result.ok) {
      setOn(!next);
      setError(result.error);
    }
  }

  return (
    <div className="mt-3 flex items-start gap-3">
      <span className="mt-0.5">
        <Switch checked={on} label={t("allTools")} disabled={busy} onChange={(next) => void change(next)} />
      </span>
      <div className="min-w-0 text-xs">
        <p className="text-fg">{t("allTools")}</p>
        <p className="mt-0.5 text-fg-muted">{t("allToolsHint")}</p>
        {error && (
          <p role="alert" className="mt-1 text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
