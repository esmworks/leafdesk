"use client";

import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  disconnectStorageAction,
  dismissMoveAction,
  moveFilesAction,
  retestStorageAction,
  retryMoveAction,
  storageSettingsAction,
  attachStorageAccountAction,
} from "@/app/actions/storage";
import { Button, cn, selectClass } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import { relativeTime } from "@/lib/relative-time";
import { locationTitle, type MoveDestinationView, type StorageMoveView, type StorageNotice, type StorageSettingsView, type StorageView } from "@/lib/workspace-storage";
import { SettingsGroup, SettingsRow } from "./section";
import { StorageConnectForm } from "./storage-connect";
import { useAction } from "./workspace-settings";

/**
 * Settings > Storage, for owners: where the workspace's uploads go (this server, or storage one of
 * its owners connected to their account), how that storage is doing, using one of one's own
 * storage accounts instead (or connecting one), and moving the files from one to the other.
 * Files keep being served by Leafdesk, so the storage stays private and members need no account
 * there. Google Drive and Dropbox are connected by signing in there; the browser comes back with
 * a `notice` of how it went.
 */
export function StorageSettings({ workspaceId, initial, notice }: { workspaceId: string; initial: StorageSettingsView; notice?: StorageNotice }) {
  const [view, setView] = useState(initial);
  const [shownNotice, setShownNotice] = useState(notice);
  const t = useTranslations("settings.storage");
  const moving = view.move?.status === "queued" || view.move?.status === "running";

  // Shown once: reloading the page shouldn't say it again.
  useEffect(() => {
    if (notice) window.history.replaceState(null, "", `${window.location.pathname}?tab=storage`);
  }, [notice]);

  // While files move, the progress is read again every few seconds.
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(async () => {
      const result = await storageSettingsAction(workspaceId).catch(() => null);
      if (result?.ok) setView(result.data);
    }, 3000);
    return () => clearInterval(timer);
  }, [moving, workspaceId]);

  const reload = async () => {
    const result = await storageSettingsAction(workspaceId).catch(() => null);
    if (result?.ok) setView(result.data);
  };

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
      {view.move && <MoveNotice workspaceId={workspaceId} move={view.move} onChange={setView} />}
      <CurrentGroup workspaceId={workspaceId} view={view} onChange={setView} moving={moving} />
      {view.ownStorage && !moving && <UseGroup workspaceId={workspaceId} view={view} onChange={setView} onConnected={reload} />}
      {!moving && view.destinations.length > 0 && <MoveGroup workspaceId={workspaceId} destinations={view.destinations} onChange={setView} />}
      {view.retired.length > 0 && (
        <SettingsGroup title={t("retiredHeading")} description={t("retiredDescription")}>
          {view.retired.map((target) => (
            <SettingsRow
              key={target.id}
              title={locationTitle(target)}
              description={
                <>
                  <span className="block">
                    <FilesLine target={target} />
                  </span>
                  <OwnerLine target={target} />
                </>
              }
            />
          ))}
        </SettingsGroup>
      )}
    </div>
  );
}

function FilesLine({ target }: { target: StorageView }) {
  const t = useTranslations("settings.storage");
  return <>{t("files", { count: target.files, size: formatBytes(target.bytes) })}</>;
}

/** Whose storage it is: the viewer's own, an owner's by name, or someone's who has left Leafdesk. */
function OwnerLine({ target }: { target: StorageView }) {
  const t = useTranslations("settings.storage");
  const text = target.mine ? t("owner.mine", { label: target.accountLabel }) : target.ownerName ? t("owner.other", { name: target.ownerName }) : t("owner.gone");
  return <span className="block">{text}</span>;
}

/** Where new uploads go now, with what can be done about it. */
function CurrentGroup({ workspaceId, view, onChange, moving }: { workspaceId: string; view: StorageSettingsView; onChange: (view: StorageSettingsView) => void; moving: boolean }) {
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

  const broken = current.status !== "active";
  return (
    <SettingsGroup title={t("currentHeading")}>
      <SettingsRow
        title={
          <>
            <span className="block text-xs font-normal text-fg-muted">{t(`kinds.${current.kind}`)}</span>
            {locationTitle(current)}
          </>
        }
        description={
          <>
            <span className={cn("block", broken && "text-danger")}>
              {broken ? t("status.broken", { error: current.lastError ?? "" }) : t("status.active", { time: relativeTime(current.verifiedAt, locale) })}
            </span>
            {broken && <span className="block text-danger">{t("brokenHelp")}</span>}
            <OwnerLine target={current} />
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
          confirming || moving ? null : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={() => run(() => retestStorageAction(workspaceId), onChange)}>
                {pending ? t("testing") : t("testAgain")}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(true)}>
                {t("stopUsing")}
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
                {t("stopUsing")}
              </Button>
            </div>
          </div>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

/** Using one of one's own storage accounts for the workspace's new uploads, or connecting one. */
function UseGroup({
  workspaceId,
  view,
  onChange,
  onConnected,
}: {
  workspaceId: string;
  view: StorageSettingsView;
  onChange: (view: StorageSettingsView) => void;
  onConnected: () => void;
}) {
  const t = useTranslations("settings.storage");
  const { pending, error, run } = useAction();
  const usable = view.accounts.filter((a) => a.status !== "disconnected" && a.id !== (view.current?.mine ? view.current.accountId : null));
  const [chosen, setChosen] = useState(usable[0]?.id ?? "");
  const [connecting, setConnecting] = useState(usable.length === 0);
  if (!view.kinds.length && !usable.length) return null;

  return (
    <SettingsGroup title={view.current ? t("useOtherHeading") : t("useHeading")} description={t("useDescription")}>
      {usable.length > 0 && !connecting && (
        <div className="space-y-3 px-5 py-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t("useAccount")}</span>
            <select className={selectClass} value={chosen} onChange={(e) => setChosen(e.target.value)}>
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} · {t(`kinds.${a.kind}`)}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {view.kinds.length > 0 && (
              <Button variant="ghost" disabled={pending} onClick={() => setConnecting(true)}>
                {t("connectNew")}
              </Button>
            )}
            <Button variant="primary" disabled={pending || !chosen} onClick={() => run(() => attachStorageAccountAction(workspaceId, chosen), onChange)}>
              {pending ? t("testing") : t("use")}
            </Button>
          </div>
        </div>
      )}
      {connecting && view.kinds.length > 0 && (
        <StorageConnectForm
          kinds={view.kinds}
          unconfigured={view.unconfigured}
          workspaceId={workspaceId}
          onConnected={onConnected}
          onCancel={usable.length ? () => setConnecting(false) : undefined}
        />
      )}
    </SettingsGroup>
  );
}

const destinationKey = (d: MoveDestinationView) => (d.kind === "server" ? "server" : d.accountId);

/** Moving every file of the workspace somewhere else: one of one's storage accounts, or the server's storage. */
function MoveGroup({ workspaceId, destinations, onChange }: { workspaceId: string; destinations: MoveDestinationView[]; onChange: (view: StorageSettingsView) => void }) {
  const t = useTranslations("settings.storage");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  const [chosen, setChosen] = useState(destinationKey(destinations[0]));
  const [confirming, setConfirming] = useState(false);
  const destination = destinations.find((d) => destinationKey(d) === chosen) ?? destinations[0];
  const name = (d: MoveDestinationView) => (d.kind === "server" ? t("move.server") : `${d.label} · ${t(`kinds.${d.kind}`)}`);

  return (
    <SettingsGroup title={t("move.heading")} description={t("move.description")}>
      <div className="space-y-3 px-5 py-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("move.to")}</span>
          <select
            className={selectClass}
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              setConfirming(false);
            }}
          >
            {destinations.map((d) => (
              <option key={destinationKey(d)} value={destinationKey(d)}>
                {name(d)}
              </option>
            ))}
          </select>
        </label>
        {confirming && <p className="text-sm text-fg-muted">{t("move.confirm", { destination: name(destination) })}</p>}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {confirming && (
            <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              {tc("cancel")}
            </Button>
          )}
          <Button
            variant={confirming ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => {
              if (!confirming) return setConfirming(true);
              run(() => moveFilesAction(workspaceId, destination.kind === "server" ? { server: true } : { accountId: destination.accountId }), (next) => {
                setConfirming(false);
                onChange(next);
              });
            }}
          >
            {t("move.start")}
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

/** How the latest move of the workspace's files is going, or how it ended. */
function MoveNotice({ workspaceId, move, onChange }: { workspaceId: string; move: StorageMoveView; onChange: (view: StorageSettingsView) => void }) {
  const t = useTranslations("settings.storage");
  const { pending, error, run } = useAction();
  const destination = move.destination.kind === "server" ? t("move.server") : move.destination.label;
  const trouble = move.status === "failed" || move.status === "blocked";
  const text = (() => {
    switch (move.status) {
      case "queued":
        return t("move.queued", { destination });
      case "running":
        return t("move.running", { destination, moved: move.moved, files: move.files });
      case "done":
        return t("move.done", { destination, files: move.moved });
      case "failed":
        return t("move.failed", { destination, failed: move.failed, error: move.lastError ?? "" });
      case "blocked":
        return t("move.blocked");
    }
  })();

  return (
    <div role="status" className={cn("space-y-2 rounded-md border px-3 py-2 text-sm", trouble ? "border-danger/40" : "border-border")}>
      <p className={cn(trouble ? "text-danger" : "text-fg-muted")}>
        {move.reason !== "manual" && <span className="block text-xs">{t(`move.reasons.${move.reason}`)}</span>}
        {text}
      </p>
      {move.status === "running" && move.files > 0 && (
        <div className="h-1.5 overflow-hidden rounded bg-fg/10" aria-hidden>
          <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.round((move.moved / move.files) * 100))}%` }} />
        </div>
      )}
      {trouble && <p className="text-xs text-fg-muted">{t("move.backupHint")}</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {(trouble || move.status === "done") && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => dismissMoveAction(workspaceId, move.id), onChange)}>
            {t("dismiss")}
          </Button>
          {trouble && (
            <Button size="sm" disabled={pending} onClick={() => run(() => retryMoveAction(workspaceId, move.id), onChange)}>
              {t("move.retry")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
