"use client";

import { useTranslations } from "next-intl";
import { deleteOwnCalendarFeedAction } from "@/app/actions/databases";
import { ConfirmButton } from "@/components/settings/confirm-button";

/** Turns off one of the person's calendar addresses: whoever subscribed with it stops getting rows. */
export function CalendarFeedOffButton({ feedId }: { feedId: string }) {
  const t = useTranslations("account.mail");
  return (
    <ConfirmButton
      label={t("turnOff")}
      confirmLabel={t("turnOffConfirm")}
      working={t("turningOff")}
      failed={t("turnOffError")}
      act={async () => {
        const result = await deleteOwnCalendarFeedAction(feedId);
        return result.ok ? null : result.error;
      }}
    />
  );
}
