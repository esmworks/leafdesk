import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { AccessError } from "@/server/access";
import { JiraError } from "@/server/jira-sync/client";
import { requireUserId } from "@/server/session";
import { SyncSetupLimited } from "@/server/sync-setup";
import { TeamspaceError } from "@/server/teamspaces";

/**
 * What the Zendesk and Salesforce actions share: runs `fn` as the signed-in person and answers an
 * expected failure translated (Next.js hides thrown messages). Not a "use server" file: only the
 * actions that call it are.
 */
export async function crmRun<T>(source: "zendesk" | "salesforce", fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    if (error instanceof JiraError) {
      // Zendesk refuses no query, and neither source has a limit on how much it takes.
      const code = error.code === "tooManyIssues" || (source === "zendesk" && error.code === "badQuery") ? "failed" : error.code;
      if (source === "salesforce") {
        const t = await getTranslations("import.salesforce.errors");
        return { ok: false, error: code === "badQuery" && error.detail ? t("badQueryDetail", { detail: error.detail }) : t(code), code };
      }
      const t = await getTranslations("import.zendesk.errors");
      return { ok: false, error: t(code === "badQuery" ? "failed" : code), code };
    }
    if (error instanceof SyncSetupLimited) {
      const t = await getTranslations("import.errors");
      return { ok: false, error: t("rateLimited") };
    }
    if (error instanceof AccessError || error instanceof TeamspaceError) {
      const t = await getTranslations("database.errors");
      return { ok: false, error: t("accessDenied") };
    }
    console.error(`[${source} sync action]`, error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}
