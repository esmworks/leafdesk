"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { listTeamspacesAction } from "@/app/actions/teamspaces";
import type { ChatScopeView } from "@/lib/ai-chat";

/**
 * Where the chat answers from, under its box: the whole workspace, the page open now with the
 * pages under it (in the panel beside a page), or one of the person's teamspaces (those in their
 * sidebar, loaded when the picker is first shown). The server checks the scope again on every
 * question (ai-chat.ts chatScope).
 */
export function ScopePicker({
  workspaceId,
  pageId,
  value,
  onChange,
  disabled,
}: {
  workspaceId: string;
  /** The page open now, offered with its subpages; null where there is none (the full-page chat). */
  pageId: string | null;
  value: ChatScopeView | null;
  onChange: (scope: ChatScopeView | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("ai.chat");
  const [teamspaces, setTeamspaces] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    listTeamspacesAction(workspaceId, "active").then(
      (result) => live && result.ok && setTeamspaces(result.data.teamspaces.filter((s) => s.joined).map(({ id, name }) => ({ id, name }))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);

  // The page scope follows the page open now (the whole workspace where none is); a picked teamspace
  // stays listed while the list loads.
  const selected = value?.kind === "page" ? (pageId ? "page" : "workspace") : value?.kind === "teamspace" ? `teamspace:${value.id}` : "workspace";
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
      <label htmlFor="ai-chat-scope">{t("scope")}</label>
      <select
        id="ai-chat-scope"
        value={selected}
        onChange={(e) => {
          const picked = e.target.value;
          if (picked === "page" && pageId) onChange({ kind: "page", id: pageId, title: null });
          else if (picked.startsWith("teamspace:")) {
            const space = teamspaces.find((s) => `teamspace:${s.id}` === picked);
            onChange(space ? { kind: "teamspace", id: space.id, title: space.name } : null);
          } else onChange(null);
        }}
        disabled={disabled}
        className="h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1 text-xs text-fg"
      >
        <option value="workspace">{t("scopeWorkspace")}</option>
        {pageId && <option value="page">{t("scopePage")}</option>}
        {value?.kind === "teamspace" && !teamspaces.some((s) => s.id === value.id) && (
          <option value={`teamspace:${value.id}`}>{value.title ?? t("scopeTeamspace")}</option>
        )}
        {teamspaces.length > 0 && (
          <optgroup label={t("scopeTeamspace")}>
            {teamspaces.map((space) => (
              <option key={space.id} value={`teamspace:${space.id}`}>
                {space.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
