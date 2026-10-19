"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { beginStorageOAuthAction, connectS3AccountAction, testS3AccountAction } from "@/app/actions/storage";
import { Button, Input } from "@/components/ui";
import { isOAuthStorageKind, type OAuthStorageKind, type StorageKind } from "@/lib/workspace-storage";
import { useAction } from "./workspace-settings";

/** The instance's settings each sign-in kind needs (named to the server's administrators only). */
const PROVIDERS: Record<OAuthStorageKind, { name: string; vars: string }> = {
  gdrive: { name: "Google Drive", vars: "STORAGE_GDRIVE_CLIENT_ID, STORAGE_GDRIVE_CLIENT_SECRET" },
  dropbox: { name: "Dropbox", vars: "STORAGE_DROPBOX_CLIENT_ID, STORAGE_DROPBOX_CLIENT_SECRET" },
};

/**
 * Connects storage to one's own account: an S3 bucket's settings and keys, or a sign-in to Drive or
 * Dropbox (the browser comes back to where it began, see api/storage/oauth). With `workspaceId`,
 * that workspace starts using it once connected. Only the kinds this server offers are shown;
 * `unconfigured` (for the server's administrators) says what to set for the others.
 */
export function StorageConnectForm({
  kinds,
  unconfigured,
  workspaceId,
  onConnected,
  onCancel,
}: {
  kinds: StorageKind[];
  unconfigured: OAuthStorageKind[];
  workspaceId?: string;
  onConnected: () => void;
  onCancel?: () => void;
}) {
  const t = useTranslations("settings.storage");
  const [kind, setKind] = useState<StorageKind>(kinds[0] ?? "s3");

  return (
    <div className="space-y-4 px-5 py-4">
      {kinds.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("fields.kind")}</legend>
          {kinds.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="storage-kind" checked={kind === k} onChange={() => setKind(k)} />
              {t(`kinds.${k}`)}
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-sm text-fg-muted">{t(`kindHints.${kind}`)}</p>
      {isOAuthStorageKind(kind) ? (
        <SignInForm workspaceId={workspaceId} kind={kind} onCancel={onCancel} />
      ) : (
        <S3Form workspaceId={workspaceId} onCancel={onCancel} onConnected={onConnected} />
      )}
      {unconfigured.map((k) => (
        <p key={k} className="text-xs text-fg-muted">
          {t("notConfigured", { provider: PROVIDERS[k].name, vars: PROVIDERS[k].vars })}
        </p>
      ))}
    </div>
  );
}

/** Sends the browser to Drive or Dropbox to sign in; it comes back to this page. */
function SignInForm({ workspaceId, kind, onCancel }: { workspaceId?: string; kind: OAuthStorageKind; onCancel?: () => void }) {
  const t = useTranslations("settings.storage");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  const [leaving, setLeaving] = useState(false);
  const provider = PROVIDERS[kind];

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t("signInHint", { provider: provider.name })}</p>
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
          disabled={pending || leaving}
          onClick={() =>
            run(
              () => beginStorageOAuthAction(kind, workspaceId),
              ({ url }) => {
                setLeaving(true);
                window.location.assign(url);
              },
            )
          }
        >
          {pending || leaving ? t("signingIn") : t("signIn", { provider: provider.name })}
        </Button>
      </div>
    </div>
  );
}

/** An S3-compatible bucket's settings and keys. */
function S3Form({ workspaceId, onCancel, onConnected }: { workspaceId?: string; onCancel?: () => void; onConnected: () => void }) {
  const t = useTranslations("settings.storage");
  const tc = useTranslations("common");
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [pathStyle, setPathStyle] = useState(true);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [tested, setTested] = useState(false);
  const test = useAction();
  const save = useAction();
  const pending = test.pending || save.pending;
  const input = () => ({ endpoint, region, bucket, prefix, forcePathStyle: pathStyle, accessKeyId, secretAccessKey });
  const ready = bucket.trim() && accessKeyId.trim() && secretAccessKey.trim();
  const edited = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setTested(false);
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.run(() => connectS3AccountAction({ ...input(), label }, workspaceId), onConnected);
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("fields.label")}</span>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={bucket || t("fields.labelPlaceholder")} maxLength={80} autoComplete="off" />
        <span className="block text-xs text-fg-muted">{t("fields.labelHint")}</span>
      </label>
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
          <Input value={accessKeyId} required onChange={(e) => edited(setAccessKeyId)(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.secretAccessKey")}</span>
          <Input type="password" value={secretAccessKey} required onChange={(e) => edited(setSecretAccessKey)(e.target.value)} autoComplete="new-password" />
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
            test.run(() => testS3AccountAction(input()), () => setTested(true));
          }}
        >
          {test.pending ? t("testing") : t("test")}
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !ready}>
          {save.pending ? t("connecting") : t("connect")}
        </Button>
      </div>
    </form>
  );
}
