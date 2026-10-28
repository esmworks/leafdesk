"use client";

import { Check, ChevronDown, FileText, Layers, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { listTeamspacesAction } from "@/app/actions/teamspaces";
import { MenuItem, Popover } from "@/components/ui";
import type { ChatScopeView } from "@/lib/ai-chat";
import { chipMuted } from "./composer-chip";

/**
 * Where the chat answers from, a menu in the question box's toolbar (under the box in the panel):
 * the whole workspace, the page open now with the pages under it (in the panel beside a page), or
 * one of the person's teamspaces (those in their sidebar, loaded when the picker is first shown).
 * The server checks the scope again on every question (ai-chat.ts chatScope).
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
  const kind = value?.kind === "page" ? (pageId ? "page" : "workspace") : (value?.kind ?? "workspace");
  const Icon = kind === "page" ? FileText : kind === "teamspace" ? Users : Layers;
  const shown = value?.kind === "teamspace" ? (value.title ?? t("scopeTeamspace")) : kind === "page" ? t("scopePage") : t("scopeWorkspace");
  const listed =
    value?.kind === "teamspace" && !teamspaces.some((s) => s.id === value.id) ? [{ id: value.id, name: value.title ?? t("scopeTeamspace") }, ...teamspaces] : teamspaces;
  const tick = <Check className="h-3.5 w-3.5" />;

  return (
    <Popover
      side="top"
      align="end"
      className="w-64"
      wrapperClassName="relative inline-flex min-w-0"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`${t("scope")}: ${shown}`}
          title={t("scope")}
          className={chipMuted}
        >
          {/* The strip above the chat box is a container: narrow, the icon gives way to the name. */}
          <Icon className="hidden h-3.5 w-3.5 shrink-0 @sm:block" />
          <span className="max-w-44 min-w-0 truncate">{shown}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      )}
    >
      {(close) => {
        const pick = (scope: ChatScopeView | null) => {
          onChange(scope);
          close();
        };
        return (
          <div role="menu" aria-label={t("scope")}>
            <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-fg-muted">{t("scope")}</p>
            <MenuItem icon={<Layers className="h-4 w-4" />} active={kind === "workspace"} trailing={kind === "workspace" && tick} onClick={() => pick(null)}>
              {t("scopeWorkspace")}
            </MenuItem>
            {pageId && (
              <MenuItem
                icon={<FileText className="h-4 w-4" />}
                active={kind === "page"}
                trailing={kind === "page" && tick}
                onClick={() => pick({ kind: "page", id: pageId, title: null })}
              >
                {t("scopePage")}
              </MenuItem>
            )}
            {listed.length > 0 && <p className="px-2 pt-2 pb-1 text-xs font-medium text-fg-muted">{t("scopeTeamspace")}</p>}
            {listed.map((space) => {
              const on = value?.kind === "teamspace" && value.id === space.id;
              return (
                <MenuItem
                  key={space.id}
                  icon={<Users className="h-4 w-4" />}
                  active={on}
                  trailing={on && tick}
                  onClick={() => pick({ kind: "teamspace", id: space.id, title: space.name })}
                >
                  {space.name}
                </MenuItem>
              );
            })}
          </div>
        );
      }}
    </Popover>
  );
}
