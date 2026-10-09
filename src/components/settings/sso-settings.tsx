"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import {
  createScimTokenAction,
  removeSsoConnectionAction,
  revokeScimTokenAction,
  saveSsoConnectionAction,
  verifySsoDomainsAction,
  type SsoActionResult,
} from "@/app/actions/sso";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Button, cn, Dialog, Input, selectClass } from "@/components/ui";
import type { WorkspaceSettings } from "@/db/schema";
import type { SsoConnection } from "@/server/sso";
import { CopyButton } from "./copy-button";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

export type SsoSetupInfo = {
  workspaceId: string;
  providerId: string;
  oidcRedirectUri: string;
  samlAcsUrl: string;
  samlEntityId: string;
  samlMetadataUrl: string;
  scimBaseUrl: string;
};

export type ScimTokenRow = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null };

/** Turns a failed SSO action into a sentence, naming the domain or address it is about. */
function useSsoError() {
  const t = useTranslations("settings.security.sso.errors");
  return (result: Extract<SsoActionResult<unknown>, { ok: false }>) =>
    t(result.error, { detail: result.detail ?? "" });
}

/**
 * "How members sign in": any method, or single sign-on only. Only offered once members can sign
 * in with single sign-on (a verified connection, or the instance's provider). Owners keep every
 * way of signing in, so a broken identity provider can't lock the workspace; guests too.
 */
export function LoginMethodSetting({
  workspaceId,
  settings,
  canEdit,
  available,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
  available: boolean;
}) {
  const t = useTranslations("settings.security.loginMethod");
  const ts = useTranslations("settings.security");
  const [value, setValue] = useState(settings.loginMethod);
  const { pending, error, run } = useAction();

  return (
    <SettingsRow
      title={t("title")}
      htmlFor="login-method"
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t("description")}
            {!canEdit ? <> {ts("ownersOnly")}</> : !available && value !== "sso" ? <> {t("setUpFirst")}</> : null}
          </>
        )
      }
      control={
        <select
          id="login-method"
          className={selectClass}
          value={value}
          disabled={!canEdit || pending || (!available && value !== "sso")}
          onChange={(e) => {
            const next = e.target.value as WorkspaceSettings["loginMethod"];
            const previous = value;
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { loginMethod: next });
              if (!result.ok) setValue(previous);
              return result;
            });
          }}
        >
          <option value="any">{t("any")}</option>
          <option value="sso">{t("sso")}</option>
        </select>
      }
    />
  );
}

/** One address an identity provider needs, with a copy button. */
function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <code className="mt-0.5 block text-xs break-all text-fg-muted" data-sso-value={label}>
          {value}
        </code>
        {hint && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
      </div>
      <CopyButton value={value} />
    </div>
  );
}

/** Settings > Security: what to enter at the identity provider (owners). */
export function SsoSetupDetails({ info }: { info: SsoSetupInfo }) {
  const t = useTranslations("settings.security.sso.setup");
  return (
    <>
      <CopyRow label={t("workspaceId")} value={info.workspaceId} />
      <CopyRow label={t("oidcRedirectUri")} value={info.oidcRedirectUri} hint={t("oidcRedirectUriHint")} />
      <CopyRow label={t("samlEntityId")} value={info.samlEntityId} />
      <CopyRow label={t("samlAcsUrl")} value={info.samlAcsUrl} />
      <CopyRow label={t("samlMetadataUrl")} value={info.samlMetadataUrl} />
    </>
  );
}

/**
 * The workspace's own identity provider (OIDC or SAML), its email domains and their DNS check.
 * Saving changed domains asks for the DNS check again; the connection signs no one in until then.
 */
export function SsoConnectionForm({
  workspaceId,
  connection,
}: {
  workspaceId: string;
  connection: SsoConnection | null;
}) {
  const t = useTranslations("settings.security.sso");
  const tc = useTranslations("common");
  const router = useRouter();
  const ids = useId();
  const describe = useSsoError();
  const [editing, setEditing] = useState(connection === null);
  const [protocol, setProtocol] = useState<"oidc" | "saml">(connection?.protocol ?? "oidc");
  const [issuer, setIssuer] = useState(connection?.oidc?.issuer ?? "");
  const [clientId, setClientId] = useState(connection?.oidc?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [samlMode, setSamlMode] = useState<"metadata" | "manual">(
    connection?.saml && !connection.saml.usesMetadata ? "manual" : "metadata",
  );
  const [metadataXml, setMetadataXml] = useState("");
  const [entryPoint, setEntryPoint] = useState(connection?.saml?.entryPoint ?? "");
  const [idpEntityId, setIdpEntityId] = useState(connection?.saml?.idpEntityId ?? "");
  const [certificate, setCertificate] = useState("");
  const [domains, setDomains] = useState(connection?.domains.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, startTransition] = useTransition();

  function act<T>(action: () => Promise<SsoActionResult<T>>, onOk?: (data: T) => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) return setError(describe(result));
        onOk?.(result.data);
        router.refresh();
      } catch {
        setError(tc("genericError"));
      }
    });
  }

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    act(
      () =>
        saveSsoConnectionAction(
          workspaceId,
          protocol === "oidc"
            ? { protocol, issuer, clientId, clientSecret, domains }
            : samlMode === "metadata"
              ? { protocol, metadataXml, domains }
              : { protocol, entryPoint, idpEntityId, certificate, domains },
        ),
      () => {
        setClientSecret("");
        setMetadataXml("");
        setCertificate("");
        setEditing(false);
        setNotice(t("saved"));
      },
    );
  };

  const field = (id: string, label: string, input: React.ReactNode, hint?: string) => (
    <div className="space-y-1.5">
      <label htmlFor={`${ids}-${id}`} className="block text-sm font-medium">
        {label}
      </label>
      {input}
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-4 px-5 py-4">
      {connection && !editing && (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">
                {connection.protocol === "oidc" ? t("connection.oidc") : t("connection.saml")}
                {" · "}
                <span className={connection.verified ? "text-fg" : "text-danger"}>
                  {connection.verified ? t("connection.active") : t("connection.unverified")}
                </span>
              </div>
              <p className="mt-1 break-all text-fg-muted">
                {connection.oidc?.issuer || connection.saml?.idpEntityId || connection.saml?.entryPoint}
              </p>
              <p className="mt-1 text-fg-muted">{t("connection.domains", { domains: connection.domains.join(", ") })}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => setEditing(true)} disabled={pending}>
                {t("edit")}
              </Button>
              {confirmRemove ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)} disabled={pending}>
                    {tc("cancel")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending}
                    onClick={() => act(() => removeSsoConnectionAction(workspaceId), () => setConfirmRemove(false))}
                  >
                    {t("confirmRemove")}
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setConfirmRemove(true)} disabled={pending}>
                  {t("remove")}
                </Button>
              )}
            </div>
          </div>
          {!connection.verified && (
            <div className="space-y-2 rounded-lg border border-border bg-bg p-3">
              <p className="text-sm">{t("dns.body")}</p>
              {connection.records.map((record) => (
                <div key={record.domain} className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-fg-muted">{t("dns.name")}</span>
                    <code className="min-w-0 flex-1 break-all" data-sso-record-name>
                      {record.name}
                    </code>
                    <CopyButton value={record.name} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-fg-muted">{t("dns.value")}</span>
                    <code className="min-w-0 flex-1 break-all" data-sso-record-value>
                      {record.value}
                    </code>
                    <CopyButton value={record.value} />
                  </div>
                </div>
              ))}
              <Button
                size="sm"
                variant="primary"
                disabled={pending}
                onClick={() => act(() => verifySsoDomainsAction(workspaceId), () => setNotice(t("dns.verified")))}
              >
                {pending ? t("dns.verifying") : t("dns.verify")}
              </Button>
            </div>
          )}
        </div>
      )}
      {editing && (
        <form className="space-y-4" onSubmit={save}>
          <fieldset className="flex gap-4 text-sm">
            <legend className="sr-only">{t("form.protocol")}</legend>
            {(["oidc", "saml"] as const).map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${ids}-protocol`}
                  className="accent-[var(--accent)]"
                  checked={protocol === value}
                  onChange={() => setProtocol(value)}
                />
                {t(`connection.${value}`)}
              </label>
            ))}
          </fieldset>
          {protocol === "oidc" ? (
            <>
              {field(
                "issuer",
                t("form.issuer"),
                <Input
                  id={`${ids}-issuer`}
                  value={issuer}
                  required
                  type="url"
                  placeholder="https://idp.example.com/realms/acme"
                  onChange={(e) => setIssuer(e.target.value)}
                />,
                t("form.issuerHint"),
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {field(
                  "client-id",
                  t("form.clientId"),
                  <Input id={`${ids}-client-id`} value={clientId} required onChange={(e) => setClientId(e.target.value)} />,
                )}
                {field(
                  "client-secret",
                  t("form.clientSecret"),
                  <Input
                    id={`${ids}-client-secret`}
                    type="password"
                    autoComplete="off"
                    value={clientSecret}
                    required={!connection?.oidc?.hasSecret}
                    placeholder={connection?.oidc?.hasSecret ? t("form.secretKept") : undefined}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />,
                )}
              </div>
            </>
          ) : (
            <>
              <fieldset className="flex gap-4 text-sm">
                <legend className="sr-only">{t("form.samlSource")}</legend>
                {(["metadata", "manual"] as const).map((value) => (
                  <label key={value} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`${ids}-saml-mode`}
                      className="accent-[var(--accent)]"
                      checked={samlMode === value}
                      onChange={() => setSamlMode(value)}
                    />
                    {t(`form.${value}`)}
                  </label>
                ))}
              </fieldset>
              {samlMode === "metadata" ? (
                field(
                  "metadata",
                  t("form.metadataXml"),
                  <textarea
                    id={`${ids}-metadata`}
                    className="h-32 w-full rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-xs outline-none focus:border-accent"
                    value={metadataXml}
                    required={!connection?.saml}
                    placeholder={connection?.saml ? t("form.metadataKept") : "<EntityDescriptor …>"}
                    onChange={(e) => setMetadataXml(e.target.value)}
                  />,
                )
              ) : (
                <>
                  {field(
                    "entry-point",
                    t("form.entryPoint"),
                    <Input
                      id={`${ids}-entry-point`}
                      type="url"
                      required
                      value={entryPoint}
                      onChange={(e) => setEntryPoint(e.target.value)}
                    />,
                  )}
                  {field(
                    "idp-entity",
                    t("form.idpEntityId"),
                    <Input id={`${ids}-idp-entity`} required value={idpEntityId} onChange={(e) => setIdpEntityId(e.target.value)} />,
                  )}
                  {field(
                    "certificate",
                    t("form.certificate"),
                    <textarea
                      id={`${ids}-certificate`}
                      className="h-28 w-full rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-xs outline-none focus:border-accent"
                      value={certificate}
                      required={!connection?.saml?.hasCertificate}
                      placeholder={connection?.saml?.hasCertificate ? t("form.certificateKept") : "-----BEGIN CERTIFICATE-----"}
                      onChange={(e) => setCertificate(e.target.value)}
                    />,
                  )}
                </>
              )}
            </>
          )}
          {field(
            "domains",
            t("form.domains"),
            <Input
              id={`${ids}-domains`}
              value={domains}
              required
              placeholder="example.com"
              onChange={(e) => setDomains(e.target.value)}
            />,
            t("form.domainsHint"),
          )}
          <div className="flex justify-end gap-2">
            {connection && (
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
                {tc("cancel")}
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? t("form.saving") : t("form.save")}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && !error && <p className="text-sm text-fg-muted">{notice}</p>}
    </div>
  );
}

/** SCIM: the base URL and the workspace's tokens (owners). */
export function ScimSettings({
  workspaceId,
  baseUrl,
  tokens,
  managed,
}: {
  workspaceId: string;
  baseUrl: string;
  tokens: ScimTokenRow[];
  /** People SCIM has provisioned or changed in this workspace. */
  managed: number;
}) {
  const t = useTranslations("settings.security.scim");
  return (
    <>
      <CopyRow label={t("baseUrl")} value={baseUrl} hint={t("managed", { count: managed })} />
      <SettingsRow title={t("tokens")} description={t("tokensDescription")} control={<NewScimToken workspaceId={workspaceId} />}>
        {tokens.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("empty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-bg">
            {tokens.map((token) => (
              <li key={token.id} className="flex items-center gap-3 px-3 py-2" data-scim-token={token.name}>
                <div className="min-w-0 flex-1 text-sm">
                  <div className="truncate font-medium">{token.name}</div>
                  <div className="text-xs text-fg-muted">
                    <code>{token.prefix}…</code> ·{" "}
                    {token.lastUsedAt
                      ? t("lastUsed", { date: new Date(token.lastUsedAt) })
                      : t("neverUsed")}
                  </div>
                </div>
                <RevokeScimToken workspaceId={workspaceId} token={token} />
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
    </>
  );
}

function NewScimToken({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("settings.security.scim");
  const tc = useTranslations("common");
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const close = () => {
    setOpen(false);
    if (secret) router.refresh();
    setName("");
    setSecret(null);
    setError(null);
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t("create")}
      </Button>
      {/* While the secret is shown, only Done closes: a stray click must not lose it. */}
      <Dialog open={open} onClose={secret ? () => {} : close} className="max-w-md">
        {secret ? (
          <div className="space-y-4 p-5">
            <div>
              <h2 className="text-[15px] font-semibold">{t("created.title")}</h2>
              <p className="mt-1 text-sm text-fg-muted">{t("created.body")}</p>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle py-1.5 pr-1.5 pl-3">
              <code className="min-w-0 flex-1 text-xs break-all" data-scim-token-secret>
                {secret}
              </code>
              <CopyButton value={secret} />
            </div>
            <div className="flex justify-end">
              <Button variant="primary" onClick={close}>
                {t("created.done")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              startTransition(async () => {
                try {
                  const result = await createScimTokenAction(workspaceId, name);
                  if (result.ok) setSecret(result.data);
                  else setError(t(`errors.${result.error === "limit" || result.error === "name" ? result.error : "generic"}`));
                } catch {
                  setError(tc("genericError"));
                }
              });
            }}
          >
            <h2 className="text-[15px] font-semibold">{t("form.title")}</h2>
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-name`} className="block text-sm font-medium">
                {t("form.name")}
              </label>
              <Input
                id={`${ids}-name`}
                value={name}
                maxLength={100}
                required
                autoFocus
                placeholder={t("form.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={pending}>
                {tc("cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
                {t("form.submit")}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

function RevokeScimToken({ workspaceId, token }: { workspaceId: string; token: ScimTokenRow }) {
  const t = useTranslations("settings.security.scim");
  const tc = useTranslations("common");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  if (!confirming) {
    return (
      <Button size="sm" onClick={() => setConfirming(true)}>
        {t("revoke")}
      </Button>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await revokeScimTokenAction(workspaceId, token.id).catch(() => null);
              if (result?.ok) router.refresh();
              else setError(true);
            })
          }
        >
          {t("confirmRevoke", { name: token.name })}
        </Button>
      </div>
      {error && <p className={cn("text-xs text-danger")}>{tc("genericError")}</p>}
    </div>
  );
}
