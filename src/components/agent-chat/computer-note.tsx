"use client";

import { Monitor } from "lucide-react";
import { useTranslations } from "next-intl";

/** Over the chat's box while the person's desktop app lets this chat's runs use files on their computer (server/agents/computer.ts). */
export function ComputerNote({ folders }: { folders: string[] }) {
  const t = useTranslations("page.agentChat");
  return (
    <p className="mb-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
      <Monitor className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t("computerFiles", { folders: folders.join(", ") })}</span>
    </p>
  );
}
