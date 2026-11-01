"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { markReadAction } from "@/app/actions/notifications";
import { cn, dialogShadow, PageIcon, pageLabel } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { ARRIVAL_SHOWN_MS } from "@/lib/inbox-arrivals";
import { pushLink } from "@/lib/push-link";
import { relativeTime } from "@/lib/relative-time";
import type { InboxItem } from "@/server/notifications";

/** Cards drawn under the newest one, as the edges of a stack. */
const STACKED = 2;
/** A card's surface: lighter than the page in dark mode, where a shadow doesn't show. */
const SURFACE = "rounded-xl border border-border bg-bg dark:bg-bg-subtle";

/**
 * What people just sent the user (use-arrivals.ts), as a stack of cards at the window's top end,
 * under the page's top bar: the newest on top, a count when there are more. A click on it marks it
 * read and goes where the inbox would, showing the next; closing takes them all off the screen,
 * unread in the inbox. They leave by themselves after ARRIVAL_SHOWN_MS without a new one, unless
 * the pointer or focus is on them.
 */
export function ArrivalCards({
  workspaceId,
  arrivals,
  onDismiss,
  onRead,
}: {
  workspaceId: string;
  arrivals: InboxItem[];
  onDismiss: (id?: string) => void;
  onRead: () => void;
}) {
  const t = useTranslations("sidebar.arrivals");
  const ti = useTranslations("sidebar.inbox");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [held, setHeld] = useState(false);
  const item = arrivals[0];
  const newest = item?.id;

  useEffect(() => {
    if (!newest || held) return;
    const timer = setTimeout(() => onDismiss(), ARRIVAL_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [newest, held, onDismiss]);

  if (!item) return null;
  const actor = item.actorName || item.accessRequest?.requesterEmail || ti("someone");
  const action =
    item.kind === "assignment"
      ? t("assignment", { property: item.propertyName ?? "" })
      : item.kind === "mention"
        ? t("mention")
        : item.kind === "comment"
          ? t("comment")
          : item.kind === "page_shared"
            ? t("pageShared")
            : t("accessRequest");
  const open = () => {
    onDismiss(item.id);
    void markReadAction(workspaceId, [item.id])
      .catch(() => {})
      .finally(onRead);
    router.push(pushLink({ ...item, workspaceId }));
  };

  return (
    <section
      aria-label={t("label")}
      className="pointer-events-none fixed top-[calc(var(--app-top)+3rem)] inset-e-[calc(var(--chat-width)+0.75rem)] z-50 w-[min(20rem,calc(100vw-1.5rem))]"
    >
      <div
        className="pointer-events-auto relative"
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
        }}
      >
        {Array.from({ length: Math.min(arrivals.length - 1, STACKED) }, (_, i) => (
          <div
            key={i}
            aria-hidden
            className={cn("absolute inset-x-0 top-0 h-full shadow-sm", SURFACE)}
            style={{ translate: `0 ${(i + 1) * 7}px`, scale: `${1 - (i + 1) * 0.04}`, zIndex: -1 - i }}
          />
        ))}
        <div key={item.id} data-arrival-card className={cn("group relative", SURFACE, dialogShadow)}>
          <button type="button" onClick={open} className="flex w-full items-start gap-3 rounded-xl p-3 pe-8 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <UserAvatar name={actor} image={item.actorImage} size="lg" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-fg">{actor}</span>
                <time dateTime={new Date(item.createdAt).toISOString()} className="shrink-0 text-xs text-fg-muted">
                  {relativeTime(item.createdAt, locale)}
                </time>
              </span>
              <span className="mt-0.5 block text-xs text-fg-muted">{action}</span>
              {item.pageId && (
                <span className="mt-1 flex items-start gap-1.5 text-sm text-fg">
                  <PageIcon icon={item.pageIcon} kind="page" className="mt-0.5 text-sm" />
                  <span className="line-clamp-2 min-w-0 break-words">{pageLabel(item.pageTitle ?? "", tc("untitled"))}</span>
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => onDismiss()}
            className={cn(
              "absolute end-1.5 top-1.5 rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg",
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
            )}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
          {arrivals.length > 1 && (
            <span
              aria-label={t("count", { count: arrivals.length })}
              className="absolute -start-2 -top-2 min-w-5 rounded-full bg-danger px-1.5 text-center text-[11px] leading-5 font-semibold text-white tabular-nums ring-2 ring-bg"
            >
              {arrivals.length > 9 ? "9+" : arrivals.length}
            </span>
          )}
        </div>
      </div>
      <p role="status" className="sr-only">
        {`${actor}: ${action}`}
      </p>
    </section>
  );
}
