"use client";

import { Brain } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn, iconButtonClass } from "@/components/ui";
import { memoryPagePath } from "@/lib/ai-chat";

/** The link to the Memory page, in the chat's headers. */
export function MemoryButton({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const t = useTranslations("ai.memory");
  return (
    <Link
      href={memoryPagePath(workspaceId)}
      aria-label={t("open")}
      title={t("open")}
      className={cn(iconButtonClass, className)}
    >
      <Brain className="h-4 w-4" />
    </Link>
  );
}
