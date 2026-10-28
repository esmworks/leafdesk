"use client";

/**
 * Verifies a page (server/verification.ts) for a while, until a day or with no end, or removes its
 * verification (full access). Loaded when the page menu or the badge opens it.
 */
import { BadgeCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createPortal } from "react-dom";
import { setPageVerificationAction, type VerificationChoice } from "@/app/actions/verification";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, Input } from "@/components/ui";
import { localIsoDate } from "@/lib/mentions";
import { VERIFICATION_DURATIONS, type VerificationView } from "@/lib/verification";

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
      <DialogHeader
        icon={<BadgeCheck className="h-4 w-4" />}
        title={t("title")}
        description={t("description")}
        onClose={onClose}
        closeLabel={tc("close")}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <DialogBody>
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
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          {verification && (
            <Button type="button" variant="ghost" className="me-auto" onClick={() => void submit(true)} disabled={saving}>
              {t("remove")}
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {verification ? t("verifyAgain") : t("verify")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>,
    document.body,
  );
}
