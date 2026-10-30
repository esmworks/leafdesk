"use client";

/**
 * What the AI chat and agents' chats draw their messages with, so both read alike: a question's
 * box and place, the steps an answer took (open with a running clock while it's written, then
 * folded into how long it took), and the actions under a message (copying it, when it was written)
 * that show on hover.
 */
import { Check, ChevronRight, Copy } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { copyText } from "@/components/settings/copy-button";
import { cn, IconButton } from "@/components/ui";

/** Actions shown on hovering their message (always on touch screens, and while focused). */
export const revealed = "opacity-0 transition-opacity group-hover/answer:opacity-100 group-hover/question:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100";

/** A question's text: at the end of a full page's line, indented in a panel. */
export function questionBox(page: boolean) {
  return cn("rounded-lg bg-bg-subtle px-3 py-2 text-sm whitespace-pre-wrap break-words", page ? "ms-auto w-fit max-w-[80%]" : "ms-8");
}

/** Copies a message's text, showing a tick for a moment when it did. */
export function CopyAction({ text }: { text: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? t("copied") : t("copy")}
      className="h-7 w-7"
      onClick={async (e) => {
        if (!(await copyText(text, e.currentTarget))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </IconButton>
  );
}

/** When a message was written: the time today, the day and time before (the full date on hover). */
export function MessageTime({ at }: { at: string }) {
  const locale = useLocale();
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const today = date.toDateString() === new Date().toDateString();
  const shown = date.toLocaleString(locale, today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <time dateTime={at} title={date.toLocaleString(locale, { dateStyle: "full", timeStyle: "short" })} className="px-1 text-xs text-fg-faint tabular-nums">
      {shown}
    </time>
  );
}

/**
 * The steps an answer took, its `children` (list items): open with a running clock from
 * `startedAt` while `live`, then folded into how long it took, `ms` (the person can open it
 * again). An answer whose time isn't known folds into `label` instead.
 */
export function StepsFold({ live, ms, startedAt, label, children }: { live: boolean; ms?: number; startedAt?: number; label?: string; children: ReactNode }) {
  const t = useTranslations("ai.chat");
  const [open, setOpen] = useState<boolean | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const elapsed = live || ms === undefined ? Date.now() - (startedAt ?? Date.now()) : ms;
  const seconds = Math.max(live ? 0 : 1, Math.round(elapsed / 1000));
  const time = seconds < 60 ? t("steps.seconds", { s: seconds }) : t("steps.minutes", { m: Math.floor(seconds / 60), s: seconds % 60 });
  const expanded = open ?? live;

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="-ms-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <span className="tabular-nums">{live ? t("steps.working", { time }) : ms === undefined && label ? label : t("steps.worked", { time })}</span>
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : "rtl:rotate-180")} />
      </button>
      {expanded && <ol className="mt-1 ms-1.5 space-y-1 border-s border-border ps-3 text-fg-muted">{children}</ol>}
    </div>
  );
}
