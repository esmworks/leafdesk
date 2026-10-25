"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui";
import { GITHUB_PULL_STATES, GITHUB_TOKENS_URL, githubRepo, MAX_GITHUB_PULLS, type GithubPullsState } from "@/lib/github-pulls-sync";
import { DEFAULT_JIRA_INTERVAL, JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to set a sync up, once the repository is named. */
export type GithubPullsSetup = { repo: string; state: GithubPullsState; token: string; apiUrl: string; intervalMinutes: number; title: string };

/**
 * The import dialog's GitHub tab: the repository, a token for private ones, a GitHub Enterprise
 * Server's address, which pull requests, how often to sync, and the database's name and place. The
 * repository and token are checked with GitHub when the dialog submits. Tells the dialog the setup
 * (or null while no repository is named) as it changes.
 */
export function GithubPullsTab({
  busy,
  destinationPicker,
  onSetup,
}: {
  busy: boolean;
  destinationPicker: React.ReactNode;
  onSetup: (setup: GithubPullsSetup | null) => void;
}) {
  const t = useTranslations("import");
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [state, setState] = useState<GithubPullsState>("open");
  const [intervalMinutes, setIntervalMinutes] = useState<number>(DEFAULT_JIRA_INTERVAL);
  const [name, setName] = useState("");

  const named = githubRepo(repo);
  useEffect(() => {
    onSetup(named ? { repo: named, state, token, apiUrl, intervalMinutes, title: name } : null);
  }, [named, state, token, apiUrl, intervalMinutes, name, onSetup]);

  return (
    <>
      <p className="text-sm text-fg-muted">{t("githubPulls.help")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelClass}>{t("githubPulls.repo")}</span>
          <Input value={repo} placeholder={t("githubPulls.repoPlaceholder")} autoComplete="off" disabled={busy} onChange={(e) => setRepo(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("githubPulls.token")}</span>
          <Input type="password" value={token} autoComplete="off" disabled={busy} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClass}>{t("githubPulls.server")}</span>
          <Input value={apiUrl} placeholder={t("githubPulls.serverPlaceholder")} autoComplete="url" disabled={busy} onChange={(e) => setApiUrl(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-fg-muted">
        {t("githubPulls.tokenHelp")}{" "}
        <a href={GITHUB_TOKENS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
          {t("githubPulls.tokenLink")}
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>
      <fieldset className="space-y-2" disabled={busy}>
        <legend className={labelClass}>{t("githubPulls.pulls")}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {GITHUB_PULL_STATES.map((value) => (
            <label key={value} className="flex items-center gap-1.5">
              <input type="radio" name="github-pulls-state" checked={state === value} onChange={() => setState(value)} />
              {t(`githubPulls.states.${value}`, { limit: MAX_GITHUB_PULLS })}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>{t("csv.name")}</span>
          <Input value={name} maxLength={200} placeholder={named ?? ""} disabled={busy} onChange={(e) => setName(e.target.value)} />
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
