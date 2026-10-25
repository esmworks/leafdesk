"use server";

import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { AccessError } from "@/server/access";
import { handlePageReport, reportPublishedPage, ReportError } from "@/server/page-reports";
import { getSession, requireUserId } from "@/server/session";

export type PageReportResult = { ok: true } | { ok: false; error: string };

/**
 * The report form at `/s/<key>/report` (a plain form, no script): reports the page, signed in or
 * not, and comes back to the form with `sent=1`, or `error=` the ReportError code (`failed` for
 * anything else). A report dropped as spam, or about a page that isn't served there, comes back
 * like any other.
 */
export async function submitPageReportAction(form: FormData) {
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const key = field("key");
  const pageId = field("page");
  const [session, h] = await Promise.all([getSession(), headers()]);
  let outcome = "sent=1";
  try {
    await reportPublishedPage(
      key,
      pageId,
      { reason: field("reason"), details: field("details"), email: field("email"), honeypot: field("website") },
      { userId: session?.user.id ?? null, ip: h.get(CLIENT_IP_HEADER) ?? "unknown" },
    );
  } catch (error) {
    if (!(error instanceof ReportError)) console.error("[report page]", error);
    outcome = `error=${error instanceof ReportError ? error.code : "failed"}`;
  }
  redirect(`/s/${encodeURIComponent(key)}/report?page=${encodeURIComponent(pageId)}&${outcome}`);
}

/** Dismisses a report, or takes the page it is about off the web (Settings > Security). Owners only. */
export async function handlePageReportAction(workspaceId: string, reportId: string, action: "dismiss" | "unpublish"): Promise<PageReportResult> {
  const userId = await requireUserId();
  const t = await getTranslations();
  if (typeof workspaceId !== "string" || typeof reportId !== "string" || (action !== "dismiss" && action !== "unpublish")) {
    return { ok: false, error: t("common.genericError") };
  }
  try {
    await handlePageReport(userId, workspaceId, reportId, action);
    revalidatePath(`/w/${workspaceId}/settings`);
    return { ok: true };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, error: t("settings.security.pageReports.gone") };
    console.error("[handle page report]", error);
    return { ok: false, error: t("common.genericError") };
  }
}
