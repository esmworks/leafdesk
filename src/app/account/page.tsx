import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ACCOUNT_ICONS, ACCOUNT_TABS, AccountTabContent, type AccountTab } from "@/components/account/account-tabs";
import { SettingsNav } from "@/components/settings/settings-nav";
import { settingsTabForAccount } from "@/lib/settings-tabs";
import { instanceAdmin } from "@/server/first-admin";
import { listWorkspaces } from "@/server/pages";
import { blockedByWorkspacePolicy, requireSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("account");
  return { title: t("metaTitle") };
}

/**
 * The signed-in person's own account, outside any workspace (see components/account/account-tabs).
 * Someone who can open the workspace they came from (`?from=<workspace id>`, else their first) goes
 * to the same tab under that workspace's Settings; this page is for someone a workspace's two-step
 * policy holds back (they come here to set it up) and for someone with no workspace at all.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, query] = await Promise.all([requireSession(), searchParams]);
  const tab: AccountTab = ACCOUNT_TABS.find((name) => name === query.tab) ?? "profile";
  const [workspaces, t, isAdmin] = await Promise.all([listWorkspaces(session.user.id), getTranslations("account"), instanceAdmin(session.user)]);
  const from = workspaces.find((w) => w.id === query.from) ?? workspaces[0];
  if (from && !(await blockedByWorkspacePolicy(session, from.id))) {
    // A sign-in to storage came back here: what it says goes along.
    const notice = ["storageConnected", "storageError"].flatMap((name) => (typeof query[name] === "string" ? [`&${name}=${encodeURIComponent(query[name])}`] : [])).join("");
    redirect(`/w/${from.id}/settings?tab=${settingsTabForAccount(tab)}${notice}`);
  }
  const suffix = from && from.id !== workspaces[0]?.id ? `&from=${encodeURIComponent(from.id)}` : "";

  return (
    <div className="settings-type flex min-h-full flex-col md:flex-row">
      <SettingsNav
        label={t("title")}
        back={{ href: from ? `/w/${from.id}` : "/", label: from ? t("back", { workspace: from.name }) : t("backHome") }}
        groups={[
          {
            label: t("title"),
            items: [
              ...ACCOUNT_TABS.map((name) => ({
                href: `/account?tab=${name}${suffix}`,
                label: t(`nav.${name}`),
                icon: ACCOUNT_ICONS[name],
                active: tab === name,
              })),
              // Instance admins reach the server's administration from here too.
              ...(isAdmin
                ? [{ href: from ? `/admin?from=${encodeURIComponent(from.id)}` : "/admin", label: t("nav.admin"), icon: ShieldCheck }]
                : []),
            ],
          },
        ]}
      />
      <main className="min-w-0 flex-1 px-4 py-8 sm:px-8 md:py-12">
        <div className="mx-auto max-w-3xl">
          <AccountTabContent tab={tab} session={session} query={query} />
        </div>
      </main>
    </div>
  );
}
