"use client";

import { Monitor, Smartphone, Tablet } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { revokeOtherSessionsAction, revokeSessionAction } from "@/app/actions/account";
import { SettingsGroup, SettingsRow } from "@/components/settings/section";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle } from "@/components/ui";
import { relativeTime } from "@/lib/relative-time";
import { parseUserAgent } from "@/lib/user-agent";
import type { SessionSummary } from "@/server/account";

const DEVICE_ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };
/** Sessions shown before "Show all": this one and the most recently used others. */
const SHOWN = 8;

/**
 * Account > Security > Sessions: every browser and device signed in to the account, this one
 * first. Any other can be signed out, or all of them at once. Long lists (scripts signing in
 * again and again) show the most recent ones until "Show all".
 */
export function SessionList({ sessions }: { sessions: SessionSummary[] }) {
  const t = useTranslations("account.sessions");
  const tc = useTranslations("common");
  const [confirmAll, setConfirmAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const others = sessions.filter((s) => !s.current).length;

  return (
    <SettingsGroup
      anchor="sessions"
      title={t("heading")}
      description={error ? <span className="text-danger">{error}</span> : t("description")}
      action={
        others > 0 ? (
          <Button size="sm" onClick={() => setConfirmAll(true)}>
            {t("revokeOthers")}
          </Button>
        ) : undefined
      }
    >
      {(expanded ? sessions : sessions.slice(0, SHOWN)).map((session) => (
        <SessionRow key={session.id} session={session} onError={setError} />
      ))}
      {!expanded && sessions.length > SHOWN && (
        <div className="px-5 py-3">
          <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
            {t("showAll", { count: sessions.length })}
          </Button>
        </div>
      )}
      {confirmAll && (
        <Dialog open onClose={() => setConfirmAll(false)} className="max-w-md">
          <DialogBody className="pt-5">
            <div className="space-y-1.5">
              <DialogTitle>{t("revokeOthersTitle")}</DialogTitle>
              <p className="text-sm text-fg-muted">{t("revokeOthersBody", { count: others })}</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmAll(false)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const result = await revokeOtherSessionsAction().catch(() => null);
                  if (!result?.ok) setError(result?.error ?? tc("genericError"));
                  setConfirmAll(false);
                })
              }
            >
              {t("revokeOthersConfirm")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </SettingsGroup>
  );
}

function SessionRow({ session, onError }: { session: SessionSummary; onError: (error: string | null) => void }) {
  const t = useTranslations("account.sessions");
  const tc = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const agent = parseUserAgent(session.userAgent);
  const Icon = DEVICE_ICONS[agent.device];
  const name =
    agent.browser && agent.os
      ? t("browserOn", { browser: agent.browser, os: agent.os })
      : agent.browser ?? agent.os ?? t("unknownDevice");
  const details = [
    session.ipAddress,
    t("signedIn", { date: format.dateTime(new Date(session.signedInAt), { dateStyle: "medium", timeStyle: "short" }) }),
    session.current ? null : t("lastActive", { when: relativeTime(session.lastActiveAt, locale) }),
  ].filter(Boolean);

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
          <span className="truncate">{name}</span>
          {session.current && <span className="text-xs font-normal text-accent">{t("current")}</span>}
        </span>
      }
      description={
        <span title={session.userAgent ?? undefined} suppressHydrationWarning>
          {details.join(" · ")}
        </span>
      }
      control={
        session.current ? undefined : (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                onError(null);
                const result = await revokeSessionAction(session.id).catch(() => null);
                if (!result?.ok) onError(result?.error ?? tc("genericError"));
              })
            }
          >
            {pending ? t("revoking") : t("revoke")}
          </Button>
        )
      }
    />
  );
}
