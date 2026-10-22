"use client";

import { Send } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { createTelegramLinkAction, getTelegramStatusAction, unlinkTelegramAction } from "@/app/actions/telegram";
import { QrCode } from "@/components/security/qr-code";
import { Button, buttonClass } from "@/components/ui";
import type { TelegramStatus } from "@/server/telegram/links";

/** How often the settings ask whether the bot was opened with the link yet. */
const CHECK_EVERY_MS = 3_000;

/**
 * Settings > Apps > Telegram: links the person's Telegram account to the AI chat (see
 * server/telegram). Linking opens the bot with a one-time code, as a link and a QR code for a
 * phone; the settings notice when the bot has been started with it.
 */
export function TelegramLink({ initial }: { initial: TelegramStatus }) {
  const t = useTranslations("account.telegram");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const [status, setStatus] = useState(initial);
  const [pending, setPending] = useState<{ url: string; expiresAt: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, startTransition] = useTransition();

  // While a link is open, check for it being used, until it runs out.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      if (Date.parse(pending.expiresAt) < Date.now()) {
        setPending(null);
        return;
      }
      const result = await getTelegramStatusAction().catch(() => null);
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
      const result = await createTelegramLinkAction();
      if (result.ok) setPending(result.data);
      else setError(result.error);
    });

  const unlink = () =>
    act(async () => {
      const result = await unlinkTelegramAction();
      if (result.ok) {
        setStatus(result.data);
        setConfirming(false);
      } else setError(result.error);
    });

  const linked = status.link;
  return (
    <div className="px-5 py-4">
      {linked ? (
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
            {status.bot && (
              <a href={`https://t.me/${status.bot}`} target="_blank" rel="noreferrer" className={buttonClass({ size: "sm" })}>
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
      ) : pending ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <QrCode value={pending.url} label={t("qrLabel")} size={144} />
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-sm">{t("steps")}</p>
            <div className="flex flex-wrap gap-2">
              <a href={pending.url} target="_blank" rel="noreferrer" className={buttonClass({ variant: "primary", size: "sm" })}>
                <Send className="h-3.5 w-3.5" aria-hidden />
                {t("openWithCode")}
              </a>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                {t("cancel")}
              </Button>
            </div>
            <p className="text-xs text-fg-muted" aria-live="polite">
              {t("waiting", { time: format.relativeTime(new Date(pending.expiresAt), now) })}
            </p>
          </div>
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
