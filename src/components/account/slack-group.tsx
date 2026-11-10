import { getTranslations } from "next-intl/server";
import { SettingsGroup } from "@/components/settings/section";
import { getSlackStatus } from "@/server/slack/links";
import { SlackLink } from "./slack-link";

/** Settings > Apps > Slack, on servers with a Slack app (SLACK_APP_TOKEN and SLACK_BOT_TOKEN). */
export async function SlackGroup({ userId }: { userId: string }) {
  const [status, t] = await Promise.all([getSlackStatus(userId), getTranslations("account.slack")]);
  if (!status.enabled) return null;
  return (
    <SettingsGroup anchor="slack" title={t("title")} description={t("description")}>
      <SlackLink initial={status} />
    </SettingsGroup>
  );
}
