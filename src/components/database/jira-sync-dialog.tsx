"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  getJiraSyncAction,
  jiraProjectsAction,
  stopJiraSyncAction,
  syncJiraNowAction,
  updateJiraSyncAction,
} from "@/app/actions/jira-sync";
import { Button, Dialog, DialogBody, DialogHeader, Input, selectClass, textareaClass } from "@/components/ui";
import {
  ATLASSIAN_TOKENS_URL,
  JIRA_INTERVALS,
  jiraIntervalKey,
  MAX_JIRA_ISSUES,
  MAX_JQL_LENGTH,
  type JiraProject,
  type JiraSyncView,
} from "@/lib/jira-sync";

const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

type Editing = "query" | "signIn" | null;

/**
 * A synced database's Jira sync: where it syncs from, when it last did and what went wrong, and,
 * for people with full access to the database, how often it runs, syncing now, changing what it
 * syncs or its sign-in, and stopping it. Loaded the first time it opens.
 */
export default function JiraSyncDialog({ databaseId, onClose, onChanged }: { databaseId: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("database.jiraSync");
  const tj = useTranslations("import.jira");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [sync, setSync] = useState<JiraSyncView | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [projects, setProjects] = useState<JiraProject[] | null>(null);
  const [mode, setMode] = useState<"project" | "jql">("project");
  const [project, setProject] = useState("");
  const [jql, setJql] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    let live = true;
    getJiraSyncAction(databaseId).then(
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

  function edit(what: Editing) {
    setEditing(what);
    setError(null);
    if (typeof sync !== "object" || !sync) return;
    if (what === "signIn") setEmail(sync.email);
    if (what !== "query") return;
    const current = sync.query;
    setMode("project" in current ? "project" : "jql");
    setProject("project" in current ? current.project : "");
    setJql("jql" in current ? current.jql : "");
    // Someone else's sign-in lists nothing to them: their own lists the projects once given.
    if (!projects && sync.ownSignIn) void jiraProjectsAction(databaseId).then((r) => setProjects(r.ok ? r.data : []));
  }

  /** The projects the sign-in typed into the query's fields can browse. */
  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const result = await jiraProjectsAction(databaseId, { email, token });
      if (!result.ok) return setError(result.error);
      setProjects(result.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  /** The sign-in that goes with a new query: the person's own when the sync keeps someone else's. */
  const ownSignIn = (s: JiraSyncView) => (s.ownSignIn ? {} : { email, token });

  const problem = (s: JiraSyncView) =>
    s.lastError === "badQuery" && s.lastErrorDetail
      ? tj("errors.badQueryDetail", { detail: s.lastErrorDetail })
      : s.lastError
        ? tj(`errors.${s.lastError}`, { limit: MAX_JIRA_ISSUES })
        : null;

  return (
    <Dialog open onClose={busy ? () => {} : onClose} className="max-w-lg">
      <DialogHeader title={t("title")} onClose={onClose} closeLabel={tc("close")} closeDisabled={busy} />
      <DialogBody className="max-h-[70vh] overflow-y-auto" aria-busy={busy}>
        {sync === "loading" ? (
          <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : !sync ? null : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-fg-muted">{t("site")}</dt>
              <dd className="min-w-0 truncate">
                <a href={sync.siteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  {sync.siteUrl.replace(/^https?:\/\//, "")}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </dd>
              <dt className="text-fg-muted">{tj("from")}</dt>
              <dd className="min-w-0 break-words">
                {"project" in sync.query ? t("project", { key: sync.query.project }) : <code className="text-xs">{sync.query.jql}</code>}
              </dd>
              <dt className="text-fg-muted">{tj("every")}</dt>
              <dd>
                {sync.canManage ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={tj("every")}
                    value={sync.intervalMinutes}
                    disabled={busy}
                    onChange={(e) => void act(() => updateJiraSyncAction(databaseId, { intervalMinutes: Number(e.target.value) }), setSync)}
                  >
                    {JIRA_INTERVALS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {tj(`intervals.${jiraIntervalKey(minutes)}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  tj(`intervals.${jiraIntervalKey(sync.intervalMinutes)}`)
                )}
              </dd>
              {sync.canManage && (
                <>
                  <dt className="text-fg-muted">{t("reporter")}</dt>
                  <dd>
                    {/* The person property issues' reporters go to, found by email address like assignees. */}
                    <select
                      className={`${selectClass} h-7`}
                      aria-label={t("reporter")}
                      value={sync.reporter ?? ""}
                      disabled={busy}
                      onChange={(e) => void act(() => updateJiraSyncAction(databaseId, { reporter: e.target.value || null }), setSync)}
                    >
                      <option value="">{t("reporterNone")}</option>
                      {sync.personProperties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </dd>
                </>
              )}
            </dl>
            <p className="text-sm">
              {busy || sync.running ? (
                t("running")
              ) : sync.lastRunAt ? (
                t("lastRun", { when: format.relativeTime(new Date(sync.lastRunAt), new Date()), count: sync.lastCount ?? 0 })
              ) : (
                t("never")
              )}
              {sync.canManage && <span className="text-fg-muted"> · {t("account", { email: sync.email })}</span>}
            </p>
            {problem(sync) && (
              <p role="status" className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                {!sync.enabled && <span className="me-1.5 font-medium text-danger">{t("paused")}:</span>}
                {problem(sync)}
              </p>
            )}
            <p className="text-xs text-fg-muted">{t("overwrite")}</p>

            {sync.canManage ? (
              <>
                {editing === "query" && (
                  <fieldset className="space-y-2" disabled={busy}>
                    {!sync.ownSignIn && (
                      <>
                        <p className="text-xs text-fg-muted">{tj("errors.needsSignIn")}</p>
                        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                          <label className="block">
                            <span className={labelClass}>{tj("email")}</span>
                            <Input type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
                          </label>
                          <label className="block">
                            <span className={labelClass}>{tj("token")}</span>
                            <Input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
                          </label>
                          <Button size="sm" disabled={!email.trim() || !token.trim()} onClick={() => void connect()}>
                            {tj("connect")}
                          </Button>
                        </div>
                      </>
                    )}
                    <div className="flex flex-wrap gap-4 text-sm">
                      {(["project", "jql"] as const).map((value) => (
                        <label key={value} className="flex items-center gap-1.5">
                          <input type="radio" name="jira-sync-from" checked={mode === value} onChange={() => setMode(value)} />
                          {tj(value)}
                        </label>
                      ))}
                    </div>
                    {mode === "project" ? (
                      <select className={`${selectClass} w-full`} aria-label={tj("project")} value={project} onChange={(e) => setProject(e.target.value)}>
                        <option value="">{tj("chooseProject")}</option>
                        {/* The current project, even before the list (or without it in the list). */}
                        {project && !projects?.some((p) => p.key === project) && <option value={project}>{project}</option>}
                        {projects?.map((p) => (
                          <option key={p.key} value={p.key}>
                            {`${p.name} (${p.key})`}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <textarea
                        className={textareaClass}
                        rows={2}
                        aria-label={tj("jql")}
                        value={jql}
                        maxLength={MAX_JQL_LENGTH}
                        placeholder={tj("jqlPlaceholder")}
                        onChange={(e) => setJql(e.target.value)}
                      />
                    )}
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {tc("cancel")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={(mode === "project" ? !project : !jql.trim()) || (!sync.ownSignIn && (!email.trim() || !token.trim()))}
                        onClick={() =>
                          void act(
                            () => updateJiraSyncAction(databaseId, { query: mode === "project" ? { project } : { jql }, ...ownSignIn(sync) }),
                            (next) => (setSync(next), setEditing(null), setToken("")),
                          )
                        }
                      >
                        {t("save")}
                      </Button>
                    </div>
                  </fieldset>
                )}
                {editing === "signIn" && (
                  <fieldset className="space-y-2" disabled={busy}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className={labelClass}>{tj("email")}</span>
                        <Input type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
                      </label>
                      <label className="block">
                        <span className={labelClass}>{tj("token")}</span>
                        <Input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
                      </label>
                    </div>
                    <p className="text-xs text-fg-muted">
                      <a href={ATLASSIAN_TOKENS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
                        {tj("tokenLink")}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {tc("cancel")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!email.trim() || !token.trim()}
                        onClick={() =>
                          void act(
                            () => updateJiraSyncAction(databaseId, { email, token }),
                            (next) => (setSync(next), setEditing(null), setToken("")),
                          )
                        }
                      >
                        {t("save")}
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
                  <Button variant="primary" disabled={busy || sync.running} onClick={() => void act(() => syncJiraNowAction(databaseId), setSync)}>
                    <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                    {t("syncNow")}
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => edit(editing === "query" ? null : "query")}>
                    {t("changeQuery")}
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => edit(editing === "signIn" ? null : "signIn")}>
                    {t("changeSignIn")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="ms-auto text-danger hover:text-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(t("stopConfirm"))) return;
                      void act(() => stopJiraSyncAction(databaseId), onClose);
                    }}
                  >
                    {t("stop")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-fg-muted">{t("viewOnly")}</p>
            )}
          </>
        )}
        {(!sync || sync === "loading") && error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </DialogBody>
    </Dialog>
  );
}
