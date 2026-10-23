"use client";

/**
 * Verified pages (server/verification.ts): the badge under a page's title, saying who verified it
 * and until when, or that the verification expired, and the dialog that verifies it for a while,
 * until a day or with no end, or removes the verification (full access).
 */
import { BadgeAlert, BadgeCheck, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { createPortal } from "react-dom";
import { setPageVerificationAction, type VerificationChoice } from "@/app/actions/verification";
import { Button, cn, Dialog, IconButton, Input } from "@/components/ui";
import { localIsoDate } from "@/lib/mentions";
import { VERIFICATION_DURATIONS, type VerificationView } from "@/lib/verification";

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

type Choice = (typeof VERIFICATION_DURATIONS)[number] | "until" | "forever";

/** Verifies the page or removes its verification; the page hears the result through `onDone`. */
export function VerifyDialog({
  workspaceId,
  pageId,
  verification,
  open,
  onClose,
  onDone,
}: {
  workspaceId: string;
  pageId: string;
  verification: VerificationView | null;
  open: boolean;
  onClose: () => void;
  onDone: (verification: VerificationView | null) => void;
}) {
  const t = useTranslations("page.verification");
  const tc = useTranslations("common");
  const [choice, setChoice] = useState<Choice>("quarter");
  const [day, setDay] = useState(() => localIsoDate(30));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (remove: boolean) => {
    let picked: VerificationChoice | null = null;
    if (!remove) {
      if (choice === "forever") picked = { forever: true };
      else if (choice === "until") {
        const [y, m, d] = day.split("-").map(Number);
        // Through the end of that day where the person is.
        const end = new Date(y, m - 1, d, 23, 59, 59, 999);
        if (Number.isNaN(end.getTime())) return setError(t("errors.invalidEnd"));
        picked = { until: end.toISOString() };
      } else picked = { duration: choice };
    }
    setSaving(true);
    setError(null);
    try {
      const result = await setPageVerificationAction(workspaceId, pageId, picked);
      if (!result.ok) return setError(result.error);
      onDone(result.data);
      onClose();
    } catch {
      setError(tc("genericError"));
    } finally {
      setSaving(false);
    }
  };

  if (!open || typeof document === "undefined") return null;
  const choices: Choice[] = [...VERIFICATION_DURATIONS, "until", "forever"];
  // A portal: the page header's blurred background would otherwise hold the fixed overlay inside it.
  return createPortal(
    <Dialog open onClose={saving ? () => {} : onClose} className="max-w-md">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <BadgeCheck size={16} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="mt-0.5 text-xs text-fg-muted">{t("description")}</p>
        </div>
        <IconButton label={tc("close")} onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs text-fg-muted">{t("durationLabel")}</legend>
          {choices.map((value) => (
            <label key={value} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-bg-hover">
              <input type="radio" name="verification-duration" value={value} checked={choice === value} onChange={() => setChoice(value)} />
              <span className="flex-1">{t(`durations.${value}`)}</span>
              {value === "until" && choice === "until" && (
                <Input
                  type="date"
                  value={day}
                  min={localIsoDate(1)}
                  onChange={(e) => setDay(e.target.value)}
                  aria-label={t("dateLabel")}
                  className="h-7 w-40"
                  required
                />
              )}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {verification && (
            <Button type="button" variant="ghost" className="me-auto" onClick={() => void submit(true)} disabled={saving}>
              {t("remove")}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {verification ? t("verifyAgain") : t("verify")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>,
    document.body,
  );
}
