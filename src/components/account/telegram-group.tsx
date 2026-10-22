import { getTranslations } from "next-intl/server";
import { SettingsGroup } from "@/components/settings/section";
import { getTelegramStatus } from "@/server/telegram/links";
import { TelegramLink } from "./telegram-link";

/** Settings > Apps > Telegram, on servers with a Telegram bot (TELEGRAM_BOT_TOKEN). */
export async function TelegramGroup({ userId }: { userId: string }) {
  const [status, t] = await Promise.all([getTelegramStatus(userId), getTranslations("account.telegram")]);
  if (!status.enabled) return null;
  return (
    <SettingsGroup title={t("title")} description={t("description")}>
      <TelegramLink initial={status} />
    </SettingsGroup>
  );
}
