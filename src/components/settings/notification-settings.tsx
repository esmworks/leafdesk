"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { setNotificationPreferenceAction } from "@/app/actions/preferences";
import { subscribePushAction, unsubscribePushAction } from "@/app/actions/push";
import { Button, Switch } from "@/components/ui";
import type { PreferenceKind } from "@/db/schema";
import { INBOX_PREFERENCES_EVENT } from "@/lib/inbox-event";
import type { NotificationChannel, NotificationPreferences } from "@/server/notification-preferences";
import { appWorker, base64UrlToBytes, madeWithKey, pushSupported } from "./push-device";
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
} as const satisfies Record<PreferenceKind, string>;
/**
 * Settings > Preferences: for each kind of notification, whether it shows in the inbox, comes by
 * email and, when the server can send them (`push`), comes as a push notification; and whether
 * this device gets push notifications at all.
 */
export function NotificationSettings({
  preferences,
  push,
}: {
  preferences: NotificationPreferences;
  /** The server's VAPID public key and the endpoints of the user's devices; null when push is off. */
  push: { publicKey: string; endpoints: string[] } | null;
}) {
  const channels: NotificationChannel[] = push ? ["inbox", "email", "push"] : ["inbox", "email"];
  return (
    <>
      {push && <PushDeviceRow publicKey={push.publicKey} endpoints={push.endpoints} />}
      {(Object.keys(KIND_KEYS) as PreferenceKind[]).map((kind) => (
        <NotificationKindRow key={kind} kind={kind} channels={channels} initial={preferences[kind]} />
      ))}
    </>
  );
}

function NotificationKindRow({
  kind,
  channels,
  initial,
}: {
  kind: PreferenceKind;
  channels: NotificationChannel[];
  initial: Record<NotificationChannel, boolean>;
}) {
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
          {channels.map((channel) => (
            <span key={channel} className="flex items-center gap-2 text-sm text-fg-muted">
              <span aria-hidden>{t(channel)}</span>
              <Switch
                // Push follows the inbox: off (and locked) while the kind stays out of the inbox.
                checked={channel === "push" ? values.push && values.inbox : values[channel]}
                label={t(`${key}Channel`, { channel: t(channel) })}
                disabled={pending || (channel === "push" && !values.inbox)}
                onChange={(next) => change(channel, next)}
              />
            </span>
          ))}
        </div>
      }
    />
  );
}

type DeviceState = "checking" | "unsupported" | "blocked" | "off" | "on";

/**
 * Push notifications on this browser: asks for permission, subscribes with the server's key and
 * hands the subscription to the server; turning off does the reverse. "On" only while the browser
 * has a subscription made with the current key that the server still knows (it forgets it at
 * sign-out, or when the push service says it is gone).
 */
function PushDeviceRow({ publicKey, endpoints }: { publicKey: string; endpoints: string[] }) {
  const t = useTranslations("settings.notifications");
  const [state, setState] = useState<DeviceState>("checking");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await (async (): Promise<DeviceState> => {
        if (!pushSupported()) return "unsupported";
        if (Notification.permission === "denied") return "blocked";
        const worker = await appWorker();
        if (!worker) return "unsupported";
        const subscription = await worker.pushManager.getSubscription().catch(() => null);
        const known =
          subscription && Notification.permission === "granted" && madeWithKey(subscription, base64UrlToBytes(publicKey)) && endpoints.includes(subscription.endpoint);
        return known ? "on" : "off";
      })().catch((): DeviceState => "unsupported");
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [publicKey, endpoints]);

  const turnOn = async () => {
    const permission = await Notification.requestPermission();
    if (permission === "denied") return setState("blocked");
    if (permission !== "granted") return;
    const worker = await appWorker();
    if (!worker) return setState("unsupported");
    const key = base64UrlToBytes(publicKey);
    let subscription = await worker.pushManager.getSubscription();
    if (subscription && !madeWithKey(subscription, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const { endpoint, keys } = subscription.toJSON();
    const result = await subscribePushAction({ endpoint: endpoint ?? "", p256dh: keys?.p256dh ?? "", auth: keys?.auth ?? "" });
    if (!result.ok) {
      if (result.error === "invalid") await subscription.unsubscribe().catch(() => false);
      throw new Error(result.error);
    }
    setState("on");
  };

  const turnOff = async () => {
    const worker = await appWorker();
    const subscription = await worker?.pushManager.getSubscription();
    if (subscription) {
      await unsubscribePushAction(subscription.endpoint);
      await subscription.unsubscribe().catch(() => false);
    }
    setState("off");
  };

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    action()
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };

  const description = {
    checking: t("pushDeviceOff"),
    unsupported: t("pushDeviceUnsupported"),
    blocked: t("pushDeviceBlocked"),
    off: t("pushDeviceOff"),
    on: t("pushDeviceOn"),
  }[state];

  return (
    <SettingsRow
      title={t("pushDeviceTitle")}
      description={error ? <span className="text-danger">{t("pushDeviceError")}</span> : description}
      control={
        state === "on" ? (
          <Button disabled={busy} onClick={() => run(turnOff)}>
            {t("pushTurnOff")}
          </Button>
        ) : state === "off" || state === "checking" ? (
          <Button variant="primary" disabled={busy || state === "checking"} onClick={() => run(turnOn)}>
            {t("pushTurnOn")}
          </Button>
        ) : null
      }
    />
  );
}
