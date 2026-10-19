"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { connectStorageAction, disconnectStorageAction, retestStorageAction, testStorageAction } from "@/app/actions/storage";
import { Button, cn, Input } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import { relativeTime } from "@/lib/relative-time";
import { AVAILABLE_STORAGE_KINDS, type StorageKind, type StorageSettingsView, type StorageView } from "@/lib/workspace-storage";
import { SettingsGroup, SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > Storage, for owners: where the workspace's uploads go (this server, or storage the
 * workspace brought), how that storage is doing, and the form that connects or changes it. Files
 * keep being served by Leafdesk, so the storage stays private.
 */
export function StorageSettings({ workspaceId, initial }: { workspaceId: string; initial: StorageSettingsView }) {
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState(false);
  const t = useTranslations("settings.storage");

  return (
    <div className="space-y-10">
      <CurrentGroup workspaceId={workspaceId} view={view} onChange={setView} onEdit={() => setEditing(true)} />
      {(!view.current || editing) && (
        <SettingsGroup title={view.current ? t("changeHeading") : t("connectHeading")} description={t("connectDescription")}>
          <StorageForm
            // A fresh form for each storage it changes.
            key={view.current?.id ?? "new"}
            workspaceId={workspaceId}
            current={view.current}
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

const hostOf = (target: StorageView) => (target.config.endpoint ? new URL(target.config.endpoint).host : "s3.amazonaws.com");
const targetTitle = (target: StorageView) =>
  `${target.config.bucket}${target.config.prefix ? `/${target.config.prefix}` : ""} · ${hostOf(target)}`;

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
            <span className="block text-xs font-normal text-fg-muted">{current.kind === "s3" ? t("kinds.s3") : current.kind}</span>
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

/** Connects storage, or changes the connected one (its keys may be left empty to keep them). */
function StorageForm({
  workspaceId,
  current,
  onCancel,
  onSaved,
}: {
  workspaceId: string;
  current: StorageView | null;
  onCancel?: () => void;
  onSaved: (view: StorageSettingsView) => void;
}) {
  const t = useTranslations("settings.storage");
  const tc = useTranslations("common");
  const [kind, setKind] = useState<StorageKind>(current?.kind ?? "s3");
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
      className="space-y-4 px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.run(() => connectStorageAction(workspaceId, kind, input()), onSaved);
      }}
    >
      {AVAILABLE_STORAGE_KINDS.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("fields.kind")}</legend>
          {AVAILABLE_STORAGE_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="storage-kind" checked={kind === k} onChange={() => edited(setKind)(k)} />
              {k === "s3" ? t("kinds.s3") : k}
            </label>
          ))}
        </fieldset>
      )}
      {kind === "s3" && <p className="text-sm text-fg-muted">{t("kindHints.s3")}</p>}
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
