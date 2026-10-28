"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { getTemplateRepeatAction, removeTemplateRepeatAction, setTemplateRepeatAction } from "@/app/actions/templates";
import { freshRepeatForm, RepeatRuleFields, repeatFormOf, useRepeatRule, type RepeatForm } from "@/components/repeat-rule-fields";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogTitle, pageLabel, Switch } from "@/components/ui";
import type { TemplateScheduleError } from "@/lib/schedule";

type Form = RepeatForm & { dateInTitle: boolean };

/** A new rule: every week on today's weekday, at 09:00, from today, in the browser's time zone. */
const freshForm = (): Form => ({ ...freshRepeatForm(), dateInTitle: true });

/**
 * Sets how a row template repeats: a row is added from it on the rule, in a time zone, as the
 * person who saves it (server/schedules). Shows when it runs next as the form changes, and why it
 * is paused when it is.
 */
export function TemplateRepeatDialog({
  template,
  onClose,
  onChanged,
}: {
  template: { id: string; title: string } | null;
  onClose: () => void;
  /** Refetches the database after the repeat changes. */
  onChanged: () => void;
}) {
  const t = useTranslations("database.page.templates.repeatDialog");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [form, setForm] = useState<Form>(freshForm);
  const [existing, setExisting] = useState<{ lastError: TemplateScheduleError | null; lastRunAt: string | null; enabled: boolean } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const templateId = template?.id ?? null;

  useEffect(() => {
    if (!templateId) return;
    let live = true;
    setLoaded(false);
    setError(null);
    void getTemplateRepeatAction(templateId).then((result) => {
      if (!live) return;
      if (!result.ok) setError(result.error);
      else if (result.data) {
        const { rule, timeZone, dateInTitle, lastError, lastRunAt, enabled } = result.data;
        setForm({ ...repeatFormOf(rule, timeZone), dateInTitle });
        setExisting({ lastError, lastRunAt, enabled });
      } else {
        setForm(freshForm());
        setExisting(null);
      }
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [templateId]);

  const { rule, valid, next } = useRepeatRule(form);

  const formatAt = (at: Date | string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: form.timeZone }).format(new Date(at));

  const set = (change: Partial<Form>) => setForm((f) => ({ ...f, ...change }));

  const save = () => {
    if (!templateId || !rule) return;
    setError(null);
    startTransition(async () => {
      const result = await setTemplateRepeatAction(templateId, { rule, timeZone: form.timeZone, dateInTitle: form.dateInTitle });
      if (!result.ok) return setError(result.error);
      onChanged();
      onClose();
    });
  };

  const turnOff = () => {
    if (!templateId) return;
    setError(null);
    startTransition(async () => {
      const result = await removeTemplateRepeatAction(templateId);
      if (!result.ok) return setError(result.error);
      onChanged();
      onClose();
    });
  };

  return (
    <Dialog open={template !== null} onClose={onClose} className="max-w-md">
      <form
        className={cn((!loaded || pending) && "pointer-events-none opacity-60")}
        aria-busy={!loaded || pending}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <DialogBody className="pt-5">
          <div className="space-y-1.5">
            <DialogTitle>{t("title", { title: pageLabel(template?.title ?? "", tc("untitled")) })}</DialogTitle>
            <p className="text-sm text-fg-muted">{t("description")}</p>
          </div>

          {existing && !existing.enabled && existing.lastError && (
            <p role="status" className="rounded-md border border-border bg-bg-hover px-3 py-2 text-sm">
              {t(`paused.${existing.lastError}`)}
            </p>
          )}
          {existing?.enabled && existing.lastError === "failed" && (
            <p role="status" className="rounded-md border border-border bg-bg-hover px-3 py-2 text-sm">
              {t("paused.failed")}
            </p>
          )}

          <RepeatRuleFields form={form} onChange={set} idPrefix="repeat" />

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">
              {t("dateInTitle")}
            </span>
            <Switch checked={form.dateInTitle} onChange={(dateInTitle) => set({ dateInTitle })} label={t("dateInTitle")} />
          </div>

          <div className="space-y-0.5 text-sm text-fg-muted" aria-live="polite">
            {form.frequency === "monthly" && rule && <p>{t("monthlyHint", { day: Number(rule.start.slice(8)) })}</p>}
            {next && <p>{t("next", { date: formatAt(next) })}</p>}
            {existing?.lastRunAt && <p>{t("lastRun", { date: formatAt(existing.lastRunAt) })}</p>}
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          {existing && (
            <button
              type="button"
              onClick={turnOff}
              className="me-auto inline-flex h-8 items-center rounded-md px-3 text-sm font-medium text-danger hover:bg-bg-hover"
            >
              {t("turnOff")}
            </button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid || pending || !loaded}>
            {pending ? tc("saving") : tc("save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
