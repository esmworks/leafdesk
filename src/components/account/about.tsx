import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { SettingsGroup, SettingsHeader, SettingsRow } from "@/components/settings/section";
import { APP_INFO } from "@/server/app-info";

function Outbound({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm hover:underline">
      {children}
      <ExternalLink className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
    </a>
  );
}

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Which Leafdesk this server runs, who makes it, its license and where to read more or report a problem. */
export async function AboutLeafdesk() {
  const t = await getTranslations("account.about");
  const ta = await getTranslations("account");
  return (
    <>
      <SettingsHeader title={ta("nav.about")} description={t("description")} />
      <div className="space-y-10">
        <div className="flex items-center gap-4">
          <Logo className="h-9 w-auto" />
          <span className="text-sm text-fg-muted">{t("version", { version: APP_INFO.version })}</span>
        </div>
        <SettingsGroup>
          <SettingsRow
            title={t("versionLabel")}
            description={APP_INFO.version}
            control={<Outbound href={APP_INFO.releaseNotes}>{t("releaseNotes")}</Outbound>}
          />
          <SettingsRow title={t("author")} control={<Outbound href={APP_INFO.authorUrl}>{APP_INFO.author}</Outbound>} />
          <SettingsRow
            title={t("license")}
            description={t("licenseDescription")}
            control={<Outbound href={APP_INFO.licenseText}>{APP_INFO.license}</Outbound>}
          />
          <SettingsRow title={t("website")} control={<Outbound href={APP_INFO.homepage}>{bare(APP_INFO.homepage)}</Outbound>} />
          <SettingsRow title={t("source")} control={<Outbound href={APP_INFO.repository}>{bare(APP_INFO.repository)}</Outbound>} />
          <SettingsRow
            title={t("issues")}
            description={t("issuesDescription")}
            control={<Outbound href={APP_INFO.issues}>{t("issuesLink")}</Outbound>}
          />
        </SettingsGroup>
        <p className="text-sm text-fg-muted">
          {t.rich("notice", {
            link: (chunks) => (
              <a href={APP_INFO.notice} target="_blank" rel="noreferrer" className="underline hover:text-fg">
                {chunks}
              </a>
            ),
          })}
        </p>
      </div>
    </>
  );
}
