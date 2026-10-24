"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { connectMailboxAction, disconnectMailboxAction, setMailDatabasesAction } from "@/app/actions/row-mail";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Button, cn, IconButton, Input, PageIcon, pageLabel, selectClass, Switch } from "@/components/ui";
import { MAIL_PROVIDERS, providerFor, type MailboxServers, type MailboxView, type MailSettingsView, type OwnMailbox } from "@/lib/mail";
import { relativeTime } from "@/lib/relative-time";
import { browserTimeZone } from "@/lib/time-zone";
import { MailboxSending, SequencesGroups } from "./follow-up-settings";
import { SettingsGroup, SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > General > Email: owners turn email on rows on and pick the databases mail lands on, in
 * order, with the email properties that hold the other party's address, and see whose mailbox is
 * connected and how it is doing; members see whether it is on. Each member connects their own
 * mailbox under their account (OwnMailboxes).
 */
export function MailSettings({ workspaceId, initial }: { workspaceId: string; initial: MailSettingsView }) {
  const t = useTranslations("settings.email");
  const [view, setView] = useState(initial);
  const toggle = useAction();

  return (
    <div className="space-y-10">
      <SettingsGroup anchor="workspaceMail" title={t("heading")} description={t("description")}>
        <SettingsRow
          title={t("enabled")}
          description={
            toggle.error ? (
              <span className="text-danger">{toggle.error}</span>
            ) : (
              <>
                {t("enabledHint")}
                {!view.canManage && <> {t("ownersOnly")}</>}
              </>
            )
          }
          control={
            <Switch
              checked={view.enabled}
              label={t("enabled")}
              disabled={!view.canManage || toggle.pending}
              onChange={(next) => {
                setView((v) => ({ ...v, enabled: next }));
                toggle.run(async () => {
                  const result = await updateWorkspaceSettingsAction(workspaceId, { email: next });
                  if (!result.ok) setView((v) => ({ ...v, enabled: !next }));
                  return result;
                });
              }}
            />
          }
        />
      </SettingsGroup>
      {view.enabled && view.canManage && <DatabasesGroup workspaceId={workspaceId} view={view} onChange={setView} />}
      {view.enabled && view.canManage && <SequencesGroups databases={view.databases} />}
      {view.enabled && view.canManage && view.members.length > 0 && <MembersGroup members={view.members} />}
    </div>
  );
}

type Entry = { databaseId: string; propertyIds: string[] };

/** The databases mail lands on, in the order they are tried, each with the properties that hold addresses. */
function DatabasesGroup({ workspaceId, view, onChange }: { workspaceId: string; view: MailSettingsView; onChange: (view: MailSettingsView) => void }) {
  const t = useTranslations("settings.email");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  const entries: Entry[] = view.databases.map((d) => ({ databaseId: d.databaseId, propertyIds: d.propertyIds }));
  const save = (next: Entry[]) => run(() => setMailDatabasesAction(workspaceId, next), onChange);
  const move = (index: number, by: number) => {
    const next = [...entries];
    const [taken] = next.splice(index, 1);
    next.splice(index + by, 0, taken);
    save(next);
  };

  return (
    <SettingsGroup title={t("databasesHeading")} description={t("databasesDescription")}>
      {view.databases.length === 0 && <SettingsRow title={t("databasesNone")} description={t("databasesNoneHint")} />}
      {view.databases.map((database, index) => (
        <div key={database.databaseId} className="px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-sm text-fg-faint tabular-nums">{index + 1}</span>
            <PageIcon icon={database.icon} kind="database" className="text-sm" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{pageLabel(database.title, tc("untitled"))}</span>
            <IconButton label={t("moveUp")} disabled={pending || index === 0} onClick={() => move(index, -1)}>
              <ArrowUp className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={t("moveDown")} disabled={pending || index === view.databases.length - 1} onClick={() => move(index, 1)}>
              <ArrowDown className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={t("removeDatabase")} disabled={pending} onClick={() => save(entries.filter((e) => e.databaseId !== database.databaseId))}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
          <fieldset className="mt-2 ps-7">
            <legend className="text-xs text-fg-muted">{t("addressProperties")}</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {database.emailProperties.map((property) => {
                const checked = database.propertyIds.includes(property.id);
                return (
                  <label key={property.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      // The last one stays: a database without one gets no mail (remove it instead).
                      disabled={pending || (checked && database.propertyIds.length === 1)}
                      onChange={() =>
                        save(
                          entries.map((e) =>
                            e.databaseId === database.databaseId
                              ? { ...e, propertyIds: checked ? e.propertyIds.filter((id) => id !== property.id) : [...e.propertyIds, property.id] }
                              : e,
                          ),
                        )
                      }
                    />
                    {property.name || tc("untitled")}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
      ))}
      {view.candidates.length > 0 && (
        <SettingsRow
          title={t("addDatabase")}
          description={error ? <span className="text-danger">{error}</span> : t("addDatabaseHint")}
          control={
            <select
              className={selectClass}
              value=""
              disabled={pending}
              aria-label={t("addDatabase")}
              onChange={(e) => {
                const databaseId = e.target.value;
                if (!databaseId) return;
                // Every email property to begin with; unticking narrows it.
                save([...entries, { databaseId, propertyIds: ["*"] }]);
              }}
            >
              <option value="">{t("chooseDatabase")}</option>
              {view.candidates.map((c) => (
                <option key={c.databaseId} value={c.databaseId}>
                  {pageLabel(c.title, tc("untitled"))}
                </option>
              ))}
            </select>
          }
        />
      )}
      {view.candidates.length === 0 && error && <SettingsRow title={<span className="text-danger">{error}</span>} />}
    </SettingsGroup>
  );
}

const STATUS_ERRORS = ["blocked", "notFound", "auth", "tls", "unreachable", "noInbox"] as const;
const statusError = (code: string | null) => STATUS_ERRORS.find((c) => c === code) ?? "unreachable";

const DEFAULT_SERVERS: MailboxServers = { imapHost: "", imapPort: 993, imapSecure: true, smtpHost: "", smtpPort: 465, smtpSecure: true };

/**
 * Account > Email and calendar: the person's mailbox in each workspace where email on rows is on
 * (server/row-mail/settings.ts listOwnMailboxes), each connected, changed or disconnected there.
 */
export function OwnMailboxes({ initial }: { initial: OwnMailbox[] }) {
  const t = useTranslations("account.mail");
  const [list, setList] = useState(initial);
  if (!list.length) {
    return (
      <SettingsGroup title={t("mailboxHeading")}>
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("noMailboxes")}</p>
      </SettingsGroup>
    );
  }
  return list.map((entry) => (
    <MailboxGroup
      key={entry.workspaceId}
      // With one workspace there is nothing to tell apart.
      title={list.length > 1 ? t("mailboxIn", { workspace: entry.workspaceName }) : t("mailboxHeading")}
      workspaceId={entry.workspaceId}
      enabled={entry.enabled}
      mailbox={entry.mailbox}
      onChange={(mailbox) =>
        setList((all) => all.flatMap((e) => (e.workspaceId !== entry.workspaceId ? [e] : e.enabled || mailbox ? [{ ...e, mailbox }] : [])))
      }
    />
  ));
}

/** The member's own mailbox in a workspace: how it is doing, or the form that connects it (and changes it). */
function MailboxGroup({
  title,
  workspaceId,
  enabled,
  mailbox,
  onChange,
}: {
  title: string;
  workspaceId: string;
  /** Off: the workspace turned email on rows off; a mailbox still connected can only be disconnected. */
  enabled: boolean;
  mailbox: MailboxView | null;
  onChange: (mailbox: MailboxView | null) => void;
}) {
  const t = useTranslations("settings.email");
  const ta = useTranslations("account.mail");
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const { pending, error, run } = useAction();

  if (mailbox && (!editing || !enabled)) {
    const status =
      mailbox.status === "error" ? t(`status.error.${statusError(mailbox.statusError)}`) : mailbox.status === "ok" ? t("status.ok") : t("status.connecting");
    return (
      <SettingsGroup title={title} description={enabled ? t("mailboxDescription") : ta("mailboxOff")}>
        <SettingsRow
          title={mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address}
          description={
            <>
              <span className={cn(mailbox.status === "error" && "text-danger")}>{status}</span>
              {mailbox.syncedAt && <> · {t("syncedAt", { time: relativeTime(mailbox.syncedAt, locale) })}</>}
              {mailbox.folders.inbox && (
                <span className="mt-1 block">
                  {mailbox.folders.sent
                    ? t("folders", { inbox: mailbox.folders.inbox, sent: mailbox.folders.sent })
                    : t("noSentFolder", { inbox: mailbox.folders.inbox })}
                </span>
              )}
              {error && <span className="block text-danger">{error}</span>}
            </>
          }
          control={
            <div className="flex gap-2">
              {enabled && (
                <Button size="sm" onClick={() => setEditing(true)}>
                  {t("change")}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => disconnectMailboxAction(workspaceId), () => onChange(null))}>
                {t("disconnect")}
              </Button>
            </div>
          }
        />
        {enabled && <MailboxSending workspaceId={workspaceId} mailbox={mailbox} onChange={onChange} />}
      </SettingsGroup>
    );
  }
  if (!editing) {
    // The form opens on request: someone in several workspaces would otherwise get one form each.
    return (
      <SettingsGroup title={title} description={t("mailboxDescription")}>
        <SettingsRow
          title={ta("notConnected")}
          control={
            <Button size="sm" onClick={() => setEditing(true)}>
              {ta("connect")}
            </Button>
          }
        />
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup title={title} description={t("mailboxDescription")}>
      <MailboxForm
        workspaceId={workspaceId}
        mailbox={mailbox}
        onCancel={() => setEditing(false)}
        onSaved={(saved) => {
          onChange(saved);
          setEditing(false);
        }}
      />
    </SettingsGroup>
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
      className="space-y-4 px-5 py-4"
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
            required={!mailbox}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mailbox ? t("fields.passwordKeep") : undefined}
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
        <Button type="submit" variant="primary" disabled={pending || !consent || !address.trim() || !provider || (!mailbox && !password)}>
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

/** Owners see who has a mailbox connected and how it is doing; nothing of what is in it. */
function MembersGroup({ members }: { members: MailSettingsView["members"] }) {
  const t = useTranslations("settings.email");
  return (
    <SettingsGroup title={t("membersHeading")} description={t("membersDescription")}>
      {members.map((m) => (
        <SettingsRow
          key={m.userId}
          title={m.name}
          description={m.address}
          control={<span className={cn("text-sm", m.status === "error" ? "text-danger" : "text-fg-muted")}>{t(`memberStatus.${m.status}`)}</span>}
        />
      ))}
    </SettingsGroup>
  );
}
