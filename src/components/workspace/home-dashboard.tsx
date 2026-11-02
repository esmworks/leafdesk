"use client";

import { Pencil, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { draftHomeDashboardAction, saveHomeDashboardAction } from "@/app/actions/home-dashboard";
import { useAiChat } from "@/components/ai-chat/chat-panel";
import { useIsOffline } from "@/components/offline/offline-context";
import { Button } from "@/components/ui";
import type { DashboardWidget } from "@/lib/dashboard";

// The grid and its charts load apart from the home page's first load, which every workspace opens on.
const Dashboard = dynamic(() => import("@/components/page/dashboard-grid").then((m) => m.Dashboard), {
  loading: () => <div aria-busy="true" className="h-40 animate-pulse rounded-lg bg-bg-subtle" />,
});

/**
 * The workspace's dashboard on its home page (server/home-dashboard.ts). Everyone sees the widgets
 * they may; an owner lays it out after pressing Edit, or has the AI draft it from the workspace's
 * databases, which replaces the widgets until they take it back. Each change is saved as it is made.
 */
export function HomeDashboard({
  workspaceId,
  widgets: initialWidgets,
  period: initialPeriod,
  canEdit,
}: {
  workspaceId: string;
  widgets: DashboardWidget[];
  period: string;
  /** The viewer owns the workspace. */
  canEdit: boolean;
}) {
  const t = useTranslations("home.dashboard");
  const [widgets, setWidgets] = useState(initialWidgets);
  const [period, setPeriod] = useState(initialPeriod);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The widgets an AI draft replaced, for taking it back.
  const [replaced, setReplaced] = useState<DashboardWidget[] | null>(null);
  const [drafting, startDraft] = useTransition();
  const aiChat = useAiChat();
  const offline = useIsOffline();
  const canDraft = canEdit && Boolean(aiChat?.available) && !offline;

  if (!canEdit && !widgets.length) return null;

  const save = (next: DashboardWidget[], nextPeriod = period) => {
    setWidgets(next);
    setPeriod(nextPeriod);
    setError(null);
    void saveHomeDashboardAction(workspaceId, next, nextPeriod).then((result) => {
      if (!result.ok) setError(result.error);
    });
  };

  const draft = () =>
    startDraft(async () => {
      setError(null);
      const result = await draftHomeDashboardAction(workspaceId);
      if (!result.ok) return setError(result.error);
      setReplaced(widgets);
      setEditing(true);
      save(result.data);
    });

  const aiButton = canDraft && (
    <Button variant={widgets.length ? "ghost" : "secondary"} size="sm" onClick={draft} disabled={drafting}>
      <Sparkles className="h-3.5 w-3.5" />
      {drafting ? t("drafting") : t("draft")}
    </Button>
  );

  return (
    <section aria-labelledby="home-dashboard-heading">
      <div className="mb-3 flex min-h-8 items-center justify-between gap-2">
        <h2 id="home-dashboard-heading" className="text-base font-semibold">
          {t("heading")}
        </h2>
        {canEdit && (widgets.length > 0 || editing) && (
          <div className="flex items-center gap-1">
            {editing && aiButton}
            <Button variant={editing ? "secondary" : "ghost"} size="sm" onClick={() => (setEditing(!editing), setReplaced(null))}>
              {!editing && <Pencil className="h-3.5 w-3.5" />}
              {editing ? t("done") : t("edit")}
            </Button>
          </div>
        )}
      </div>
      {replaced && (
        <p role="status" className="mb-3 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-muted">
          {t("drafted", { count: widgets.length })}
          <button type="button" className="font-medium text-fg hover:underline" onClick={() => (save(replaced), setReplaced(null))}>
            {t("undo")}
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-[13px] text-danger">
          {error}
        </p>
      )}
      {!widgets.length && !editing ? (
        <div className="flex flex-col items-start gap-3 rounded-lg bg-bg-subtle px-5 py-5">
          <p className="text-sm text-fg-muted">{t("empty")}</p>
          <div className="flex flex-wrap items-center gap-1">
            {aiButton}
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {t("setUp")}
            </Button>
          </div>
        </div>
      ) : (
        <Dashboard
          widgets={widgets}
          onChange={editing ? save : undefined}
          workspaceId={workspaceId}
          period={period}
          onPeriod={editing ? (next) => save(widgets, next) : undefined}
        />
      )}
    </section>
  );
}
