"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { beginGoogleMailboxAction, connectMailboxAction } from "@/app/actions/row-mail";
import { Button, cn, Input, selectClass } from "@/components/ui";
import { MAIL_PROVIDERS, providerFor, type MailboxAuth, type MailboxServers, type MailboxView } from "@/lib/mail";
import { browserTimeZone } from "@/lib/time-zone";
import { useAction } from "./workspace-settings";

/**
 * The forms that connect a member's mailbox (mail-settings.tsx MailboxGroup), loaded when one is
 * opened: with a password over IMAP and SMTP, or by signing in with Google.
 */

const DEFAULT_SERVERS: MailboxServers = { imapHost: "", imapPort: 993, imapSecure: true, smtpHost: "", smtpPort: 465, smtpSecure: true };

/** Connecting a mailbox: by signing in with Google, when the server can, or with a password. */
export function MailboxConnect({
  workspaceId,
  google,
  mailbox,
  onCancel,
  onSaved,
}: {
  workspaceId: string;
  google: boolean;
  mailbox: MailboxView | null;
  onCancel?: () => void;
  onSaved: (mailbox: MailboxView) => void;
}) {
  const t = useTranslations("settings.email");
  const [method, setMethod] = useState<MailboxAuth>(google && (!mailbox || mailbox.auth === "google") ? "google" : "password");
  return (
    <div className="space-y-4 px-5 py-4">
      {google && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("fields.method")}</legend>
          {(["google", "password"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`mail-method-${workspaceId}`} checked={method === m} onChange={() => setMethod(m)} />
              {t(`methods.${m}`)}
            </label>
          ))}
        </fieldset>
      )}
      {method === "google" ? (
        <GoogleMailboxForm workspaceId={workspaceId} mailbox={mailbox} onCancel={onCancel} />
      ) : (
        <MailboxForm workspaceId={workspaceId} mailbox={mailbox} onCancel={onCancel} onSaved={onSaved} />
      )}
    </div>
  );
}

/** Sends the browser to Google to sign in; it comes back to this page, the mailbox connected or not. */
function GoogleMailboxForm({ workspaceId, mailbox, onCancel }: { workspaceId: string; mailbox: MailboxView | null; onCancel?: () => void }) {
  const t = useTranslations("settings.email");
  const tc = useTranslations("common");
  const [displayName, setDisplayName] = useState(mailbox?.displayName ?? "");
  const [consent, setConsent] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { pending, error, run } = useAction();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => beginGoogleMailboxAction(workspaceId, { consent, displayName, timeZone: browserTimeZone(), address: mailbox?.address ?? null }),
          ({ url }) => {
            setLeaving(true);
            window.location.assign(url);
          },
        );
      }}
    >
      <p className="text-sm text-fg-muted">{t("googleHint")}</p>
      <label className="block space-y-1 sm:w-1/2">
        <span className="text-sm font-medium">{t("fields.displayName")}</span>
        <Input value={displayName} maxLength={200} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{t("consent")}</span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" disabled={pending || leaving} onClick={onCancel}>
            {tc("cancel")}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={pending || leaving || !consent}>
          {pending || leaving ? t("googleLeaving") : t("googleConnect")}
        </Button>
      </div>
    </form>
  );
}

function MailboxForm({
  workspaceId,
  mailbox,
  onCancel,
  onSaved,
}: {
  workspaceId: string;
  mailbox: MailboxView | null;
  onCancel?: () => void;
  onSaved: (mailbox: MailboxView) => void;
}) {
  const t = useTranslations("settings.email");
  const tc = useTranslations("common");
  const [address, setAddress] = useState(mailbox?.address ?? "");
  const [displayName, setDisplayName] = useState(mailbox?.displayName ?? "");
  const [provider, setProvider] = useState(() => (mailbox ? (MAIL_PROVIDERS.find((p) => p.servers.imapHost === mailbox.servers.imapHost)?.id ?? "other") : ""));
  // A Google mailbox has no password to keep: changing it to one asks for it.
  const keepsPassword = mailbox?.auth === "password";
  const [servers, setServers] = useState<MailboxServers>(mailbox?.servers ?? DEFAULT_SERVERS);
  const [username, setUsername] = useState(mailbox?.username ?? "");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const { pending, error, run } = useAction();
  const chosen = MAIL_PROVIDERS.find((p) => p.id === provider);
  const effective = chosen ? chosen.servers : servers;
  const set = (patch: Partial<MailboxServers>) => setServers((s) => ({ ...s, ...patch }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            connectMailboxAction(workspaceId, {
              address,
              displayName,
              servers: effective,
              username: username.trim() || address.trim(),
              password,
              consent,
              timeZone: browserTimeZone(),
            }),
          onSaved,
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.address")}</span>
          <Input
            type="email"
            autoComplete="email"
            value={address}
            required
            onChange={(e) => {
              setAddress(e.target.value);
              // A known provider's servers fill in from the address.
              const known = providerFor(e.target.value.trim());
              if (known && !provider) setProvider(known.id);
            }}
            placeholder="ada@example.com"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.displayName")}</span>
          <Input value={displayName} maxLength={200} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("fields.provider")}</span>
        <select className={cn(selectClass, "w-full")} value={provider} required onChange={(e) => setProvider(e.target.value)}>
          <option value="" disabled>
            {t("fields.chooseProvider")}
          </option>
          {MAIL_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="other">{t("fields.otherProvider")}</option>
        </select>
        {chosen && <span className="block text-xs text-fg-muted">{t(`providerHelp.${chosen.id as "google" | "yandex" | "zoho"}`)}</span>}
      </label>
      {provider === "other" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ServerFields
            label={t("fields.imap")}
            host={servers.imapHost}
            port={servers.imapPort}
            secure={servers.imapSecure}
            onChange={(host, port, secure) => set({ imapHost: host, imapPort: port, imapSecure: secure })}
          />
          <ServerFields
            label={t("fields.smtp")}
            host={servers.smtpHost}
            port={servers.smtpPort}
            secure={servers.smtpSecure}
            onChange={(host, port, secure) => set({ smtpHost: host, smtpPort: port, smtpSecure: secure })}
          />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.username")}</span>
          <Input value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} placeholder={address || t("fields.usernamePlaceholder")} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("fields.password")}</span>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            required={!keepsPassword}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={keepsPassword ? t("fields.passwordKeep") : undefined}
          />
          <span className="block text-xs text-fg-muted">{t("fields.passwordHelp")}</span>
        </label>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{t("consent")}</span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {tc("cancel")}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={pending || !consent || !address.trim() || !provider || (!keepsPassword && !password)}>
          {pending ? t("testing") : t("connect")}
        </Button>
      </div>
    </form>
  );
}

function ServerFields({
  label,
  host,
  port,
  secure,
  onChange,
}: {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  onChange: (host: string, port: number, secure: boolean) => void;
}) {
  const t = useTranslations("settings.email.fields");
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <label className="block space-y-1">
        <span className="text-xs text-fg-muted">{t("host")}</span>
        <Input value={host} required onChange={(e) => onChange(e.target.value, port, secure)} placeholder="mail.example.com" />
      </label>
      <div className="flex items-end gap-3">
        <label className="block w-24 space-y-1">
          <span className="text-xs text-fg-muted">{t("port")}</span>
          <Input type="number" min={1} max={65535} value={port} required onChange={(e) => onChange(host, Number(e.target.value), secure)} />
        </label>
        <label className="flex h-8 items-center gap-1.5 text-sm">
          <input type="checkbox" checked={secure} onChange={(e) => onChange(host, port, e.target.checked)} />
          {t("tls")}
        </label>
      </div>
    </fieldset>
  );
}
