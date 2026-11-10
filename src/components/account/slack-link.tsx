"use client";

import { useFormatter, useNow, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { createSlackLinkAction, getSlackStatusAction, setSlackNotificationsAction, unlinkSlackAction } from "@/app/actions/slack";
import { CopyButton } from "@/components/settings/copy-button";
import { Button, buttonClass, Input, Switch } from "@/components/ui";
import type { SlackStatus } from "@/server/slack/links";

/** How often the settings ask whether the command was sent yet. */
const CHECK_EVERY_MS = 3_000;

/**
 * Settings > Apps > Slack: links the person's Slack account to the AI chat (see server/slack).
 * Linking shows the command with a one-time code to send in the direct message with the app
 * (`/leafdesk link <code>`); the settings notice when it has been sent.
 */
export function SlackLink({ initial }: { initial: SlackStatus }) {
  const t = useTranslations("account.slack");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const [status, setStatus] = useState(initial);
  const [pending, setPending] = useState<{ command: string; expiresAt: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, startTransition] = useTransition();
  const router = useRouter();

  // While a link is open, check for it being used, until it runs out.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      if (Date.parse(pending.expiresAt) < Date.now()) {
        setPending(null);
        return;
      }
      const result = await getSlackStatusAction().catch(() => null);
      if (result?.ok && result.data.link) {
        setStatus(result.data);
        setPending(null);
      }
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const act = (fn: () => Promise<void>) =>
    startTransition(async () => {
      setError(null);
      try {
        await fn();
      } catch {
        setError(t("unreachable"));
      }
    });

  const link = () =>
    act(async () => {
      const result = await createSlackLinkAction();
      if (result.ok) setPending(result.data);
      // A workspace's sign-in policy holds this session back: meet it first.
      else if ("gate" in result) router.push(result.gate);
      else setError(result.error);
    });

  const unlink = () =>
    act(async () => {
      const result = await unlinkSlackAction();
      if (result.ok) {
        setStatus(result.data);
        setConfirming(false);
      } else setError(result.error);
    });

  const notify = (on: boolean) =>
    act(async () => {
      setStatus((s) => (s.link ? { ...s, link: { ...s.link, notifications: on } } : s));
      const result = await setSlackNotificationsAction(on);
      if (result.ok) setStatus(result.data);
      else {
        setStatus((s) => (s.link ? { ...s, link: { ...s.link, notifications: !on } } : s));
        setError(result.error);
      }
    });

  const linked = status.link;
  return (
    <div className="px-5 py-4">
      {linked ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {linked.username ? t("linkedAs", { name: `@${linked.username}` }) : t("linkedAs", { name: linked.displayName || t("yourAccount") })}
              </div>
              <p className="mt-0.5 text-sm text-fg-muted">
                {t("linkedOn", { date: format.dateTime(new Date(linked.createdAt), { dateStyle: "medium" }) })}
                {" · "}
                {linked.lastUsedAt ? t("lastUsed", { time: format.relativeTime(new Date(linked.lastUsedAt), now) }) : t("neverUsed")}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              {status.openUrl && (
                <a href={status.openUrl} target="_blank" rel="noreferrer" className={buttonClass({ size: "sm" })}>
                  {t("open")}
                </a>
              )}
              {confirming ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={working}>
                    {t("cancel")}
                  </Button>
                  <Button size="sm" variant="danger" onClick={unlink} disabled={working}>
                    {working ? t("unlinking") : t("unlinkConfirm")}
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setConfirming(true)}>
                  {t("unlink")}
                </Button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-6 border-t border-border pt-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t("notifications")}</div>
              <p className="mt-0.5 text-sm text-fg-muted">{t("notificationsHint")}</p>
            </div>
            <Switch checked={linked.notifications} label={t("notifications")} disabled={working} onChange={notify} />
          </div>
        </div>
      ) : pending ? (
        <div className="space-y-3">
          <p className="text-sm">{t("steps", { bot: status.bot ? `@${status.bot}` : t("title") })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              readOnly
              value={pending.command}
              aria-label={t("commandLabel")}
              className="w-full font-mono sm:w-72"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton value={pending.command} />
            {status.openUrl && (
              <a href={status.openUrl} target="_blank" rel="noreferrer" className={buttonClass({ size: "sm" })}>
                {t("open")}
              </a>
            )}
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              {t("cancel")}
            </Button>
          </div>
          <p className="text-xs text-fg-muted" aria-live="polite">
            {t("waiting", { time: format.relativeTime(new Date(pending.expiresAt), now) })}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t("notLinked")}</div>
            <p className="mt-0.5 text-sm text-fg-muted">{status.bot ? t("notLinkedHint", { bot: `@${status.bot}` }) : t("unreachable")}</p>
          </div>
          <Button size="sm" variant="primary" className="shrink-0" onClick={link} disabled={working || !status.bot}>
            {working ? t("linking") : t("link")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
