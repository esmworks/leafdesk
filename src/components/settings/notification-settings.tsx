"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setNotificationPreferenceAction } from "@/app/actions/preferences";
import { Switch } from "@/components/ui";
import type { NotificationKind } from "@/db/schema";
import { INBOX_PREFERENCES_EVENT } from "@/lib/inbox-event";
import type { NotificationChannel, NotificationPreferences } from "@/server/notification-preferences";
import { SettingsRow } from "./section";

const KIND_KEYS = {
  assignment: "assignment",
  page_shared: "share",
  comment: "comment",
  mention: "mention",
  reminder: "reminder",
  access_request: "accessRequest",
  join_request: "joinRequest",
  automation: "automation",
} as const satisfies Record<NotificationKind, string>;
const CHANNELS: NotificationChannel[] = ["inbox", "email"];

/** Settings > Preferences: for each kind of notification, whether it shows in the inbox and comes by email. */
export function NotificationSettings({ preferences }: { preferences: NotificationPreferences }) {
  return (
    <>
      {(Object.keys(KIND_KEYS) as NotificationKind[]).map((kind) => (
        <NotificationKindRow key={kind} kind={kind} initial={preferences[kind]} />
      ))}
    </>
  );
}

function NotificationKindRow({ kind, initial }: { kind: NotificationKind; initial: Record<NotificationChannel, boolean> }) {
  const t = useTranslations("settings.notifications");
  const tc = useTranslations("common");
  const [values, setValues] = useState(initial);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const key = KIND_KEYS[kind];

  const change = (channel: NotificationChannel, next: boolean) => {
    setValues((v) => ({ ...v, [channel]: next }));
    setError(false);
    startTransition(async () => {
      try {
        await setNotificationPreferenceAction(kind, channel, next);
        if (channel === "inbox") window.dispatchEvent(new Event(INBOX_PREFERENCES_EVENT));
      } catch {
        setValues((v) => ({ ...v, [channel]: !next }));
        setError(true);
      }
    });
  };

  return (
    <SettingsRow
      title={t(`${key}Title`)}
      description={error ? <span className="text-danger">{tc("genericError")}</span> : t(`${key}Description`)}
      control={
        <div className="flex items-center gap-4">
          {CHANNELS.map((channel) => (
            <span key={channel} className="flex items-center gap-2 text-sm text-fg-muted">
              <span aria-hidden>{t(channel)}</span>
              <Switch
                checked={values[channel]}
                label={t(`${key}Channel`, { channel: t(channel) })}
                disabled={pending}
                onChange={(next) => change(channel, next)}
              />
            </span>
          ))}
        </div>
      }
    />
  );
}
