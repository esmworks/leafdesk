"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { deletePagePermanentlyAction, listTrashAction, restorePageAction } from "@/app/actions/pages";
import { Dialog, IconButton, PageIcon, pageLabel } from "@/components/ui";
import { MERGED_ORIGINAL_PARAM } from "@/lib/merge-rows";
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
  // What a refusal said (a legal hold keeps the page), in place of the generic error.
  const [refusal, setRefusal] = useState<string | null>(null);
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
    setRefusal(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result && typeof result === "object" && "ok" in result && result.ok === false && "error" in result) {
          setRefusal(String(result.error));
          return;
        }
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
      {(error || refusal) && (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
          {refusal ?? tc("genericError")}
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
                // A merged row itself, not the row it was merged into (where links to it lead).
                router.push(`/w/${workspaceId}/p/${item.id}${item.mergedInto ? `?${MERGED_ORIGINAL_PARAM}=1` : ""}`);
              }}
            >
              <PageIcon icon={item.icon} kind={item.kind} className="text-sm" />
              <span className="min-w-0 truncate">{pageLabel(item.title, tc("untitled"))}</span>
              {item.mergedInto?.title !== null && item.mergedInto?.title !== undefined && (
                <span className="min-w-0 shrink truncate text-xs text-fg-muted">
                  {t("mergedInto", { title: pageLabel(item.mergedInto.title, tc("untitled")) })}
                </span>
              )}
            </button>
            {item.deletesAt && (
              <span className="shrink-0 text-xs text-fg-muted" title={format.dateTime(item.deletesAt, { dateStyle: "medium" })}>
                {deletionLabel(item.deletesAt)}
              </span>
            )}
            {item.canRestore && (
              <IconButton
                label={tc("restore")}
                // Restoring a merged row doesn't take back what moved to the row it was merged into.
                {...(item.mergedInto ? { title: t("restoreMerged", { title: pageLabel(item.mergedInto.title ?? "", tc("untitled")) }) } : {})}
                onClick={() => restore(item.id)}
              >
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
