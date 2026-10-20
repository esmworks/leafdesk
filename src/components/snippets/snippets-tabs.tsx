"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { TabButton } from "@/components/settings/members-panel";
import type { SnippetView } from "@/lib/snippets";
import { SnippetsPanel } from "./snippets-panel";

type Scope = "mine" | "workspace";

/**
 * Settings > Snippets: the person's own snippets and the workspace's (`shared`, null for a guest,
 * who gets only the first), one tab each. Both lists stay mounted, so a search or an import result
 * is still there after looking at the other; the open tab is kept in the address (`scope`).
 */
export function SnippetsTabs({
  workspace,
  mine,
  shared,
  canManage,
  me,
  initialScope,
}: {
  workspace: { id: string; name: string };
  mine: SnippetView[];
  shared: SnippetView[] | null;
  canManage: boolean;
  me: string;
  initialScope: Scope;
}) {
  const t = useTranslations("snippets.settings");
  const [scope, setScope] = useState<Scope>(initialScope);
  const [counts, setCounts] = useState({ mine: mine.length, workspace: shared?.length ?? 0 });

  const open = (next: Scope) => {
    setScope(next);
    // Not the router: a new address would render the page again on the server for nothing.
    const url = new URL(window.location.href);
    if (next === "workspace") url.searchParams.set("scope", "workspace");
    else url.searchParams.delete("scope");
    window.history.replaceState(window.history.state, "", url);
  };

  return (
    <div className="space-y-4">
      {shared && (
        <div role="tablist" aria-label={t("tabsLabel")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
          <TabButton active={scope === "mine"} onClick={() => open("mine")}>
            {t("tabs.mine")} <span className="text-fg-faint">{counts.mine}</span>
          </TabButton>
          <TabButton active={scope === "workspace"} onClick={() => open("workspace")}>
            {t("tabs.workspace")} <span className="text-fg-faint">{counts.workspace}</span>
          </TabButton>
        </div>
      )}
      <div role={shared ? "tabpanel" : undefined} hidden={scope !== "mine"} className="space-y-4">
        <p className="text-sm text-fg-muted">{t("mineNote")}</p>
        <SnippetsPanel workspace={null} canManage initial={mine} me={me} onChange={(list) => setCounts((c) => ({ ...c, mine: list.length }))} />
      </div>
      {shared && (
        <div role="tabpanel" hidden={scope !== "workspace"} className="space-y-4">
          <p className="text-sm text-fg-muted">{t(canManage ? "workspaceNoteOwner" : "workspaceNote", { workspace: workspace.name })}</p>
          <SnippetsPanel
            workspace={workspace}
            canManage={canManage}
            initial={shared}
            me={me}
            onChange={(list) => setCounts((c) => ({ ...c, workspace: list.length }))}
          />
        </div>
      )}
    </div>
  );
}
