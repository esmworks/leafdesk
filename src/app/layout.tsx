import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { AppShellSetup } from "@/components/offline/install-app";
import { StaleDeploymentReload } from "@/components/stale-deployment";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { TimeZoneCookie } from "@/components/time-zone-cookie";
import { clientMessages } from "@/i18n/messages";
import { isTheme, THEME_COLORS, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    title: { default: "Leafdesk", template: "%s · Leafdesk" },
    description: t("appDescription"),
    applicationName: "Leafdesk",
    // Added to the home screen on iOS it opens without Safari's bars; the manifest covers the rest.
    appleWebApp: { capable: true, title: "Leafdesk", statusBarStyle: "default" },
    formatDetection: { telephone: false },
  };
}

/** The theme chosen for this browser in Settings > Preferences, or null to follow the system. */
async function chosenTheme() {
  const theme = (await cookies()).get(THEME_COOKIE)?.value;
  return isTheme(theme) ? theme : null;
}

// The browser bar (and an installed app's title bar) takes the page background of the theme.
export async function generateViewport(): Promise<Viewport> {
  const theme = await chosenTheme();
  return {
    themeColor: theme
      ? THEME_COLORS[theme]
      : [
          { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
          { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
        ],
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, messages, theme] = await Promise.all([getLocale(), getMessages(), chosenTheme()]);
  return (
    <html lang={locale} data-theme={theme ?? undefined} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider messages={clientMessages(messages)}>
          <ThemeProvider theme={theme}>
            {children}
            <TimeZoneCookie />
            <StaleDeploymentReload />
            <AppShellSetup />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
