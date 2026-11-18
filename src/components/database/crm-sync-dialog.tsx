"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getSalesforceSyncAction, stopSalesforceSyncAction, syncSalesforceNowAction, updateSalesforceSyncAction } from "@/app/actions/salesforce-sync";
import { getZendeskSyncAction, stopZendeskSyncAction, syncZendeskNowAction, updateZendeskSyncAction } from "@/app/actions/zendesk-sync";
import { Button, Dialog, DialogBody, DialogHeader, Input, selectClass } from "@/components/ui";
import type { CrmSyncView } from "@/lib/crm-sync";
import { JIRA_INTERVALS, jiraIntervalKey } from "@/lib/jira-sync";
import { SALESFORCE_HELP_URL } from "@/lib/salesforce-sync";
import { ZENDESK_TOKENS_URL } from "@/lib/zendesk-sync";

const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
type Source = "zendesk" | "salesforce";

/** What each source's dialog calls on the server (the sign-in is two fields, named by the source). */
const CALLS = {
  zendesk: {
    get: getZendeskSyncAction,
    now: syncZendeskNowAction,
    stop: stopZendeskSyncAction,
    update: (id: string, patch: { intervalMinutes?: number; signIn?: [string, string] }) =>
      updateZendeskSyncAction(id, { intervalMinutes: patch.intervalMinutes, email: patch.signIn?.[0], token: patch.signIn?.[1] }),
  },
  salesforce: {
    get: getSalesforceSyncAction,
    now: syncSalesforceNowAction,
    stop: stopSalesforceSyncAction,
    update: (id: string, patch: { intervalMinutes?: number; signIn?: [string, string] }) =>
      updateSalesforceSyncAction(id, { intervalMinutes: patch.intervalMinutes, clientId: patch.signIn?.[0], clientSecret: patch.signIn?.[1] }),
  },
} as const;

/**
 * A synced database's Zendesk or Salesforce sync: the address (and object), when it last synced and
 * what went wrong, and, for people with full access to the database, how often, syncing now,
 * changing the sign-in, and stopping it. Loaded the first time it opens.
 */
export default function CrmSyncDialog({ source, databaseId, onClose, onChanged }: { source: Source; databaseId: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("database");
  const ti = useTranslations("import");
  const tc = useTranslations("common");
  const format = useFormatter();
  const calls = CALLS[source];
  const [sync, setSync] = useState<CrmSyncView | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");

  useEffect(() => {
    let live = true;
    calls.get(databaseId).then(
      (result) => live && (result.ok ? setSync(result.data) : (setSync(null), setError(result.error))),
      () => live && (setSync(null), setError(tc("genericError"))),
    );
    return () => {
      live = false;
    };
  }, [calls, databaseId, tc]);

  async function act<T>(call: () => Promise<Result<T>>, done?: (data: T) => void) {
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

  const title = source === "zendesk" ? t("zendeskSync.title") : t("salesforceSync.title");
  const sourceName = source === "zendesk" ? "Zendesk" : "Salesforce";
  const firstLabel = source === "zendesk" ? ti("zendesk.email") : ti("salesforce.clientId");
  const secondLabel = source === "zendesk" ? ti("zendesk.token") : ti("salesforce.clientSecret");

  return (
    <Dialog open onClose={busy ? () => {} : onClose} className="max-w-lg">
      <DialogHeader title={title} onClose={onClose} closeLabel={tc("close")} closeDisabled={busy} />
      <DialogBody className="max-h-[70vh] overflow-y-auto" aria-busy={busy}>
        {sync === "loading" ? (
          <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : !sync ? null : (
          <>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-fg-muted">{t("jiraSync.site")}</dt>
              <dd className="min-w-0 truncate">
                <a href={sync.siteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  {sync.siteUrl.replace(/^https?:\/\//, "")}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </dd>
              {source === "salesforce" && sync.object && (
                <>
                  <dt className="text-fg-muted">{ti("salesforce.object")}</dt>
                  <dd>{ti(`salesforce.objects.${sync.object as "Account"}`)}</dd>
                </>
              )}
              <dt className="text-fg-muted">{ti("jira.every")}</dt>
              <dd>
                {sync.canManage ? (
                  <select
                    className={`${selectClass} h-7`}
                    aria-label={ti("jira.every")}
                    value={sync.intervalMinutes}
                    disabled={busy}
                    onChange={(e) => void act(() => calls.update(databaseId, { intervalMinutes: Number(e.target.value) }), setSync)}
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
                t("jiraSync.running")
              ) : sync.lastRunAt ? (
                t("postgresSync.lastRun", { when: format.relativeTime(new Date(sync.lastRunAt), new Date()), count: sync.lastCount ?? 0 })
              ) : (
                t("jiraSync.never")
              )}
              {sync.canManage && source === "zendesk" && sync.account && <span className="text-fg-muted"> · {t("jiraSync.account", { email: sync.account })}</span>}
            </p>
            {sync.lastError && (
              <p role="status" className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
                {!sync.enabled && <span className="me-1.5 font-medium text-danger">{t("jiraSync.paused")}:</span>}
                {source === "zendesk"
                  ? ti(`zendesk.errors.${sync.lastError as "failed"}`)
                  : sync.lastError === "badQuery" && sync.lastErrorDetail
                    ? ti("salesforce.errors.badQueryDetail", { detail: sync.lastErrorDetail })
                    : ti(`salesforce.errors.${sync.lastError as "failed"}`)}
              </p>
            )}
            <p className="text-xs text-fg-muted">{t("crmSync.overwrite", { source: sourceName })}</p>

            {sync.canManage ? (
              <>
                {editing && (
                  <fieldset className="space-y-2" disabled={busy}>
                    <label className="block">
                      <span className={labelClass}>{firstLabel}</span>
                      <Input value={first} autoComplete="off" onChange={(e) => setFirst(e.target.value)} />
                    </label>
                    <label className="block">
                      <span className={labelClass}>{secondLabel}</span>
                      <Input type="password" value={second} autoComplete="off" onChange={(e) => setSecond(e.target.value)} />
                    </label>
                    <p className="text-xs text-fg-muted">
                      <a
                        href={source === "zendesk" ? ZENDESK_TOKENS_URL : SALESFORCE_HELP_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-accent hover:underline"
                      >
                        {source === "zendesk" ? ti("githubPulls.tokenLink") : ti("salesforce.helpLink")}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                        {tc("cancel")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!first.trim() || !second.trim()}
                        onClick={() =>
                          void act(
                            () => calls.update(databaseId, { signIn: [first, second] }),
                            (next) => (setSync(next), setEditing(false), setFirst(""), setSecond("")),
                          )
                        }
                      >
                        {t("jiraSync.save")}
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
                  <Button variant="primary" disabled={busy || sync.running} onClick={() => void act(() => calls.now(databaseId), setSync)}>
                    <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                    {t("jiraSync.syncNow")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(!editing);
                      setError(null);
                    }}
                  >
                    {t("jiraSync.changeSignIn")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="ms-auto text-danger hover:text-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(t("jiraSync.stopConfirm"))) return;
                      void act(() => calls.stop(databaseId), onClose);
                    }}
                  >
                    {t("jiraSync.stop")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-fg-muted">{t("jiraSync.viewOnly")}</p>
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
