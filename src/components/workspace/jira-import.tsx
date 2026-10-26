"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { checkJiraAction } from "@/app/actions/jira-sync";
import { Button, Input, textareaClass } from "@/components/ui";
import {
  ATLASSIAN_TOKENS_URL,
  DEFAULT_JIRA_INTERVAL,
  JIRA_INTERVALS,
  jiraIntervalKey,
  MAX_JQL_LENGTH,
  type JiraProject,
  type JiraQuery,
} from "@/lib/jira-sync";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to set a sync up, once everything is filled in. */
export type JiraSetup = { siteUrl: string; email: string; token: string; query: JiraQuery; intervalMinutes: number; title: string };

/**
 * The import dialog's Jira tab: the site, email address and API token, checked with Jira
 * ("Connect"), then the project or JQL query, how often to sync, and the database's name and place.
 * Tells the dialog the setup (or null while it isn't complete) as it changes.
 */
export function JiraTab({
  workspaceId,
  busy,
  destinationPicker,
  onSetup,
}: {
  workspaceId: string;
  busy: boolean;
  destinationPicker: React.ReactNode;
  onSetup: (setup: JiraSetup | null) => void;
}) {
  const t = useTranslations("import");
  const tc = useTranslations("common");
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<{ account: string; projects: JiraProject[] } | null>(null);
  const [mode, setMode] = useState<"project" | "jql">("project");
  const [project, setProject] = useState("");
  const [jql, setJql] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_JIRA_INTERVAL);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);

  const query: JiraQuery | null = !connected ? null : mode === "project" ? (project ? { project } : null) : jql.trim() ? { jql: jql.trim() } : null;
  useEffect(() => {
    onSetup(connected && query ? { siteUrl, email, token, query, intervalMinutes, title: name } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query is derived from the fields listed
  }, [connected, mode, project, jql, intervalMinutes, name, siteUrl, email, token]);

  async function connect() {
    setChecking(true);
    setError(null);
    try {
      const result = await checkJiraAction(workspaceId, { siteUrl, email, token });
      if (!result.ok) return setError(result.error);
      setConnected(result.data);
      if (!result.data.projects.length) setMode("jql");
    } catch {
      setError(tc("genericError"));
    } finally {
      setChecking(false);
    }
  }

  const disabled = busy || checking;
  return (
    <>
      <p className="text-sm text-fg-muted">{t("jira.help")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelClass}>{t("jira.site")}</span>
          <Input
            value={siteUrl}
            placeholder={t("jira.sitePlaceholder")}
            autoComplete="url"
            disabled={disabled || !!connected}
            onChange={(e) => setSiteUrl(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={labelClass}>{t("jira.email")}</span>
          <Input type="email" value={email} autoComplete="email" disabled={disabled || !!connected} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("jira.token")}</span>
          <Input type="password" value={token} autoComplete="off" disabled={disabled || !!connected} onChange={(e) => setToken(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-fg-muted">
        {t("jira.tokenHelp")}{" "}
        <a href={ATLASSIAN_TOKENS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
          {t("jira.tokenLink")}
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>
      {connected ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">{t("jira.connected", { name: connected.account })}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConnected(null)}>
            {t("jira.change")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button disabled={disabled || !siteUrl.trim() || !email.trim() || !token.trim()} onClick={() => void connect()}>
            {checking ? t("jira.connecting") : t("jira.connect")}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
      {connected && (
        <>
          <fieldset className="space-y-2" disabled={busy}>
            <legend className={labelClass}>{t("jira.from")}</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {(["project", "jql"] as const).map((value) => (
                <label key={value} className="flex items-center gap-1.5">
                  <input type="radio" name="jira-from" checked={mode === value} onChange={() => setMode(value)} />
                  {t(`jira.${value}`)}
                </label>
              ))}
            </div>
            {mode === "project" ? (
              connected.projects.length ? (
                <select
                  className={selectClass}
                  aria-label={t("jira.project")}
                  value={project}
                  onChange={(e) => {
                    setProject(e.target.value);
                    const chosen = connected.projects.find((p) => p.key === e.target.value);
                    if (chosen && !named) setName(chosen.name);
                  }}
                >
                  <option value="">{t("jira.chooseProject")}</option>
                  {connected.projects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {`${p.name} (${p.key})`}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-fg-muted">{t("jira.noProjects")}</p>
              )
            ) : (
              <textarea
                className={textareaClass}
                rows={2}
                aria-label={t("jira.jql")}
                value={jql}
                maxLength={MAX_JQL_LENGTH}
                placeholder={t("jira.jqlPlaceholder")}
                onChange={(e) => setJql(e.target.value)}
              />
            )}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>{t("csv.name")}</span>
              <Input
                value={name}
                maxLength={200}
                disabled={busy}
                onChange={(e) => {
                  setName(e.target.value);
                  setNamed(true);
                }}
              />
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
      )}
    </>
  );
}
