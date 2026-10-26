"use client";

import { PenLine, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { recentSearchAction } from "@/app/actions/pages";
import { PageIcon } from "@/components/ui";

type Starter = { key: string; icon: ReactNode; label: string; text: string };

/**
 * Questions to start from, under the empty full-page chat: about the pages the person opened last
 * (what the search box lists before anything is typed, no model call), then the start of a search
 * and of a new page, left for them to finish. A pick fills the box; nothing is sent.
 */
export function ChatStarters({ workspaceId, onPick }: { workspaceId: string; onPick: (text: string) => void }) {
  const t = useTranslations("ai.chat.starters");
  const [recent, setRecent] = useState<{ id: string; title: string; icon: string | null; kind: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    recentSearchAction(workspaceId).then(
      (result) => live && setRecent(result.pages.filter((p) => p.title.trim()).slice(0, 2)),
      () => live && setRecent([]),
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);
  // Shown all at once, so the box doesn't jump as the recent pages arrive.
  if (!recent) return null;

  const starters: Starter[] = [
    ...recent.map((p) => {
      const text = p.kind === "database" ? t("database", { title: p.title }) : t("summarize", { title: p.title });
      return { key: p.id, icon: <PageIcon icon={p.icon} kind={p.kind} className="text-base" />, label: text, text };
    }),
    { key: "find", icon: <Search className="h-4 w-4" />, label: t("find"), text: t("findText") },
    { key: "write", icon: <PenLine className="h-4 w-4" />, label: t("write"), text: t("writeText") },
  ];
  return (
    <ul aria-label={t("label")} className="mt-4 divide-y divide-border/60 px-2">
      {starters.map((s) => (
        <li key={s.key}>
          <button
            type="button"
            onClick={() => onPick(s.text)}
            className="flex w-full items-center gap-2.5 px-2 py-2.5 text-start text-sm text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
          >
            <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-faint">
              {s.icon}
            </span>
            <span className="min-w-0 truncate">{s.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
