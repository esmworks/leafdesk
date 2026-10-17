"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { deletePagePermanentlyAction, listTrashAction, restorePageAction } from "@/app/actions/pages";
import { Dialog, IconButton, PageIcon, pageLabel } from "@/components/ui";
import { daysUntil } from "@/lib/retention";

type TrashItem = Awaited<ReturnType<typeof listTrashAction>>[number];

export function TrashDialog({
  workspaceId,
  open,
  onClose,
  onChange,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onChange: () => void;
}) {
  const router = useRouter();
  const t = useTranslations("sidebar.trash");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  // When the list was loaded: days left count from there rather than from each render.
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  const [error, setError] = useState(false);
  const [, startTransition] = useTransition();

  const load = () =>
    listTrashAction(workspaceId).then(
      (list) => {
        setItems(list);
        setLoadedAt(new Date());
      },
      () => setError(true),
    );
  useEffect(() => {
    if (!open) return;
    setError(false);
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loads each time the dialog opens
  }, [open, workspaceId]);

  /** Runs a trash change; on failure (e.g. someone else just changed the page) shows an error and reloads. */
  function run(action: () => Promise<unknown>) {
    setError(false);
    startTransition(async () => {
      try {
        await action();
        onChange();
      } catch {
        setError(true);
      }
      await load();
    });
  }

  /** "Deleted in N days"; once due, the page waits for the next daily cleanup. */
  function deletionLabel(deletesAt: Date) {
    const days = daysUntil(deletesAt, loadedAt);
    return days > 0 ? t("deletesIn", { count: days }) : t("deletesSoon");
  }

  function restore(id: string) {
    run(() => restorePageAction(id));
  }

  function remove(id: string) {
    if (!confirm(t("confirmDelete"))) return;
    run(() => deletePagePermanentlyAction(id));
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <div className="border-b border-border px-4 py-3 text-sm font-medium">{t("title")}</div>
      {error && (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
          {tc("genericError")}
        </p>
      )}
      <ul className="max-h-[50vh] overflow-y-auto p-1">
        {items?.length === 0 && <li className="px-3 py-6 text-center text-sm text-fg-muted">{t("empty")}</li>}
        {items?.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 rounded-md px-3 py-1.5 hover:bg-bg-hover">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-start text-sm"
              onClick={() => {
                onClose();
                router.push(`/w/${workspaceId}/p/${item.id}`);
              }}
            >
              <PageIcon icon={item.icon} kind={item.kind} className="text-sm" />
              <span className="truncate">{pageLabel(item.title, tc("untitled"))}</span>
            </button>
            {item.deletesAt && (
              <span className="shrink-0 text-xs text-fg-muted" title={format.dateTime(item.deletesAt, { dateStyle: "medium" })}>
                {deletionLabel(item.deletesAt)}
              </span>
            )}
            {item.canRestore && (
              <IconButton label={tc("restore")} onClick={() => restore(item.id)}>
                <RotateCcw className="h-3.5 w-3.5" />
              </IconButton>
            )}
            {item.canDelete && (
              <IconButton label={t("deletePermanently")} onClick={() => remove(item.id)} className="hover:text-danger">
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
