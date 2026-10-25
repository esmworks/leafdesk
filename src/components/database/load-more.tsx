"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/components/ui";

/** "Load more" under the cards a board column or a gallery shows (lib/load-limit), with how many are left. */
export function LoadMore({ hidden, onClick, className }: { hidden: number; onClick: () => void; className?: string }) {
  const t = useTranslations("database.layout");
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-fg-muted hover:bg-fg/5 hover:text-fg", className)}
    >
      <ChevronDown className="h-3.5 w-3.5" />
      {t("loadMore")}
      <span className="text-xs tabular-nums">{t("moreCards", { count: hidden })}</span>
    </button>
  );
}
