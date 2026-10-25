"use client";

import { ExternalLink, RefreshCw, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  getGithubPullsSyncAction,
  stopGithubPullsSyncAction,
  syncGithubPullsNowAction,
  updateGithubPullsSyncAction,
} from "@/app/actions/github-pulls-sync";
import { Button, Dialog, IconButton, Input, selectClass } from "@/components/ui";
import { GITHUB_API_URL, GITHUB_PULL_STATES, GITHUB_TOKENS_URL, MAX_GITHUB_PULLS, type GithubPullsSyncView } from "@/lib/github-pulls-sync";
import { JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";

const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** The repository's address on the web: github.com's, or a GitHub Enterprise Server's (its API is under /api/v3). */
const repoUrl = (sync: GithubPullsSyncView) =>
  `${sync.apiUrl === GITHUB_API_URL ? "https://github.com" : sync.apiUrl.replace(/\/api\/v3$/, "")}/${sync.repo}/pulls`;

/**
 * A synced database's GitHub sync: the repository, when it last synced and what went wrong, and,
 * for people with full access to the database, which pull requests and how often, syncing now,
 * changing the token, and stopping it. Loaded the first time it opens.
 */
export default function GithubPullsSyncDialog({ databaseId, onClose, onChanged }: { databaseId: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("database.githubPulls");
  const tj = useTranslations("database.jiraSync");
  const ti = useTranslations("import");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [sync, setSync] = useState<GithubPullsSyncView | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState(false);
  const [token, setToken] = useState("");

  useEffect(() => {
    let live = true;
    getGithubPullsSyncAction(databaseId).then(
      (result) => live && (result.ok ? setSync(result.data) : (setSync(null), setError(result.error))),
      () => live && (setSync(null), setError(tc("genericError"))),
    );
    return () => {
      live = false;
    };
  }, [databaseId, tc]);

  async function act<T>(call: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done?: (data: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      if (!result.ok) return setError(result.error);
      done?.(result.data);
      onChanged();
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={busy ? () => {} : onClose} className="max-w-lg">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <IconButton label={tc("close")} onClick={onClose} disabled={busy}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4" aria-busy={busy}>
        {sync === "loading" ? (
          <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : !sync ? null : (
          <>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-fg-muted">{ti("githubPulls.repo")}</dt>
              <dd className="min-w-0 truncate">
                <a href={repoUrl(sync)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  {sync.repo}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </dd>
              <dt className="text-fg-muted">{ti("githubPulls.pulls")}</dt>
              <dd>
                {sync.canManage ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("githubPulls.pulls")}
                    value={sync.state}
                    disabled={busy}
                    onChange={(e) => void act(() => updateGithubPullsSyncAction(databaseId, { state: e.target.value }), setSync)}
                  >
                    {GITHUB_PULL_STATES.map((state) => (
                      <option key={state} value={state}>
                        {ti(`githubPulls.states.${state}`, { limit: MAX_GITHUB_PULLS })}
                      </option>
                    ))}
                  </select>
                ) : (
                  ti(`githubPulls.states.${sync.state}`, { limit: MAX_GITHUB_PULLS })
                )}
              </dd>
              <dt className="text-fg-muted">{ti("jira.every")}</dt>
              <dd>
                {sync.canManage ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("jira.every")}
                    value={sync.intervalMinutes}
                    disabled={busy}
                    onChange={(e) => void act(() => updateGithubPullsSyncAction(databaseId, { intervalMinutes: Number(e.target.value) }), setSync)}
                  >
                    {JIRA_INTERVALS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {ti(`jira.intervals.${jiraIntervalKey(minutes)}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  ti(`jira.intervals.${jiraIntervalKey(sync.intervalMinutes)}`)
                )}
              </dd>
            </dl>
            <p className="text-sm">
              {busy || sync.running ? (
                tj("running")
              ) : sync.lastRunAt ? (
                t("lastRun", { when: format.relativeTime(new Date(sync.lastRunAt), new Date()), count: sync.lastCount ?? 0 })
              ) : (
                tj("never")
              )}
              {sync.canManage && <span className="text-fg-muted"> · {sync.hasToken ? t("withToken") : t("withoutToken")}</span>}
            </p>
            {sync.lastError && (
              <p role="status" className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                {!sync.enabled && <span className="me-1.5 font-medium text-danger">{tj("paused")}:</span>}
                {ti(`githubPulls.errors.${sync.lastError}`)}
              </p>
            )}
            <p className="text-xs text-fg-muted">{t("overwrite")}</p>

            {sync.canManage ? (
              <>
                {editingToken && (
                  <fieldset className="space-y-2" disabled={busy}>
                    <label className="block">
                      <span className={labelClass}>{ti("githubPulls.token")}</span>
                      <Input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
                    </label>
                    <p className="text-xs text-fg-muted">
                      {t("tokenEmpty")}{" "}
                      <a href={GITHUB_TOKENS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
                        {ti("githubPulls.tokenLink")}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditingToken(false)}>
                        {tc("cancel")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          void act(
                            () => updateGithubPullsSyncAction(databaseId, { token }),
                            (next) => (setSync(next), setEditingToken(false), setToken("")),
                          )
                        }
                      >
                        {tj("save")}
                      </Button>
                    </div>
                  </fieldset>
                )}
                {error && (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={busy || sync.running} onClick={() => void act(() => syncGithubPullsNowAction(databaseId), setSync)}>
                    <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                    {tj("syncNow")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditingToken(!editingToken);
                      setError(null);
                    }}
                  >
                    {t("changeToken")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="ms-auto text-danger hover:text-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(t("stopConfirm"))) return;
                      void act(() => stopGithubPullsSyncAction(databaseId), onClose);
                    }}
                  >
                    {tj("stop")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-fg-muted">{tj("viewOnly")}</p>
            )}
          </>
        )}
        {(!sync || sync === "loading") && error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
