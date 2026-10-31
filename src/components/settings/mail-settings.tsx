"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { lazyPart } from "@/components/lazy-part";
import { useEffect, useState } from "react";
import { disconnectMailboxAction, setDefaultMailboxAction, setMailDatabasesAction } from "@/app/actions/row-mail";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Button, cn, IconButton, PageIcon, pageLabel, selectClass, Switch } from "@/components/ui";
import { MAX_MAILBOXES, type MailboxView, type MailSettingsView, type OwnMailbox } from "@/lib/mail";
import { relativeTime } from "@/lib/relative-time";
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

// The forms come with opening one, not with the settings page.
const MailboxConnect = lazyPart(() => import("./mail-connect").then((m) => m.MailboxConnect), <div aria-busy="true" className="m-5 h-24 animate-pulse rounded-md bg-bg-subtle" />);

// A pasted signature's preview comes with a mailbox that has one.
const SavedPastedSignature = lazyPart(() => import("@/components/mail/pasted-signature").then((m) => m.SavedPastedSignature), <div aria-busy="true" className="mt-1 h-20" />);

// The editor comes with opening it too.
const SignatureEditor = lazyPart(() => import("./mail-signature").then((m) => m.SignatureEditor), <div aria-busy="true" className="h-32 animate-pulse rounded-md bg-bg-subtle" />);

/** What a mailbox signs mail with, shown as text and changed in the editor in its place. */
function SignatureRow({ mailbox, title, onSaved }: { mailbox: MailboxView; title: string; onSaved: (mailbox: MailboxView) => void }) {
  const t = useTranslations("account.mail");
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="px-5 py-4">
        <p className="mb-2 text-sm font-medium">{title}</p>
        <SignatureEditor
          mailbox={mailbox}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            onSaved(saved);
            setEditing(false);
          }}
        />
      </div>
    );
  }
  return (
    <SettingsRow
      title={title}
      description={
        mailbox.signature ? (
          // As messages show it: the HTML the server kept of it (server/mail-client/outgoing.ts cleanSignature).
          mailbox.signaturePasted ? (
            <SavedPastedSignature signature={mailbox.signature} className="mt-1 max-h-40" />
          ) : (
            <div className="mail-editor pointer-events-none line-clamp-4" dir="auto" dangerouslySetInnerHTML={{ __html: mailbox.signature }} />
          )
        ) : (
          t("signatureNone")
        )
      }
      control={
        <Button size="sm" onPointerEnter={() => void SignatureEditor.preload()} onClick={() => setEditing(true)}>
          {mailbox.signature ? t("signatureEdit") : t("signatureAdd")}
        </Button>
      }
    />
  );
}

const STATUS_ERRORS = ["blocked", "notFound", "auth", "signIn", "tls", "unreachable", "noInbox"] as const;
/** What went wrong reading a mailbox; for a Google one, a refused sign-in always means signing in again. */
const statusError = (mailbox: MailboxView) => {
  const code = STATUS_ERRORS.find((c) => c === mailbox.statusError) ?? "unreachable";
  return mailbox.auth === "google" && code === "auth" ? "signIn" : code;
};
/** What the browser came back from Google with (mailError), as an error text's key. */
const NOTICE_ERRORS = ["googleFailed", "googleScope", "consent", "disabled", "invalid", "blocked", "notFound", "auth", "signIn", "tls", "unreachable", "noInbox"] as const;


/**
 * Account > Email and calendar: the person's mailboxes in each workspace where email on rows is on
 * (server/row-mail/settings.ts listOwnMailboxes), each connected, changed or disconnected there and
 * one of them the default. A mailbox connected by signing in with Google comes back here with a
 * `notice` of how it went ("connected", or what went wrong).
 */
export function OwnMailboxes({ initial, notice }: { initial: OwnMailbox[]; notice?: string }) {
  const t = useTranslations("account.mail");
  const te = useTranslations("settings.email");
  const [list, setList] = useState(initial);
  const [shownNotice, setShownNotice] = useState(notice);
  // Shown once: reloading the page shouldn't say it again.
  useEffect(() => {
    if (notice) window.history.replaceState(null, "", `${window.location.pathname}?tab=mail`);
  }, [notice]);
  const noticeBox = shownNotice && (
    <p
      role="status"
      className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", shownNotice === "connected" ? "border-border text-fg-muted" : "border-danger/40 text-danger")}
    >
      <span className="flex-1">
        {shownNotice === "connected" ? te("googleConnected") : te(`errors.${NOTICE_ERRORS.find((c) => c === shownNotice) ?? "googleFailed"}`)}
      </span>
      <button type="button" className="text-fg-faint hover:text-fg" aria-label={te("dismiss")} onClick={() => setShownNotice(undefined)}>
        <X className="h-3.5 w-3.5" />
      </button>
    </p>
  );
  if (!list.length) {
    return (
      <SettingsGroup title={t("mailboxHeading")}>
        <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("noMailboxes")}</p>
      </SettingsGroup>
    );
  }
  return (
    <>
      {noticeBox}
      {list.map((entry) => (
        <MailboxGroup
          key={entry.workspaceId}
          // With one workspace there is nothing to tell apart.
          title={list.length > 1 ? t("mailboxIn", { workspace: entry.workspaceName }) : t("mailboxHeading")}
          workspaceId={entry.workspaceId}
          enabled={entry.enabled}
          google={entry.google}
          mailboxes={entry.mailboxes}
          onChange={(mailboxes) =>
            setList((all) => all.flatMap((e) => (e.workspaceId !== entry.workspaceId ? [e] : e.enabled || mailboxes.length ? [{ ...e, mailboxes }] : [])))
          }
        />
      ))}
    </>
  );
}

/** The default first, then in the order they came. */
const defaultFirst = (mailboxes: MailboxView[]) => [...mailboxes.filter((m) => m.isDefault), ...mailboxes.filter((m) => !m.isDefault)];

/**
 * The member's own mailboxes in a workspace: how each is doing, which is the default (with how
 * follow-ups send from it), and the form that connects another or changes one.
 */
function MailboxGroup({
  title,
  workspaceId,
  enabled,
  google,
  mailboxes,
  onChange,
}: {
  title: string;
  workspaceId: string;
  /** Off: the workspace turned email on rows off; mailboxes still connected can only be disconnected. */
  enabled: boolean;
  /** Whether a mailbox can be connected by signing in with Google. */
  google: boolean;
  mailboxes: MailboxView[];
  onChange: (mailboxes: MailboxView[]) => void;
}) {
  const t = useTranslations("settings.email");
  const ta = useTranslations("account.mail");
  const locale = useLocale();
  // The mailbox whose form is open, or "new" for another one.
  const [editing, setEditing] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  const description = !enabled ? ta("mailboxOff") : mailboxes.length > 1 ? `${t("mailboxDescription")} ${ta("defaultNote")}` : t("mailboxDescription");

  if (editing && enabled) {
    const mailbox = mailboxes.find((m) => m.id === editing) ?? null;
    return (
      <SettingsGroup title={title} description={description}>
        <MailboxConnect
          workspaceId={workspaceId}
          google={google}
          mailbox={mailbox}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            onChange(defaultFirst(mailboxes.some((m) => m.id === saved.id) ? mailboxes.map((m) => (m.id === saved.id ? saved : m)) : [...mailboxes, saved]));
            setEditing(null);
          }}
        />
      </SettingsGroup>
    );
  }
  if (!mailboxes.length) {
    // The form opens on request: someone in several workspaces would otherwise get one form each.
    return (
      <SettingsGroup title={title} description={description}>
        <SettingsRow
          title={ta("notConnected")}
          control={
            <Button size="sm" onClick={() => setEditing("new")}>
              {ta("connect")}
            </Button>
          }
        />
      </SettingsGroup>
    );
  }
  const main = mailboxes.find((m) => m.isDefault);
  return (
    <SettingsGroup title={title} description={description}>
      {mailboxes.map((mailbox) => {
        const status =
          mailbox.status === "error" ? t(`status.error.${statusError(mailbox)}`) : mailbox.status === "ok" ? t("status.ok") : t("status.connecting");
        return (
          <SettingsRow
            key={mailbox.id}
            title={
              <>
                {mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address}
                {mailbox.isDefault && mailboxes.length > 1 && <span className="ms-2 text-xs font-normal text-fg-muted">{ta("default")}</span>}
              </>
            }
            description={
              <>
                <span className={cn(mailbox.status === "error" && "text-danger")}>{status}</span>
                {mailbox.auth === "google" && <> · {t("googleSignedIn")}</>}
                {mailbox.syncedAt && <> · {t("syncedAt", { time: relativeTime(mailbox.syncedAt, locale) })}</>}
                {mailbox.folders.inbox && (
                  <span className="mt-1 block">
                    {mailbox.folders.sent
                      ? t("folders", { inbox: mailbox.folders.inbox, sent: mailbox.folders.sent })
                      : t("noSentFolder", { inbox: mailbox.folders.inbox })}
                  </span>
                )}
              </>
            }
            control={
              <div className="flex flex-wrap justify-end gap-2">
                {enabled && !mailbox.isDefault && (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setDefaultMailboxAction(mailbox.id), onChange)}>
                    {ta("makeDefault")}
                  </Button>
                )}
                {enabled && (
                  <Button size="sm" onClick={() => setEditing(mailbox.id)}>
                    {t("change")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => disconnectMailboxAction(mailbox.id), onChange)}>
                  {t("disconnect")}
                </Button>
              </div>
            }
          />
        );
      })}
      {error && <p className="px-5 py-2 text-sm text-danger">{error}</p>}
      {enabled &&
        mailboxes.map((mailbox) => (
          <SignatureRow
            key={`signature-${mailbox.id}`}
            mailbox={mailbox}
            title={mailboxes.length > 1 ? ta("signatureFor", { address: mailbox.address }) : ta("signature")}
            onSaved={(saved) => onChange(mailboxes.map((m) => (m.id === saved.id ? saved : m)))}
          />
        ))}
      {enabled && main && <MailboxSending key={main.id} mailbox={main} onChange={(saved) => onChange(mailboxes.map((m) => (m.id === saved.id ? saved : m)))} />}
      {enabled && (
        <SettingsRow
          title={ta("another")}
          description={mailboxes.length >= MAX_MAILBOXES ? ta("limitReached", { max: MAX_MAILBOXES }) : ta("anotherHelp")}
          control={
            <Button size="sm" disabled={mailboxes.length >= MAX_MAILBOXES} onClick={() => setEditing("new")}>
              {ta("addMailbox")}
            </Button>
          }
        />
      )}
    </SettingsGroup>
  );
}

/** Owners see who has a mailbox connected and how it is doing; nothing of what is in it. */
function MembersGroup({ members }: { members: MailSettingsView["members"] }) {
  const t = useTranslations("settings.email");
  return (
    <SettingsGroup title={t("membersHeading")} description={t("membersDescription")}>
      {members.map((m) => (
        <SettingsRow
          key={m.mailboxId}
          title={m.name}
          description={m.address}
          control={<span className={cn("text-sm", m.status === "error" ? "text-danger" : "text-fg-muted")}>{t(`memberStatus.${m.status}`)}</span>}
        />
      ))}
    </SettingsGroup>
  );
}
