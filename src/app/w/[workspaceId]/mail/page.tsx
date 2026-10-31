import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MailApp } from "@/components/mail/mail-app";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { buttonClass } from "@/components/ui";
import { aiAvailable } from "@/server/ai-writing";
import { mailTabShown } from "@/server/mail-client/read";
import { requireWorkspaceSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mail");
  return { title: t("metaTitle") };
}

/** The Mail tab's page: the person's own mailboxes in the workspace (server/mail-client). */
export default async function MailPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { user } = await requireWorkspaceSession(workspaceId);
  if (!(await mailTabShown(user.id, workspaceId))) {
    const t = await getTranslations("mail");
    return (
      <>
        <div className="h-0">
          <SidebarOpenButton className="m-2" />
        </div>
        <div className="mx-auto max-w-md px-6 py-20 text-center">
          <h1 className="text-lg font-semibold">{t("noMailboxTitle")}</h1>
          <p className="mt-2 text-sm text-fg-muted">{t("noMailboxText")}</p>
          <Link href="/account?tab=mail" className={`${buttonClass({ variant: "primary" })} mt-5`}>
            {t("noMailboxAction")}
          </Link>
        </div>
      </>
    );
  }
  return <MailApp workspaceId={workspaceId} ai={await aiAvailable(workspaceId)} />;
}
