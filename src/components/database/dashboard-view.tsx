"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dashboard } from "@/components/page/dashboard-grid";
import type { ViewConfig } from "@/db/schema/app";
import { viewWidgets, viewWidgetsConfig, type DashboardWidget } from "@/lib/dashboard";
import type { View } from "./types";

/** How long a dashboard view waits after the last change (a title being typed) before saving its widgets. */
const SAVE_DELAY = 400;

/**
 * A database's dashboard view: the dashboard grid (components/page/dashboard-grid) over widgets
 * kept in the view's settings, each a view of this database. Changes show at once and are saved
 * once they settle, as a view's settings are: each save goes to the server and to everyone who
 * has the database open.
 */
export default function DashboardView({
  workspaceId,
  view,
  readOnly,
  onConfig,
}: {
  workspaceId: string;
  view: View;
  /** Readers who may not change the view's settings see the widgets as they are. */
  readOnly: boolean;
  onConfig: (config: ViewConfig) => void;
}) {
  const stored = useMemo(() => viewWidgets(view.config, view.databaseId), [view.config, view.databaseId]);
  // Changes not saved yet: shown instead of the stored widgets until they are.
  const [draft, setDraft] = useState<DashboardWidget[] | null>(null);
  const latest = useRef({ config: view.config, onConfig, draft });
  latest.current = { config: view.config, onConfig, draft };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { config, onConfig, draft } = latest.current;
    if (!draft) return;
    onConfig({ ...config, widgets: viewWidgetsConfig(draft) });
    setDraft(null);
  }, []);
  // Leaving the view (another tab, another page) saves what is pending.
  useEffect(() => save, [save]);

  const onChange = useCallback(
    (next: DashboardWidget[]) => {
      latest.current.draft = next;
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(save, SAVE_DELAY);
    },
    [save],
  );

  // The period is saved at once, with widget changes still pending.
  const onPeriod = useCallback((period: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { config, onConfig, draft } = latest.current;
    const { period: _, ...rest } = config;
    onConfig({ ...rest, ...(draft ? { widgets: viewWidgetsConfig(draft) } : {}), ...(period ? { period } : {}) });
    setDraft(null);
  }, []);

  return (
    <div className="page-gutter">
      <Dashboard
        widgets={draft ?? stored}
        onChange={readOnly ? undefined : onChange}
        workspaceId={workspaceId}
        databaseId={view.databaseId}
        period={view.config.period}
        onPeriod={readOnly ? undefined : onPeriod}
      />
    </div>
  );
}
