"use client";

import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  loadDeletedSchemaAction,
  purgePropertyAction,
  purgeViewAction,
  restorePropertyAction,
  restoreViewAction,
} from "@/app/actions/databases";
import { IconButton } from "@/components/ui";
import type { DeletedProperty, DeletedView } from "@/lib/deleted-schema";
import { trashDeletionDate } from "@/lib/retention";
import { PropertyTypeIcon, ViewIcon } from "./property-icons";

type Loaded = { properties: DeletedProperty[]; views: DeletedView[]; retentionDays: number };
type Result = { ok: true } | { ok: false; error: string };

/**
 * The deleted properties (or views) of a database, newest first, each with when and by whom it was
 * deleted, when the daily cleanup deletes it for good, and buttons to restore it or delete it
 * permanently. Shown inside the Properties menu and the add-view menu, to people who may change
 * the database's schema; `reloadKey` changes when the database does, so restores elsewhere show.
 */
export function DeletedSchemaList({
  kind,
  databaseId,
  reloadKey,
  onBack,
  onChanged,
}: {
  kind: "properties" | "views";
  databaseId: string;
  reloadKey: unknown;
  onBack: () => void;
  /** After a restore or a permanent delete: the database reloads. */
  onChanged: () => void;
}) {
  const t = useTranslations("database.deleted");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const load = async () => {
    const result = await loadDeletedSchemaAction(databaseId);
    if (result.ok) setLoaded(result.data);
    else setError(result.error);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads when the database changes
  }, [databaseId, reloadKey]);

  /** Runs a restore or a permanent delete, then reloads the list and the database. */
  const run = (action: () => Promise<Result>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      onChanged();
      await load();
    });
  };

  const now = new Date();
  const when = (deletedAt: Date, deletedBy: string | null) => {
    const ago = format.relativeTime(deletedAt, now);
    return deletedBy ? t("deletedBy", { when: ago, name: deletedBy }) : t("deletedWhen", { when: ago });
  };
  const purgeNote = (deletedAt: Date) => {
    const at = loaded && trashDeletionDate(deletedAt, loaded.retentionDays);
    return at ? t("purgesOn", { date: format.dateTime(at, { dateStyle: "medium" }) }) : null;
  };

  const items =
    kind === "properties"
      ? (loaded?.properties ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          icon: <PropertyTypeIcon type={p.type} className="h-3.5 w-3.5 text-fg-muted" />,
          paired: p.pairedName,
          deletedAt: p.deletedAt,
          deletedBy: p.deletedBy,
          restore: () => run(() => restorePropertyAction(p.id)),
          purge: () => {
            if (confirm(t("confirmPurgeProperty", { name: p.name }))) run(() => purgePropertyAction(p.id));
          },
        }))
      : (loaded?.views ?? []).map((v) => ({
          id: v.id,
          name: v.name,
          icon: <ViewIcon type={v.type} className="h-3.5 w-3.5 text-fg-muted" />,
          paired: null,
          deletedAt: v.deletedAt,
          deletedBy: v.deletedBy,
          restore: () => run(() => restoreViewAction(v.id)),
          purge: () => {
            if (confirm(t("confirmPurgeView", { name: v.name }))) run(() => purgeViewAction(v.id));
          },
        }));

  return (
    <div className="w-72 max-w-[calc(100vw-2rem)]" aria-busy={busy}>
      <Header title={t(kind)} back={t("back")} onBack={onBack} />
      {error && (
        <p role="alert" className="px-2 pb-1.5 text-xs text-danger">
          {error}
        </p>
      )}
      {loaded && !items.length && (
        <p className="px-2 pb-2 text-xs text-fg-faint">{t(kind === "properties" ? "noProperties" : "noViews")}</p>
      )}
      <ul className="max-h-80 overflow-y-auto">
        {items.map((item) => {
          const purgesOn = purgeNote(item.deletedAt);
          return (
            <li key={item.id} className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-bg-hover">
              <span className="mt-0.5 shrink-0">{item.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{item.name}</div>
                <div className="text-xs text-fg-muted">{when(item.deletedAt, item.deletedBy)}</div>
                {item.paired && <div className="truncate text-xs text-fg-muted">{t("withPaired", { name: item.paired })}</div>}
                {purgesOn && <div className="text-xs text-fg-faint">{purgesOn}</div>}
              </div>
              <IconButton label={tc("restore")} disabled={busy} onClick={item.restore}>
                <RotateCcw className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton label={t("deletePermanently")} disabled={busy} onClick={item.purge} className="hover:text-danger">
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Header({ title, back, onBack }: { title: ReactNode; back: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1 px-1 pb-1">
      <button
        type="button"
        aria-label={back}
        onClick={onBack}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}
