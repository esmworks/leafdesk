import { getTranslations } from "next-intl/server";
import { SettingsGroup } from "@/components/settings/section";
import { getTeamsStatus } from "@/server/teams/links";
import { TeamsLink } from "./teams-link";

/** Settings > Apps > Teams, on servers with a Teams bot (TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID). */
export async function TeamsGroup({ userId }: { userId: string }) {
  const [status, t] = await Promise.all([getTeamsStatus(userId), getTranslations("account.teams")]);
  if (!status.enabled) return null;
  return (
    <SettingsGroup anchor="teams" title={t("title")} description={t("description")}>
      <TeamsLink initial={status} />
    </SettingsGroup>
  );
}
