"use client";

import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { disconnectAccountAction, getStorageAccountsAction, renameAccountAction, retestAccountAction, setDefaultAccountAction } from "@/app/actions/storage";
import { Button, cn, Input } from "@/components/ui";
import { relativeTime } from "@/lib/relative-time";
import { locationTitle, type StorageAccountsView, type StorageAccountView, type StorageNotice } from "@/lib/workspace-storage";
import { SettingsGroup, SettingsRow } from "./section";
import { StorageConnectForm } from "./storage-connect";
import { useAction } from "./workspace-settings";

/**
 * Connected storage, in one's own account settings: storage connected once (an S3-compatible
 * bucket, Google Drive, Dropbox) and used by the workspaces one owns, each in a place of its own
 * there. The default one is used by new workspaces from the start. Disconnecting asks first and
 * names the workspaces still using it: their files move to another owner's storage where they can.
 */
export function AccountStorage({ initial, notice }: { initial: StorageAccountsView; notice?: StorageNotice }) {
  const t = useTranslations("settings.storage");
  const [view, setView] = useState(initial);
  const [connecting, setConnecting] = useState(false);
  const [shownNotice, setShownNotice] = useState(notice);

  useEffect(() => {
    if (notice) window.history.replaceState(null, "", `${window.location.pathname}?tab=apps`);
  }, [notice]);

  // With own storage off, the section is there only for storage connected before.
  if (!view.ownStorage && !view.accounts.length) return null;

  const reload = async () => {
    const result = await getStorageAccountsAction().catch(() => null);
    if (result?.ok) setView(result.data);
    setConnecting(false);
  };

  return (
    <SettingsGroup
      title={t("accounts.heading")}
      description={view.ownStorage ? t("accounts.description") : t("accounts.descriptionOff")}
      action={
        view.kinds.length > 0 && !connecting ? (
          <Button size="sm" onClick={() => setConnecting(true)}>
            {t("accounts.connect")}
          </Button>
        ) : undefined
      }
    >
      {shownNotice && (
        <p
          role="status"
          className={cn("mx-5 my-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm", shownNotice === "connected" ? "border-border text-fg-muted" : "border-danger/40 text-danger")}
        >
          <span className="flex-1">{shownNotice === "connected" ? t("accounts.connected") : shownNotice === "refused" ? t("notices.refused") : t(`errors.${shownNotice}`)}</span>
          <button type="button" className="text-fg-faint hover:text-fg" aria-label={t("dismiss")} onClick={() => setShownNotice(undefined)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}
      {view.accounts.map((account) => (
        <AccountRow key={account.id} account={account} onChange={setView} />
      ))}
      {!view.accounts.length && !connecting && <p className="px-5 py-4 text-sm text-fg-muted">{t("accounts.none")}</p>}
      {connecting && <StorageConnectForm kinds={view.kinds} unconfigured={view.unconfigured} onConnected={reload} onCancel={() => setConnecting(false)} />}
    </SettingsGroup>
  );
}

function AccountRow({ account, onChange }: { account: StorageAccountView; onChange: (view: StorageAccountsView) => void }) {
  const t = useTranslations("settings.storage");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { pending, error, run } = useAction();
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [confirming, setConfirming] = useState(false);
  const disconnected = account.status === "disconnected";

  return (
    <SettingsRow
      title={
        renaming ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => renameAccountAction(account.id, label), (next) => {
                setRenaming(false);
                onChange(next);
              });
            }}
          >
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} autoFocus aria-label={t("fields.label")} />
            <Button size="sm" type="submit" variant="primary" disabled={pending}>
              {t("save")}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRenaming(false)}>
              {tc("cancel")}
            </Button>
          </form>
        ) : (
          <>
            <span className="block text-xs font-normal text-fg-muted">
              {t(`kinds.${account.kind}`)}
              {account.isDefault && ` · ${t("accounts.default")}`}
            </span>
            {account.label}
          </>
        )
      }
      description={
        <>
          <span className="block">{locationTitle(account)}</span>
          <span className={cn("block", account.status !== "active" && "text-danger")}>
            {disconnected
              ? t("accounts.disconnected")
              : account.status === "broken"
                ? t("status.broken", { error: account.lastError ?? "" })
                : t("status.active", { time: relativeTime(account.verifiedAt, locale) })}
          </span>
          <span className="block">
            {account.workspaces.length ? t("accounts.usedBy", { workspaces: account.workspaces.map((w) => w.name).join(", ") }) : t("accounts.unused")}
          </span>
          {error && (
            <span role="alert" className="block text-danger">
              {error}
            </span>
          )}
        </>
      }
      control={
        renaming || confirming || disconnected ? null : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => run(() => retestAccountAction(account.id), onChange)}>
              {pending ? t("testing") : t("testAgain")}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setDefaultAccountAction(account.id, !account.isDefault), onChange)}>
              {account.isDefault ? t("accounts.unsetDefault") : t("accounts.setDefault")}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRenaming(true)}>
              {t("accounts.rename")}
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
          <div className="min-w-0 flex-1 space-y-1 text-sm text-fg-muted">
            <p>{account.workspaces.length ? t("accounts.disconnectUsed") : t("accounts.disconnectUnused")}</p>
            {account.workspaces.length > 0 && (
              <ul className="list-disc ps-5">
                {account.workspaces.map((w) => (
                  <li key={w.id}>{w.name}</li>
                ))}
              </ul>
            )}
          </div>
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
                  () => disconnectAccountAction(account.id),
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
  );
}
