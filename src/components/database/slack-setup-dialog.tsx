"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createSlackAutomationAction, slackSetupAction } from "@/app/actions/automations";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, Input, selectClass, textareaClass } from "@/components/ui";
import { templateFor } from "@/lib/automation-templates";
import { MAX_STEP_MESSAGE, MAX_WEBHOOK_URL } from "@/lib/automations";
import type { SlackSetup, SlackWatchable } from "@/server/automations/slack-setup";

const labelClass = "mb-1 block text-xs font-medium text-fg-muted";
const ROW_CREATED = "row_created";
/** The "to" choices for a checkbox. */
const CHECKED = "__checked";
const UNCHECKED = "__unchecked";

/** Whether a property can be watched for one value: its options, or checked and unchecked. */
const hasValues = (p: SlackWatchable | undefined) => !!p && (p.type === "checkbox" || ((p.type === "select" || p.type === "status") && p.options.length > 0));

/**
 * The quick setup of Slack notifications, from a database's menu: a Slack incoming webhook, when to
 * post (a row is added, or a property changes, to a value or any), and the message. It makes an
 * ordinary automation, which the automations dialog shows and changes from then on.
 */
export default function SlackSetupDialog({ databaseId, onClose }: { databaseId: string; onClose: () => void }) {
  const t = useTranslations("database.slack");
  const tc = useTranslations("common");
  const [setup, setSetup] = useState<SlackSetup | null>(null);
  const [url, setUrl] = useState("");
  const [when, setWhen] = useState(ROW_CREATED);
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    slackSetupAction(databaseId).then(
      (result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        setSetup(result.data);
        // Watching a status for its done options is the usual case: start there when there is one.
        const status = result.data.properties.find((p) => p.type === "status" && p.options.some((o) => o.group === "done"));
        if (status) {
          setWhen(status.id);
          setTo(status.options.find((o) => o.group === "done")!.id);
        }
      },
      () => live && setError(tc("genericError")),
    );
    return () => {
      live = false;
    };
  }, [databaseId, tc]);

  const watched = setup?.properties.find((p) => p.id === when);
  const toName = watched?.type === "checkbox" ? (to === CHECKED ? t("checked") : to === UNCHECKED ? t("unchecked") : null) : (watched?.options.find((o) => o.id === to)?.name ?? null);

  // The message to start from, until it is changed: written with variables the step fills in.
  const actor = templateFor("trigger", ["actor", "name"]);
  const suggested = watched
    ? t("defaultChanged", { actor, property: watched.name, value: templateFor("trigger", ["changes", watched.name, "after"]) })
    : t("defaultAdded", { actor, database: templateFor("trigger", ["database", "title"]) });
  const text = message ?? suggested;
  const name = watched ? (toName ? t("nameChangedTo", { property: watched.name, value: toName }) : t("nameChanged", { property: watched.name })) : t("nameAdded");

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await createSlackAutomationAction(databaseId, {
        name,
        url: url.trim(),
        message: text,
        when,
        to: watched?.type === "checkbox" ? (to ? to === CHECKED : null) : to || null,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (!result.ok) return setError(result.error);
      setCreated(name);
      setUrl("");
      setMessage(null);
      const next = await slackSetupAction(databaseId);
      if (next.ok) setSetup(next.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? () => {} : onClose} className="max-w-lg">
      <DialogHeader title={t("title")} description={t("intro")} onClose={onClose} closeLabel={tc("close")} closeDisabled={busy} />
      <DialogBody className="max-h-[75vh] overflow-y-auto" aria-busy={busy}>
        {!setup ? (
          !error && <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : (
          <fieldset className="space-y-4" disabled={busy}>
            <label className="block">
              <span className={labelClass}>{t("url")}</span>
              <Input
                value={url}
                dir="ltr"
                type="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_WEBHOOK_URL}
                placeholder="https://hooks.slack.com/services/…"
                onChange={(e) => setUrl(e.target.value)}
              />
              <span className="mt-1 block text-xs text-fg-faint">{t("urlHelp")}</span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelClass}>{t("when")}</span>
                <select
                  className={cn(selectClass, "w-full")}
                  value={when}
                  onChange={(e) => {
                    setWhen(e.target.value);
                    setTo("");
                    setMessage(null);
                  }}
                >
                  <option value={ROW_CREATED}>{t("rowAdded")}</option>
                  {setup.properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {t("propertyChanges", { property: p.name })}
                    </option>
                  ))}
                </select>
              </label>
              {hasValues(watched) && (
                <label className="block">
                  <span className={labelClass}>{t("to")}</span>
                  <select className={cn(selectClass, "w-full")} value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="">{t("anyValue")}</option>
                    {watched!.type === "checkbox" ? (
                      <>
                        <option value={CHECKED}>{t("checked")}</option>
                        <option value={UNCHECKED}>{t("unchecked")}</option>
                      </>
                    ) : (
                      watched!.options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              )}
            </div>
            <label className="block">
              <span className={labelClass}>{t("message")}</span>
              <textarea className={textareaClass} rows={3} maxLength={MAX_STEP_MESSAGE} value={text} onChange={(e) => setMessage(e.target.value)} />
              <span className="mt-1 block text-xs text-fg-faint">{t("messageHelp")}</span>
            </label>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {created && !error && (
          <p role="status" className="text-sm text-fg-muted">
            {t("created", { name: created })}
          </p>
        )}
        {!!setup?.automations.length && (
          <section className="space-y-1.5 border-t border-border pt-3">
            <h3 className="text-xs font-medium text-fg-muted">{t("existing")}</h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {setup.automations.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{a.name}</span>
                  <span className="shrink-0 text-xs text-fg-muted">
                    <span dir="ltr">{a.hints.join(", ")}</span>
                    {!a.enabled && <> · {t("off")}</>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-fg-faint">{t("existingHelp")}</p>
          </section>
        )}
      </DialogBody>
      {setup && (
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {tc("close")}
          </Button>
          <Button variant="primary" disabled={busy || !url.trim() || !text.trim()} onClick={create}>
            {t("create")}
          </Button>
        </DialogFooter>
      )}
    </Dialog>
  );
}
