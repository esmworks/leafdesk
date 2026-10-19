"use client";

import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { beginStorageOAuthAction, connectStorageAction, disconnectStorageAction, retestStorageAction, testStorageAction } from "@/app/actions/storage";
import { Button, cn, Input } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import { relativeTime } from "@/lib/relative-time";
import {
  AVAILABLE_STORAGE_KINDS,
  isOAuthStorageKind,
  locationTitle,
  type OAuthStorageKind,
  type StorageKind,
  type StorageNotice,
  type StorageSettingsView,
  type StorageView,
} from "@/lib/workspace-storage";
import { SettingsGroup, SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > Storage, for owners: where the workspace's uploads go (this server, or storage the
 * workspace brought), how that storage is doing, and the form that connects or changes it. Files
 * keep being served by Leafdesk, so the storage stays private. Google Drive and Dropbox are
 * connected by signing in there; the browser comes back with a `notice` of how it went.
 */
export function StorageSettings({ workspaceId, initial, notice }: { workspaceId: string; initial: StorageSettingsView; notice?: StorageNotice }) {
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [shownNotice, setShownNotice] = useState(notice);
  const t = useTranslations("settings.storage");

  // Shown once: reloading the page shouldn't say it again.
  useEffect(() => {
    if (notice) window.history.replaceState(null, "", `${window.location.pathname}?tab=storage`);
  }, [notice]);

  return (
    <div className="space-y-10">
      {shownNotice && (
        <p
          role="status"
          className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", shownNotice === "connected" ? "border-border text-fg-muted" : "border-danger/40 text-danger")}
        >
          <span className="flex-1">{shownNotice === "connected" || shownNotice === "refused" ? t(`notices.${shownNotice}`) : t(`errors.${shownNotice}`)}</span>
          <button type="button" className="text-fg-faint hover:text-fg" aria-label={t("dismiss")} onClick={() => setShownNotice(undefined)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}
      <CurrentGroup workspaceId={workspaceId} view={view} onChange={setView} onEdit={() => setEditing(true)} />
      {(!view.current || editing) && (
        <SettingsGroup title={view.current ? t("changeHeading") : t("connectHeading")} description={t("connectDescription")}>
          <StorageForm
            // A fresh form for each storage it changes.
            key={view.current?.id ?? "new"}
            workspaceId={workspaceId}
            current={view.current}
            oauthReady={view.oauthReady}
            onCancel={view.current ? () => setEditing(false) : undefined}
            onSaved={(next) => {
              setView(next);
              setEditing(false);
            }}
          />
        </SettingsGroup>
      )}
      {view.retired.length > 0 && (
        <SettingsGroup title={t("retiredHeading")} description={t("retiredDescription")}>
          {view.retired.map((target) => (
            <SettingsRow key={target.id} title={targetTitle(target)} description={<FilesLine target={target} />} />
          ))}
        </SettingsGroup>
      )}
    </div>
  );
}

const targetTitle = (target: StorageView) => locationTitle(target);

function FilesLine({ target }: { target: StorageView }) {
  const t = useTranslations("settings.storage");
  return <>{t("files", { count: target.files, size: formatBytes(target.bytes) })}</>;
}

/** Where new uploads go now, with what can be done about it. */
function CurrentGroup({
  workspaceId,
  view,
  onChange,
  onEdit,
}: {
  workspaceId: string;
  view: StorageSettingsView;
  onChange: (view: StorageSettingsView) => void;
  onEdit: () => void;
}) {
  const t = useTranslations("settings.storage");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { pending, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const current = view.current;
  const used = formatBytes(view.instanceUsed);

  if (!current) {
    return (
      <SettingsGroup title={t("currentHeading")}>
        <SettingsRow
          title={t("instance")}
          description={
            <>
              {t("instanceHint")}{" "}
              {view.instanceQuota !== null ? t("instanceUsage", { used, quota: formatBytes(view.instanceQuota) }) : t("instanceUsageNoQuota", { used })}
            </>
          }
        />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup title={t("currentHeading")}>
      <SettingsRow
        title={
          <>
            <span className="block text-xs font-normal text-fg-muted">{t(`kinds.${current.kind}`)}</span>
            {targetTitle(current)}
          </>
        }
        description={
          <>
            <span className={cn("block", current.status === "broken" && "text-danger")}>
              {current.status === "broken"
                ? t("status.broken", { error: current.lastError ?? "" })
                : t("status.active", { time: relativeTime(current.verifiedAt, locale) })}
            </span>
            <span className="block">
              <FilesLine target={current} /> · {t("noQuota")}
            </span>
            {view.instanceUsed > 0 && <span className="block">{t("olderFiles", { size: used })}</span>}
            {error && (
              <span role="alert" className="block text-danger">
                {error}
              </span>
            )}
          </>
        }
        control={
          confirming ? null : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={() => run(() => retestStorageAction(workspaceId), onChange)}>
                {pending ? t("testing") : t("testAgain")}
              </Button>
              <Button size="sm" disabled={pending} onClick={onEdit}>
                {t("change")}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(true)}>
                {t("disconnect")}
              </Button>
            </div>
          )
        }
      >
        {confirming && (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 text-sm text-fg-muted">{t("disconnectNote")}</p>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                {tc("cancel")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() =>
                  run(
                    () => disconnectStorageAction(workspaceId),
                    (next) => {
                      setConfirming(false);
                      onChange(next);
                    },
                  )
                }
              >
                {t("disconnect")}
              </Button>
            </div>
          </div>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * Connects storage, or changes the connected one: an S3 bucket's settings and keys (left empty to
 * keep the current ones), or a sign-in to Drive or Dropbox.
 */
function StorageForm({
  workspaceId,
  current,
  oauthReady,
  onCancel,
  onSaved,
}: {
  workspaceId: string;
  current: StorageView | null;
  oauthReady: OAuthStorageKind[];
  onCancel?: () => void;
  onSaved: (view: StorageSettingsView) => void;
}) {
  const t = useTranslations("settings.storage");
  const [kind, setKind] = useState<StorageKind>(current?.kind ?? "s3");

  return (
    <div className="space-y-4 px-5 py-4">
      {AVAILABLE_STORAGE_KINDS.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("fields.kind")}</legend>
          {AVAILABLE_STORAGE_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="storage-kind" checked={kind === k} onChange={() => setKind(k)} />
              {t(`kinds.${k}`)}
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-sm text-fg-muted">{t(`kindHints.${kind}`)}</p>
      {isOAuthStorageKind(kind) ? (
        <SignInForm
          workspaceId={workspaceId}
          kind={kind}
          ready={oauthReady.includes(kind)}
          again={current?.kind === kind}
          onCancel={onCancel}
        />
      ) : (
        <S3Form workspaceId={workspaceId} current={current?.kind === "s3" ? current : null} onCancel={onCancel} onSaved={onSaved} />
      )}
    </div>
  );
}

const PROVIDERS: Record<OAuthStorageKind, { name: string; vars: string }> = {
  gdrive: { name: "Google Drive", vars: "STORAGE_GDRIVE_CLIENT_ID, STORAGE_GDRIVE_CLIENT_SECRET" },
  dropbox: { name: "Dropbox", vars: "STORAGE_DROPBOX_CLIENT_ID, STORAGE_DROPBOX_CLIENT_SECRET" },
};

/** Sends the browser to Drive or Dropbox to sign in; it comes back to this tab (see api/storage/oauth). */
function SignInForm({ workspaceId, kind, ready, again, onCancel }: { workspaceId: string; kind: OAuthStorageKind; ready: boolean; again: boolean; onCancel?: () => void }) {
  const t = useTranslations("settings.storage");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  const [leaving, setLeaving] = useState(false);
  const provider = PROVIDERS[kind];

  return (
    <div className="space-y-4">
      {ready ? (
        <p className="text-sm text-fg-muted">{t("signInHint", { provider: provider.name })}</p>
      ) : (
        <p className="text-sm text-fg-muted">{t("notConfigured", { provider: provider.name, vars: provider.vars })}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" disabled={pending || leaving} onClick={onCancel}>
            {tc("cancel")}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!ready || pending || leaving}
          onClick={() =>
            run(
              () => beginStorageOAuthAction(workspaceId, kind),
              ({ url }) => {
                setLeaving(true);
                window.location.assign(url);
              },
            )
          }
        >
          {pending || leaving ? t("signingIn") : again ? t("signInAgain", { provider: provider.name }) : t("signIn", { provider: provider.name })}
        </Button>
      </div>
    </div>
  );
}

/** An S3-compatible bucket's settings and keys. */
function S3Form({
  workspaceId,
  current,
  onCancel,
  onSaved,
}: {
  workspaceId: string;
  current: (StorageView & { kind: "s3" }) | null;
  onCancel?: () => void;
  onSaved: (view: StorageSettingsView) => void;
}) {
  const t = useTranslations("settings.storage");
  const tc = useTranslations("common");
  const kind = "s3";
  const [endpoint, setEndpoint] = useState(current?.config.endpoint ?? "");
  const [region, setRegion] = useState(current?.config.region ?? "");
  const [bucket, setBucket] = useState(current?.config.bucket ?? "");
  const [prefix, setPrefix] = useState(current?.config.prefix ?? "");
  const [pathStyle, setPathStyle] = useState(current?.config.forcePathStyle ?? true);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [tested, setTested] = useState(false);
  const test = useAction();
  const save = useAction();
  const pending = test.pending || save.pending;
  const input = () => ({ endpoint, region, bucket, prefix, forcePathStyle: pathStyle, accessKeyId, secretAccessKey });
  const keysOptional = Boolean(current);
  const ready = bucket.trim() && (keysOptional || (accessKeyId.trim() && secretAccessKey.trim()));
  const edited = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTested(false);
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.run(() => connectStorageAction(workspaceId, kind, input()), onSaved);
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("fields.endpoint")}</span>
        <Input
          type="url"
          value={endpoint}
          onChange={(e) => edited(setEndpoint)(e.target.value)}
          placeholder="https://storage.example.com"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="block text-xs text-fg-muted">{t("fields.endpointHint")}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.bucket")}</span>
          <Input value={bucket} required onChange={(e) => edited(setBucket)(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.region")}</span>
          <Input value={region} onChange={(e) => edited(setRegion)(e.target.value)} placeholder="us-east-1" autoComplete="off" spellCheck={false} />
          <span className="block text-xs text-fg-muted">{t("fields.regionHint")}</span>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("fields.prefix")}</span>
        <Input value={prefix} onChange={(e) => edited(setPrefix)(e.target.value)} placeholder="leafdesk" autoComplete="off" spellCheck={false} />
        <span className="block text-xs text-fg-muted">{t("fields.prefixHint")}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.accessKeyId")}</span>
          <Input
            value={accessKeyId}
            required={!keysOptional}
            onChange={(e) => edited(setAccessKeyId)(e.target.value)}
            placeholder={keysOptional ? t("fields.keysKeep") : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.secretAccessKey")}</span>
          <Input
            type="password"
            value={secretAccessKey}
            required={!keysOptional}
            onChange={(e) => edited(setSecretAccessKey)(e.target.value)}
            placeholder={keysOptional ? t("fields.keysKeep") : undefined}
            autoComplete="new-password"
          />
        </label>
      </div>
      <p className="text-xs text-fg-muted">{t("fields.keysHint")}</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={pathStyle} onChange={(e) => edited(setPathStyle)(e.target.checked)} />
        <span>
          {t("fields.pathStyle")}
          <span className="block text-xs text-fg-muted">{t("fields.pathStyleHint")}</span>
        </span>
      </label>
      {(test.error || save.error) && (
        <p role="alert" className="text-sm text-danger">
          {save.error ?? test.error}
        </p>
      )}
      {tested && !test.error && !save.error && (
        <p role="status" className="text-sm text-fg-muted">
          {t("testOk")}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            {tc("cancel")}
          </Button>
        )}
        <Button
          disabled={pending || !ready}
          onClick={() => {
            setTested(false);
            test.run(() => testStorageAction(workspaceId, kind, input()), () => setTested(true));
          }}
        >
          {test.pending ? t("testing") : t("test")}
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !ready}>
          {save.pending ? t("connecting") : current ? t("save") : t("connect")}
        </Button>
      </div>
    </form>
  );
}
