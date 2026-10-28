"use client";

import { Mail } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  leaveDashboardEmailAction,
  listDashboardEmailsAction,
  removeDashboardEmailAction,
  sendTestDashboardEmailAction,
  setDashboardEmailAction,
  type DashboardEmailsData,
} from "@/app/actions/dashboard-emails";
import { useRuleSummary } from "@/components/settings/rule-summary";
import { freshRepeatForm, RepeatRuleFields, repeatFormOf, useRepeatRule, type RepeatForm } from "@/components/repeat-rule-fields";
import { UserAvatar } from "@/components/user-avatar";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, Input, selectClass } from "@/components/ui";
import { defaultSubscriptionPeriod, SUBSCRIPTION_PERIODS, type DashboardEmailTarget, type SubscriptionPeriod } from "@/lib/dashboard-emails";
import { searchFold } from "@/lib/search-fold";
import type { DashboardEmailView } from "@/server/dashboard-emails";

type Form = RepeatForm & { period: SubscriptionPeriod; periodPicked: boolean; recipients: string[] };

/** A new email: every Monday at 08:00 in the browser's time zone, for last week, to the viewer. */
function freshForm(viewerId: string): Form {
  const repeat = freshRepeatForm({ frequency: "weekly", time: "08:00" });
  return { ...repeat, weekdays: [1], period: "last_week", periodPicked: false, recipients: [viewerId] };
}

/**
 * Emailing a dashboard on a schedule (server/dashboard-emails): its subscriptions, and the form
 * that sets one up or changes it. Each recipient gets the figures they can see, so the list of
 * people to pick from is everyone who can open the page; emailing others takes edit access.
 */
export default function DashboardEmailsDialog({
  open,
  onClose,
  pageId,
  target,
}: {
  open: boolean;
  onClose: () => void;
  pageId: string;
  target: DashboardEmailTarget;
}) {
  const t = useTranslations("page.dashboard.emails");
  const tc = useTranslations("common");
  const [data, setData] = useState<DashboardEmailsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [pending, startTransition] = useTransition();
  const targetKey = JSON.stringify(target);

  const load = useCallback(async () => {
    const result = await listDashboardEmailsAction(pageId, JSON.parse(targetKey));
    if (!result.ok) return setError(result.error);
    setError(null);
    setData(result.data);
  }, [pageId, targetKey]);

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    setData(null);
    void load();
  }, [open, load]);

  const act = (work: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return setError(result.error);
      setError(null);
      await load();
    });

  // On the body, not inside the block: in a page the dashboard sits in the editor, whose text
  // styles and key handling would reach the form.
  return createPortal(
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogHeader title={t("title")} description={t("description")} onClose={onClose} closeLabel={tc("close")} />
      {data?.mailEnabled && editing ? (
        <EmailForm
          data={data}
          pageId={pageId}
          target={target}
          id={editing.id}
          initial={editing.form}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : (
        <>
          <DialogBody className={cn(pending && "opacity-60")} aria-busy={pending || !data}>
            {error && !editing && <p className="text-xs text-danger">{error}</p>}
            {!data ? (
              !error && <div aria-hidden className="h-16 animate-pulse rounded-md bg-bg-subtle" />
            ) : !data.mailEnabled ? (
              <p role="status" className="rounded-md border border-border bg-bg-hover px-3 py-2 text-sm">
                {t("noMail")}
              </p>
            ) : data.subscriptions.length === 0 ? (
              <p className="text-sm text-fg-muted">{t("none")}</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {data.subscriptions.map((s) => (
                  <SubscriptionItem
                    key={s.id}
                    subscription={s}
                    viewerId={data.viewerId}
                    onEdit={() =>
                      setEditing({
                        id: s.id,
                        form: { ...repeatFormOf(s.rule, s.timeZone), period: s.period, periodPicked: true, recipients: s.recipients.map((r) => r.id) },
                      })
                    }
                    onStop={() => act(() => removeDashboardEmailAction(s.id))}
                    onLeave={() => act(() => leaveDashboardEmailAction(s.id))}
                  />
                ))}
              </ul>
            )}
          </DialogBody>
          {data?.mailEnabled && (
            <DialogFooter className={cn(pending && "opacity-60")}>
              <Button variant="primary" onClick={() => setEditing({ id: null, form: freshForm(data.viewerId) })}>
                <Mail className="h-3.5 w-3.5" />
                {t("add")}
              </Button>
            </DialogFooter>
          )}
        </>
      )}
    </Dialog>,
    document.body,
  );
}

/** "Last week", "The dashboard's period". */
function usePeriodChoiceName() {
  const t = useTranslations("page.dashboard.emails.periods");
  return (period: SubscriptionPeriod) => t(period);
}

function SubscriptionItem({
  subscription: s,
  viewerId,
  onEdit,
  onStop,
  onLeave,
}: {
  subscription: DashboardEmailView;
  viewerId: string;
  onEdit: () => void;
  onStop: () => void;
  onLeave: () => void;
}) {
  const t = useTranslations("page.dashboard.emails");
  const locale = useLocale();
  const summary = useRuleSummary();
  const periodName = usePeriodChoiceName();
  const names = s.recipients.map((r) => (r.id === viewerId ? t("you") : r.name)).join(", ");
  const formatAt = (at: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: s.timeZone }).format(new Date(at));
  return (
    <li className="space-y-1 px-3 py-2.5">
      <p className="text-sm font-medium">{t("summary", { schedule: summary(s.rule, s.timeZone), period: periodName(s.period) })}</p>
      <p className="text-xs text-fg-muted">{t("to", { names })}</p>
      {s.setBy && s.setBy.id !== viewerId && <p className="text-xs text-fg-muted">{t("setBy", { name: s.setBy.name })}</p>}
      {!s.enabled && s.lastError ? (
        <p role="status" className="text-xs text-danger">
          {t(`paused.${s.lastError}`)}
        </p>
      ) : (
        <p className="text-xs text-fg-muted">
          {s.nextRunAt && t("next", { date: formatAt(s.nextRunAt) })}
          {s.lastRunAt && ` · ${t("lastSent", { date: formatAt(s.lastRunAt) })}`}
          {s.lastError === "failed" && ` · ${t("paused.failed")}`}
        </p>
      )}
      <div className="flex flex-wrap gap-1 pt-0.5">
        {s.canChange && (
          <>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              {t("edit")}
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" onClick={onStop}>
              {t("stop")}
            </Button>
          </>
        )}
        {s.receives && (s.recipients.length > 1 || !s.canChange) && (
          <Button size="sm" variant="ghost" onClick={onLeave}>
            {t("leave")}
          </Button>
        )}
      </div>
    </li>
  );
}

function EmailForm({
  data,
  pageId,
  target,
  id,
  initial,
  onCancel,
  onSaved,
}: {
  data: DashboardEmailsData;
  pageId: string;
  target: DashboardEmailTarget;
  id: string | null;
  initial: Form;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("page.dashboard.emails");
  const tc = useTranslations("common");
  const locale = useLocale();
  const periodName = usePeriodChoiceName();
  const [form, setForm] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const { rule, valid, next } = useRepeatRule(form);
  const set = (change: Partial<Form>) =>
    setForm((f) => {
      const merged = { ...f, ...change };
      // Until a period is picked, it follows how often the email comes: last week for a weekly one.
      return merged.periodPicked ? merged : { ...merged, period: defaultSubscriptionPeriod(merged.frequency) };
    });
  const viewer = data.people.find((p) => p.id === data.viewerId);
  const others = data.canEmailOthers && data.people.length > 1;
  const shown = useMemo(() => {
    const words = searchFold(query.trim());
    return words ? data.people.filter((p) => searchFold(`${p.name} ${p.email}`).includes(words)) : data.people;
  }, [data.people, query]);
  const toggle = (personId: string) =>
    set({ recipients: form.recipients.includes(personId) ? form.recipients.filter((r) => r !== personId) : [...form.recipients, personId] });
  const input = rule && { rule, timeZone: form.timeZone, period: form.period };

  const save = () => {
    if (!input) return;
    setError(null);
    startTransition(async () => {
      const result = await setDashboardEmailAction(pageId, target, { ...input, recipients: form.recipients }, id);
      if (!result.ok) return setError(result.error);
      onSaved();
    });
  };
  const sendTest = () => {
    if (!input) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await sendTestDashboardEmailAction(pageId, target, input);
      if (!result.ok) return setError(result.error);
      setNotice(t("testSent", { email: viewer?.email ?? "" }));
    });
  };

  const label = "block text-xs font-medium text-fg-muted";
  return (
    <form
      className={cn(pending && "pointer-events-none")}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <DialogBody>
        <RepeatRuleFields form={form} onChange={set} idPrefix="dashboard-email" />
        <div className="space-y-1">
          <label htmlFor="dashboard-email-period" className={label}>
            {t("period")}
          </label>
          <select
            id="dashboard-email-period"
            className={selectClass}
            value={form.period}
            onChange={(e) => set({ period: e.target.value as SubscriptionPeriod, periodPicked: true })}
          >
            {SUBSCRIPTION_PERIODS.map((p) => (
              <option key={p} value={p}>
                {periodName(p)}
              </option>
            ))}
          </select>
          <p className="text-xs text-fg-muted">{t("periodHint")}</p>
        </div>
        <fieldset className="space-y-1.5">
          <legend className={label}>{t("recipients")}</legend>
          {others ? (
            <>
              {data.people.length > 8 && <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} aria-label={t("search")} />}
              <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
                {shown.map((p) => (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-bg-hover">
                      <input type="checkbox" checked={form.recipients.includes(p.id)} onChange={() => toggle(p.id)} className="accent-[var(--accent)]" />
                      <UserAvatar name={p.name} image={p.image} size="xs" />
                      <span className="min-w-0 flex-1 truncate">{p.id === data.viewerId ? t("you") : p.name}</span>
                      <span className="truncate text-xs text-fg-muted">{p.email}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-fg-muted">{t("recipientsHint")}</p>
            </>
          ) : (
            <p className="text-sm text-fg-muted">{t("recipientsSelf", { email: viewer?.email ?? "" })}</p>
          )}
        </fieldset>
        <div className="space-y-0.5 text-sm text-fg-muted" aria-live="polite">
          {next && <p>{t(id ? "next" : "nextSend", { date: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: form.timeZone }).format(next) })}</p>}
          {notice && <p>{notice}</p>}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" className="me-auto" onClick={sendTest} disabled={!valid || pending}>
          {t("sendTest")}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!valid || pending || form.recipients.length === 0}>
          {pending ? tc("saving") : tc("save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
