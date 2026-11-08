"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { lazyPart } from "@/components/lazy-part";
import { Popover } from "@/components/ui";
import type { CatchUpTarget } from "./catch-up-panel";

const CatchUpPanel = lazyPart(() => import("./catch-up-panel").then((m) => m.CatchUpPanel));

/**
 * The head's Catch up button: the AI sums up what the person missed in a channel (the messages
 * after `since`) or a thread, in a card under it whose code loads when it first opens.
 */
export function CatchUpButton({ target, workspaceId, openThread, label = true }: { target: CatchUpTarget; workspaceId: string; openThread: (threadId: string, messageId?: string) => void; label?: boolean }) {
  const t = useTranslations("messages.catchUp");
  const title = target.threadId ? t("threadButtonTitle") : t("buttonTitle");
  return (
    <Popover
      align="end"
      className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          onPointerEnter={() => void CatchUpPanel.preload()}
          aria-expanded={open}
          aria-label={title}
          title={title}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <Sparkles className="h-4 w-4" />
          {label && <span className="max-md:hidden">{t("button")}</span>}
        </button>
      )}
    >
      {(close) => <CatchUpPanel target={target} workspaceId={workspaceId} openThread={openThread} close={close} />}
    </Popover>
  );
}
