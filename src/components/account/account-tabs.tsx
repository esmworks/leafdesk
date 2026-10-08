import { KeyRound, Plug, SlidersHorizontal, UserRound, type LucideIcon } from "lucide-react";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { AccountEmailSettings } from "@/components/account/email-settings";
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
import { SettingsGroup, SettingsHeader } from "@/components/settings/section";
import { ThemeSettings } from "@/components/settings/theme-settings";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { FRESH_SIGN_IN_MINUTES, proofKindFor } from "@/lib/account";
import { isTheme, THEME_COOKIE } from "@/lib/theme";
import { getAccountOverview, deletionPlanFor, emailChangeEnabled } from "@/server/account";
import { getAccountSecurity } from "@/server/account-security";
import { mailStatus } from "@/server/mail";
import { getNotificationPreferences } from "@/server/notification-preferences";
import { pushEndpoints, vapidPublicKey } from "@/server/push";
import type { requireSession } from "@/server/session";

/**
 * The signed-in person's own settings, shown in two places: under Settings in a workspace (the
 * usual way in) and on the account page (/account), which stays open outside any workspace to
 * someone a workspace's two-step policy holds back or who has no workspace at all.
 */
export const ACCOUNT_TABS = ["profile", "security", "preferences", "apps"] as const;
export type AccountTab = (typeof ACCOUNT_TABS)[number];
export const ACCOUNT_ICONS: Record<AccountTab, LucideIcon> = {
  profile: UserRound,
  security: KeyRound,
  preferences: SlidersHorizontal,
  apps: Plug,
};

type Session = Awaited<ReturnType<typeof requireSession>>;

export async function AccountTabContent({ tab, session }: { tab: AccountTab; session: Session }) {
  if (tab === "profile") return <ProfileTab session={session} />;
  if (tab === "security") return <SecurityTab session={session} />;
  if (tab === "preferences") return <PreferencesTab userId={session.user.id} />;
  const t = await getTranslations("account");
  return (
    <>
      <SettingsHeader title={t("nav.apps")} description={t("apps.description")} />
      <div className="space-y-10">
        <ConnectedApps />
        <McpInstructions />
        <ApiTokens />
      </div>
    </>
  );
}

/** Whether the session was signed in recently enough to confirm changes without a password or code. */
function signedInRecently(session: Session) {
  return Date.now() - new Date(session.session.createdAt).getTime() < FRESH_SIGN_IN_MINUTES * 60_000;
}

async function ProfileTab({ session }: { session: Session }) {
  const [overview, plan, t] = await Promise.all([
    getAccountOverview(session),
    deletionPlanFor(session.user.id),
    getTranslations("account"),
  ]);
  const proof = { kind: proofKindFor(overview), recent: signedInRecently(session) };
  return (
    <>
      <SettingsHeader title={t("nav.profile")} description={t("profile.description")} />
      <div className="space-y-10">
        <SettingsGroup title={t("profile.heading")}>
          <ProfileSettings name={overview.name} image={overview.image} />
        </SettingsGroup>
        <SettingsGroup title={t("email.heading")}>
          <AccountEmailSettings
            email={overview.email}
            emailVerified={overview.emailVerified}
            pendingEmail={overview.pendingEmail}
            enabled={emailChangeEnabled()}
            proof={proof}
          />
        </SettingsGroup>
        <SettingsGroup title={t("delete.heading")}>
          <DeleteAccountSettings email={overview.email} plan={plan} proof={proof} />
        </SettingsGroup>
      </div>
    </>
  );
}

async function SecurityTab({ session }: { session: Session }) {
  const [overview, security, t, ts] = await Promise.all([
    getAccountOverview(session),
    getAccountSecurity(session.user.id),
    getTranslations("account"),
    getTranslations("security"),
  ]);
  const proof = { kind: proofKindFor(overview), recent: signedInRecently(session) };
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
  const [cookieStore, notificationPreferences, endpoints, t, ts] = await Promise.all([
    cookies(),
    getNotificationPreferences(userId),
    publicKey ? pushEndpoints(userId) : [],
    getTranslations("account"),
    getTranslations("settings"),
  ]);
  const savedLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const savedTheme = cookieStore.get(THEME_COOKIE)?.value;
  return (
    <>
      <SettingsHeader title={t("nav.preferences")} description={ts("preferences.description")} />
      <div className="space-y-10">
        <SettingsGroup title={ts("language.heading")}>
          <LanguageSettings current={isLocale(savedLocale) ? savedLocale : null} />
        </SettingsGroup>
        <SettingsGroup title={ts("theme.heading")}>
          <ThemeSettings current={isTheme(savedTheme) ? savedTheme : null} />
        </SettingsGroup>
        <SettingsGroup
          title={ts("notifications.heading")}
          description={
            <>
              {ts("notifications.description")}
              {publicKey && <> {ts("notifications.pushDescription")}</>}
              {mailStatus() === "disabled" && <> {ts("notifications.mailOff")}</>}
            </>
          }
        >
          <NotificationSettings preferences={notificationPreferences} push={publicKey ? { publicKey, endpoints } : null} />
        </SettingsGroup>
      </div>
    </>
  );
}
