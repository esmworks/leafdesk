"use client";

/**
 * Verified pages (server/verification.ts): the badge under a page's title, saying who verified it
 * and until when, or that the verification expired. The dialog that changes it is ./verify-dialog,
 * loaded when it opens.
 */
import { BadgeAlert, BadgeCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/components/ui";
import type { VerificationView } from "@/lib/verification";

const formatDay = (iso: string, locale: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

/** Under the title: verified by whom, until when; or expired. Opens the dialog for those who may change it. */
export function VerificationBadge({ verification, onChange }: { verification: VerificationView; onChange?: () => void }) {
  const t = useTranslations("page.verification");
  const locale = useLocale();
  const until = verification.until ? formatDay(verification.until, locale) : null;
  const label = verification.expired
    ? t("expiredOn", { date: until ?? "" })
    : verification.by
      ? until
        ? t("byUntil", { name: verification.by, date: until })
        : t("by", { name: verification.by })
      : until
        ? t("until", { date: until })
        : t("plain");
  const Icon = verification.expired ? BadgeAlert : BadgeCheck;
  const classes = cn(
    "mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs",
    verification.expired ? "bg-bg-subtle text-fg-muted" : "bg-added-bg text-added-fg",
    onChange && "hover:opacity-80",
  );
  const content = (
    <>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", verification.expired && "text-amber-600 dark:text-amber-400")} aria-hidden />
      <span className="truncate">{label}</span>
    </>
  );
  return onChange ? (
    <button type="button" className={classes} title={t("change")} onClick={onChange} data-verification={verification.expired ? "expired" : "verified"}>
      {content}
    </button>
  ) : (
    <span className={classes} title={t("hint")} data-verification={verification.expired ? "expired" : "verified"}>
      {content}
    </span>
  );
}
