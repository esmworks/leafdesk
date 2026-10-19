import { Info, KeyRound, Plug, SlidersHorizontal, UserRound, type LucideIcon } from "lucide-react";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { AiAccountsGroup } from "@/components/account/ai-accounts-group";
import { AccountEmailSettings } from "@/components/account/email-settings";
import { AboutLeafdesk } from "@/components/account/about";
import { DeleteAccountSettings } from "@/components/account/delete-account";
import { PasswordSettings } from "@/components/account/password-settings";
import { ProfileSettings } from "@/components/account/profile-settings";
import { SessionList } from "@/components/account/session-list";
import { PasskeySettings } from "@/components/security/passkeys";
import { TwoFactorSettings } from "@/components/security/two-factor";
import { ApiTokens } from "@/components/settings/api-tokens";
import { ConnectedApps } from "@/components/settings/connected-apps";
import { LanguageSettings } from "@/components/settings/language-settings";
import { McpInstructions } from "@/components/settings/mcp-instructions";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { WatchedPages } from "@/components/settings/watched-pages";
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import { ContrastSettings, ThemeSettings } from "@/components/settings/theme-settings";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { CONTRAST_COOKIE, isContrast, isTheme, THEME_COOKIE } from "@/lib/theme";
import { getAccountOverview, deletionPlanFor, emailChangeEnabled, proofSetupOf } from "@/server/account";
import { getAccountSecurity } from "@/server/account-security";
import { mailStatus } from "@/server/mail";
import { getNotificationPreferences } from "@/server/notification-preferences";
import { listWatches } from "@/server/page-watch";
import { pushEndpoints, vapidPublicKey } from "@/server/push";
import type { requireSession } from "@/server/session";
import { env } from "@/lib/env";
import { isInstanceAdmin } from "@/lib/instance-admin";
import { storageNoticeOf } from "@/lib/workspace-storage";
import { getStorageAccounts } from "@/server/storage/accounts";
import { AccountStorage } from "@/components/settings/account-storage";

/**
 * The signed-in person's own settings, shown in two places: under Settings in a workspace (the
 * usual way in) and on the account page (/account), which stays open outside any workspace to
 * someone a workspace's two-step policy holds back or who has no workspace at all.
 */
export const ACCOUNT_TABS = ["profile", "security", "preferences", "apps", "about"] as const;
export type AccountTab = (typeof ACCOUNT_TABS)[number];
export const ACCOUNT_ICONS: Record<AccountTab, LucideIcon> = {
  profile: UserRound,
  security: KeyRound,
  preferences: SlidersHorizontal,
  apps: Plug,
  about: Info,
};

type Session = Awaited<ReturnType<typeof requireSession>>;

export async function AccountTabContent({ tab, session, query = {} }: { tab: AccountTab; session: Session; query?: Record<string, string | string[] | undefined> }) {
  if (tab === "profile") return <ProfileTab session={session} />;
  if (tab === "security") return <SecurityTab session={session} />;
  if (tab === "preferences") return <PreferencesTab userId={session.user.id} />;
  if (tab === "about") return <AboutLeafdesk />;
  const [t, storage] = await Promise.all([getTranslations("account"), getStorageAccounts(session.user.id, { isAdmin: isInstanceAdmin(session.user) })]);
  return (
    <>
      <SettingsHeader title={t("nav.apps")} description={t("apps.description")} />
      <div className="space-y-10">
        <AccountStorage initial={storage} notice={storageNoticeOf(query)} />
        <ConnectedApps />
        {env.ownAiKeysEnabled && <AiAccountsGroup />}
        <McpInstructions />
        <ApiTokens />
      </div>
    </>
  );
}

async function ProfileTab({ session }: { session: Session }) {
  const [overview, plan, proof, t] = await Promise.all([
    getAccountOverview(session),
    deletionPlanFor(session.user.id),
    proofSetupOf(session),
    getTranslations("account"),
  ]);
  return (
    <>
      <SettingsHeader title={t("nav.profile")} description={t("profile.description")} />
      <div className="space-y-10">
        <SettingsGroup title={t("profile.heading")}>
          <ProfileSettings name={overview.name} image={overview.image} />
        </SettingsGroup>
        {/* On one computer the account's address is the app's own and reaches nobody: nothing to change or verify. */}
        {!env.localMode && (
          <SettingsGroup title={t("email.heading")}>
            <AccountEmailSettings
              email={overview.email}
              emailVerified={overview.emailVerified}
              pendingEmail={overview.pendingEmail}
              enabled={emailChangeEnabled()}
              proof={proof}
            />
          </SettingsGroup>
        )}
        <SettingsGroup title={t("delete.heading")}>
          <DeleteAccountSettings email={overview.email} plan={plan} proof={proof} />
        </SettingsGroup>
      </div>
    </>
  );
}

async function SecurityTab({ session }: { session: Session }) {
  const [overview, security, proof, t, ts] = await Promise.all([
    getAccountOverview(session),
    getAccountSecurity(session.user.id),
    proofSetupOf(session),
    getTranslations("account"),
    getTranslations("security"),
  ]);
  return (
    <>
      <SettingsHeader title={t("nav.security")} description={ts("description")} />
      <div className="space-y-10">
        <SettingsGroup title={t("password.heading")}>
          <PasswordSettings hasPassword={overview.hasPassword} providers={overview.providers} proof={proof} />
        </SettingsGroup>
        <SettingsGroup title={ts("twoFactor.heading")} description={ts("twoFactor.headingDescription")}>
          <TwoFactorSettings enabled={security.twoFactorEnabled} hasPassword={security.hasPassword} />
        </SettingsGroup>
        <SettingsGroup title={ts("passkeys.heading")} description={ts("passkeys.headingDescription")}>
          <PasskeySettings passkeys={security.passkeys} />
        </SettingsGroup>
        <SessionList sessions={overview.sessions} />
        <p className="text-sm text-fg-muted">{ts("connectedAppsNote")}</p>
      </div>
    </>
  );
}

async function PreferencesTab({ userId }: { userId: string }) {
  const publicKey = vapidPublicKey();
  const [cookieStore, notificationPreferences, watches, endpoints, t, ts] = await Promise.all([
    cookies(),
    getNotificationPreferences(userId),
    listWatches(userId),
    publicKey ? pushEndpoints(userId) : [],
    getTranslations("account"),
    getTranslations("settings"),
  ]);
  const savedLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const savedTheme = cookieStore.get(THEME_COOKIE)?.value;
  const savedContrast = cookieStore.get(CONTRAST_COOKIE)?.value;
  return (
    <>
      <SettingsHeader title={t("nav.preferences")} description={ts("preferences.description")} />
      <div className="space-y-10">
        <SettingsGroup title={ts("language.heading")}>
          <LanguageSettings current={isLocale(savedLocale) ? savedLocale : null} />
        </SettingsGroup>
        <SettingsGroup title={ts("theme.heading")}>
          <ThemeSettings current={isTheme(savedTheme) ? savedTheme : null} />
          <ContrastSettings current={isContrast(savedContrast) ? savedContrast : null} />
        </SettingsGroup>
        <SettingsGroup
          title={ts("notifications.heading")}
          description={
            <>
              {ts("notifications.description")}
              {publicKey && <> {ts("notifications.pushDescription")}</>}
              {/* On one computer email isn't offered at all, so there is nothing to explain. */}
              {mailStatus() === "disabled" && !env.localMode && <> {ts("notifications.mailOff")}</>}
            </>
          }
        >
          <NotificationSettings preferences={notificationPreferences} push={publicKey ? { publicKey, endpoints } : null} />
        </SettingsGroup>
        <SettingsGroup title={ts("notifications.watchedHeading")} description={ts("notifications.watchedDescription")}>
          <WatchedPages pages={watches.pages} teamspaces={watches.teamspaces} />
        </SettingsGroup>
      </div>
    </>
  );
}
