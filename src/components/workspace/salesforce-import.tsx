"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui";
import { DEFAULT_JIRA_INTERVAL, JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";
import { SALESFORCE_HELP_URL, SALESFORCE_OBJECTS, salesforceSiteUrl, type SalesforceObject } from "@/lib/salesforce-sync";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to set a Salesforce sync up, once the org, the connected app and the object are given. */
export type SalesforceSetup = { site: string; clientId: string; clientSecret: string; object: SalesforceObject; intervalMinutes: number; title: string };

/**
 * The import dialog's Salesforce tab: the org's My Domain address, a connected app's consumer key
 * and secret, which object to sync, how often, and the database's name and place. The sign-in is
 * checked with Salesforce when the dialog submits. Tells the dialog the setup (or null while
 * something is missing) as it changes.
 */
export function SalesforceTab({
  busy,
  destinationPicker,
  onSetup,
}: {
  busy: boolean;
  destinationPicker: React.ReactNode;
  onSetup: (setup: SalesforceSetup | null) => void;
}) {
  const t = useTranslations("import");
  const [site, setSite] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [object, setObject] = useState<SalesforceObject>("Account");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_JIRA_INTERVAL);
  const [name, setName] = useState("");

  const complete = Boolean(salesforceSiteUrl(site) && clientId.trim() && clientSecret.trim());
  useEffect(() => {
    onSetup(complete ? { site, clientId, clientSecret, object, intervalMinutes, title: name } : null);
  }, [complete, site, clientId, clientSecret, object, intervalMinutes, name, onSetup]);

  return (
    <>
      <p className="text-sm text-fg-muted">{t("salesforce.help")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelClass}>{t("salesforce.site")}</span>
          <Input value={site} placeholder={t("salesforce.sitePlaceholder")} autoComplete="url" disabled={busy} onChange={(e) => setSite(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("salesforce.clientId")}</span>
          <Input value={clientId} autoComplete="off" disabled={busy} onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("salesforce.clientSecret")}</span>
          <Input type="password" value={clientSecret} autoComplete="off" disabled={busy} onChange={(e) => setClientSecret(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-fg-muted">
        {t("salesforce.secretHelp")}{" "}
        <a href={SALESFORCE_HELP_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
          {t("salesforce.helpLink")}
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>{t("salesforce.object")}</span>
          <select className={selectClass} value={object} disabled={busy} onChange={(e) => setObject(e.target.value as SalesforceObject)}>
            {SALESFORCE_OBJECTS.map((value) => (
              <option key={value} value={value}>
                {t(`salesforce.objects.${value}`)}
              </option>
            ))}
          </select>
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
        <label className="block">
          <span className={labelClass}>{t("csv.name")}</span>
          <Input value={name} maxLength={200} placeholder={object} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        {destinationPicker}
      </div>
    </>
  );
}
