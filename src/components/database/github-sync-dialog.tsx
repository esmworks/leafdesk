"use client";

import { ExternalLink, Eye, EyeOff, RefreshCw, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getGithubSetupAction, removeGithubSetupAction, rotateGithubSecretAction, saveGithubSetupAction } from "@/app/actions/github-sync";
import { CopyButton } from "@/components/settings/copy-button";
import { Button, cn, Dialog, IconButton, Input, selectClass } from "@/components/ui";
import type { GithubDeliveryView, GithubMapping } from "@/lib/github-sync";
import type { GithubPropertyChoice, GithubSetupState } from "@/server/github-sync/manage";

const labelClass = "mb-1 block text-xs font-medium text-fg-muted";
/** The link property's choice that makes a new text property. */
const NEW_PROPERTY = "__new";

type Form = { link: string; newName: string; status: string; opened: string; merged: string; closed: string };

/** The form's start: the saved setup, or a guess from the database's properties for a new one. */
function initialForm(state: GithubSetupState, newName: string): Form {
  const saved = state.sync?.mapping;
  if (saved) {
    return {
      link: saved.linkPropertyId ?? "",
      newName,
      status: saved.statusPropertyId ?? "",
      opened: saved.opened ?? "",
      merged: saved.merged ?? "",
      closed: saved.closed ?? "",
    };
  }
  const status = state.properties.find((p) => p.type === "status");
  return { link: NEW_PROPERTY, newName, status: status?.id ?? "", ...guessOptions(status) };
}

/** The options a status property most likely means for a pull request opened (in review) and merged (done). */
function guessOptions(status: GithubPropertyChoice | undefined) {
  const options = status?.options ?? [];
  const review = options.find((o) => /review|inceleme|prüf|revis|révis/i.test(o.name)) ?? options.find((o) => o.group === "in_progress");
  const done = options.find((o) => o.group === "done");
  return { opened: review?.id ?? "", merged: done?.id ?? "", closed: "" };
}

/**
 * A database's GitHub setup, from its page menu: pull requests that name rows by their unique ID
 * add their link to them and move their status. Shows the webhook's address and secret to give
 * GitHub, what each pull request does, and the latest deliveries. Full access to the database.
 */
export default function GithubSyncDialog({ workspaceId, databaseId, onClose }: { workspaceId: string; databaseId: string; onClose: () => void }) {
  const t = useTranslations("database.github");
  const tc = useTranslations("common");
  const [state, setState] = useState<GithubSetupState | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    getGithubSetupAction(databaseId).then(
      (result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        setState(result.data);
        setForm(initialForm(result.data, t("newPropertyName")));
      },
      () => live && setError(tc("genericError")),
    );
    return () => {
      live = false;
    };
  }, [databaseId, t, tc]);

  async function act<T>(call: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done: (data: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      if (!result.ok) return setError(result.error);
      done(result.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  const loaded = (next: GithubSetupState) => {
    setState(next);
    setForm(initialForm(next, t("newPropertyName")));
    setEditing(false);
  };

  const save = () => {
    if (!form) return;
    const mapping = {
      linkPropertyId: form.link && form.link !== NEW_PROPERTY ? form.link : null,
      newLinkProperty: form.link === NEW_PROPERTY ? form.newName.trim() || t("newPropertyName") : null,
      statusPropertyId: form.status || null,
      opened: form.status ? form.opened || null : null,
      merged: form.status ? form.merged || null : null,
      closed: form.status ? form.closed || null : null,
    };
    void act(() => saveGithubSetupAction(workspaceId, databaseId, mapping), loaded);
  };

  const ready = state?.uniqueId?.prefix ?? null;
  const showForm = state && ready && (!state.sync || editing);

  return (
    <Dialog open onClose={busy ? () => {} : onClose} className="max-w-xl">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">{t("title")}</h2>
          <p className="mt-0.5 text-xs text-fg-muted">{t("intro", { example: ready ? `${ready}-12` : "TASK-12" })}</p>
        </div>
        <IconButton label={tc("close")} onClick={onClose} disabled={busy}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="max-h-[75vh] space-y-5 overflow-y-auto p-4" aria-busy={busy}>
        {!state ? (
          !error && <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : !ready ? (
          <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
            {state.uniqueId ? t("needPrefix", { property: state.uniqueId.name }) : t("needUniqueId")}
          </p>
        ) : (
          <>
            {showForm && form && <MappingForm properties={state.properties} form={form} onChange={setForm} disabled={busy} />}
            {showForm && (
              <div className="flex justify-end gap-2">
                {state.sync && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => (setEditing(false), setForm(initialForm(state, t("newPropertyName"))))}>
                    {tc("cancel")}
                  </Button>
                )}
                <Button size="sm" variant="primary" disabled={busy} onClick={save}>
                  {state.sync ? t("save") : t("setUp")}
                </Button>
              </div>
            )}
            {state.sync && !editing && <Summary state={state} onEdit={() => setEditing(true)} disabled={busy} />}
            {state.sync && (
              <WebhookDetails
                url={state.sync.webhookUrl}
                secret={state.sync.secret}
                disabled={busy}
                onRotate={() => {
                  if (confirm(t("rotateConfirm"))) void act(() => rotateGithubSecretAction(databaseId), loaded);
                }}
              />
            )}
            {state.sync && (
              <Deliveries deliveries={state.sync.deliveries} disabled={busy} onRefresh={() => void act(() => getGithubSetupAction(databaseId), (next) => setState(next))} />
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {state?.sync && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <p className="text-xs text-fg-muted">{state.sync.runAs ? t("runsAs", { name: state.sync.runAs.name }) : t("runsAsGone")}</p>
            <Button
              size="sm"
              variant="ghost"
              className="ms-auto text-danger hover:text-danger"
              disabled={busy}
              onClick={() => {
                if (confirm(t("removeConfirm"))) void act(() => removeGithubSetupAction(databaseId), onClose);
              }}
            >
              {t("remove")}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function MappingForm({ properties, form, onChange, disabled }: { properties: GithubPropertyChoice[]; form: Form; onChange: (form: Form) => void; disabled: boolean }) {
  const t = useTranslations("database.github");
  const links = properties.filter((p) => p.type === "text" || p.type === "url");
  const statuses = properties.filter((p) => p.type === "status");
  const status = statuses.find((p) => p.id === form.status);
  const optionSelect = (key: "opened" | "merged" | "closed") => (
    <label className="block">
      <span className={labelClass}>{t(`move.${key}`)}</span>
      <select className={cn(selectClass, "w-full")} value={form[key]} disabled={disabled} onChange={(e) => onChange({ ...form, [key]: e.target.value })}>
        <option value="">{t("leave")}</option>
        {status?.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <div className="space-y-1.5">
        <label className="block">
          <span className={labelClass}>{t("linkProperty")}</span>
          <select className={cn(selectClass, "w-full")} value={form.link} onChange={(e) => onChange({ ...form, link: e.target.value })}>
            <option value="">{t("noLinks")}</option>
            {links.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PROPERTY}>{t("newProperty")}</option>
          </select>
        </label>
        {form.link === NEW_PROPERTY && (
          <Input value={form.newName} maxLength={200} aria-label={t("newPropertyLabel")} onChange={(e) => onChange({ ...form, newName: e.target.value })} />
        )}
        <p className="text-xs text-fg-faint">{t("linkHelp")}</p>
      </div>
      <div className="space-y-2">
        <label className="block">
          <span className={labelClass}>{t("statusProperty")}</span>
          <select
            className={cn(selectClass, "w-full")}
            value={form.status}
            onChange={(e) => onChange({ ...form, status: e.target.value, ...guessOptions(statuses.find((p) => p.id === e.target.value)) })}
          >
            <option value="">{t("noStatus")}</option>
            {statuses.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {status && (
          <div className="grid gap-3 sm:grid-cols-3">
            {optionSelect("opened")}
            {optionSelect("merged")}
            {optionSelect("closed")}
          </div>
        )}
        <p className="text-xs text-fg-faint">{status ? t("statusHelp") : statuses.length ? t("statusOff") : t("noStatusProperty")}</p>
      </div>
    </fieldset>
  );
}

/** What a saved setup does, in words, with a way to change it. */
function Summary({ state, onEdit, disabled }: { state: GithubSetupState; onEdit: () => void; disabled: boolean }) {
  const t = useTranslations("database.github");
  const mapping = state.sync!.mapping;
  const prop = (id: string | null) => state.properties.find((p) => p.id === id);
  const option = (id: string | null) => prop(mapping.statusPropertyId)?.options.find((o) => o.id === id)?.name ?? null;
  const moves = (["opened", "merged", "closed"] as const).flatMap((key) => {
    const name = option(mapping[key as keyof GithubMapping]);
    return name ? [t(`moves.${key}`, { option: name })] : [];
  });
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-fg-muted">{t("whatItDoes")}</h3>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onEdit}>
          {t("change")}
        </Button>
      </div>
      <ul className="list-disc space-y-0.5 ps-5 text-sm">
        <li>{prop(mapping.linkPropertyId) ? t("linksTo", { property: prop(mapping.linkPropertyId)!.name }) : t("noLinksSaved")}</li>
        {prop(mapping.statusPropertyId) && moves.length ? (
          <li>{t("movesIn", { property: prop(mapping.statusPropertyId)!.name, moves: moves.join("; ") })}</li>
        ) : (
          <li>{t("noMoves")}</li>
        )}
      </ul>
    </section>
  );
}

/** The address and secret to give GitHub, and how. */
function WebhookDetails({ url, secret, onRotate, disabled }: { url: string; secret: string | null; onRotate: () => void; disabled: boolean }) {
  const t = useTranslations("database.github");
  const [shown, setShown] = useState(false);
  return (
    <section className="space-y-3 rounded-md border border-border p-3">
      <h3 className="text-xs font-medium text-fg-muted">{t("inGithub")}</h3>
      <p className="text-sm">{t("steps")}</p>
      <div>
        <span className={labelClass}>{t("payloadUrl")}</span>
        <div className="flex items-center gap-2">
          <Input readOnly value={url} dir="ltr" aria-label={t("payloadUrl")} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={url} />
        </div>
      </div>
      <div>
        <span className={labelClass}>{t("secret")}</span>
        {secret ? (
          <div className="flex items-center gap-2">
            <Input readOnly value={shown ? secret : "•".repeat(24)} dir="ltr" aria-label={t("secret")} onFocus={(e) => shown && e.currentTarget.select()} />
            <IconButton label={shown ? t("hideSecret") : t("showSecret")} onClick={() => setShown(!shown)}>
              {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </IconButton>
            <CopyButton value={secret} />
          </div>
        ) : (
          <p className="text-sm text-danger">{t("secretUnreadable")}</p>
        )}
        <Button size="sm" variant="ghost" className="mt-1 -ms-2" disabled={disabled} onClick={onRotate}>
          {t("rotate")}
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-muted">{t("contentType")}</dt>
        <dd dir="ltr" className="text-start">
          application/json
        </dd>
        <dt className="text-fg-muted">{t("events")}</dt>
        <dd>{t("eventsValue")}</dd>
      </dl>
    </section>
  );
}

function Deliveries({ deliveries, onRefresh, disabled }: { deliveries: GithubDeliveryView[]; onRefresh: () => void; disabled: boolean }) {
  const t = useTranslations("database.github");
  const format = useFormatter();
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-fg-muted">{t("deliveries")}</h3>
        <IconButton label={t("refresh")} onClick={onRefresh} disabled={disabled}>
          <RefreshCw className={cn("h-3.5 w-3.5", disabled && "animate-spin")} />
        </IconButton>
      </div>
      {!deliveries.length ? (
        <p className="text-sm text-fg-muted">{t("noDeliveries")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {deliveries.map((d) => (
            <li key={d.id} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">
                  {d.pullRequest ? (
                    <a href={d.pullRequest.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 hover:underline">
                      <span className="truncate">
                        {d.pullRequest.repo}#{d.pullRequest.number} {d.pullRequest.title}
                      </span>
                      <ExternalLink className="h-3 w-3 shrink-0 text-fg-muted" />
                    </a>
                  ) : d.event === "ping" ? (
                    t("ping")
                  ) : (
                    t("otherEvent", { event: d.action ? `${d.event}.${d.action}` : d.event })
                  )}
                </span>
                <time dateTime={d.at} className="shrink-0 text-xs text-fg-muted" title={format.dateTime(new Date(d.at), { dateStyle: "medium", timeStyle: "short" })}>
                  {format.relativeTime(new Date(d.at), new Date())}
                </time>
              </div>
              <DeliveryOutcome delivery={d} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeliveryOutcome({ delivery: d }: { delivery: GithubDeliveryView }) {
  const t = useTranslations("database.github");
  if (d.status === "failed") return <p className="text-xs text-danger">{t(`deliveryErrors.${d.error ?? "failed"}`)}</p>;
  if (d.status === "received") return <p className="text-xs text-fg-muted">{t("handling")}</p>;
  if (d.status === "ignored") return <p className="text-xs text-fg-muted">{d.event === "ping" ? t("pingOk") : t("ignored", { action: d.action ?? d.event })}</p>;
  if (!d.rows.length) return <p className="text-xs text-fg-muted">{t("noIds")}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {d.rows.map((row) => (
        <li
          key={row.id}
          title={row.error}
          className={cn(
            "rounded border px-1.5 py-0.5 text-xs",
            row.outcome === "updated" ? "border-border bg-bg-subtle" : "border-border text-fg-muted",
            (row.outcome === "failed" || row.outcome === "noAccess") && "border-danger/40 text-danger",
          )}
        >
          <span dir="ltr" className="font-medium tabular-nums">
            {row.id}
          </span>{" "}
          {t(`outcome.${row.outcome}`)}
        </li>
      ))}
    </ul>
  );
}
