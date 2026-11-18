"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui";
import { DEFAULT_JIRA_INTERVAL, JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";
import { ZENDESK_TOKENS_URL, zendeskSiteUrl } from "@/lib/zendesk-sync";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to set a Zendesk sync up, once the account, email and token are given. */
export type ZendeskSetup = { site: string; email: string; token: string; intervalMinutes: number; title: string };

/**
 * The import dialog's Zendesk tab: the account's address, an agent's email address and API token,
 * how often to sync, and the database's name and place. The sign-in is checked with Zendesk when
 * the dialog submits. Tells the dialog the setup (or null while something is missing) as it changes.
 */
export function ZendeskTab({
  busy,
  destinationPicker,
  onSetup,
}: {
  busy: boolean;
  destinationPicker: React.ReactNode;
  onSetup: (setup: ZendeskSetup | null) => void;
}) {
  const t = useTranslations("import");
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_JIRA_INTERVAL);
  const [name, setName] = useState("");

  const address = zendeskSiteUrl(site);
  const complete = Boolean(address && email.trim() && token.trim());
  useEffect(() => {
    onSetup(complete ? { site, email, token, intervalMinutes, title: name } : null);
  }, [complete, site, email, token, intervalMinutes, name, onSetup]);

  return (
    <>
      <p className="text-sm text-fg-muted">{t("zendesk.help")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelClass}>{t("zendesk.site")}</span>
          <Input value={site} placeholder={t("zendesk.sitePlaceholder")} autoComplete="url" disabled={busy} onChange={(e) => setSite(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("zendesk.email")}</span>
          <Input type="email" value={email} autoComplete="off" disabled={busy} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("zendesk.token")}</span>
          <Input type="password" value={token} autoComplete="off" disabled={busy} onChange={(e) => setToken(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-fg-muted">
        {t("zendesk.tokenHelp")}{" "}
        <a href={ZENDESK_TOKENS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
          {t("zendesk.tokenLink")}
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>{t("csv.name")}</span>
          <Input value={name} maxLength={200} placeholder={address ? new URL(address).hostname : ""} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("jira.every")}</span>
          <select className={selectClass} value={intervalMinutes} disabled={busy} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
            {JIRA_INTERVALS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {t(`jira.intervals.${jiraIntervalKey(minutes)}`)}
              </option>
            ))}
          </select>
        </label>
        {destinationPicker}
      </div>
    </>
  );
}
