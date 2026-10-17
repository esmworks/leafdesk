"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import {
  createFromBuiltinAction,
  createFromTemplateAction,
  deleteTemplateAction,
  listTemplatesAction,
  type TemplatePickerData,
} from "@/app/actions/templates";
import { cn, Dialog, IconButton, PageIcon, pageLabel } from "@/components/ui";

/**
 * The template picker: the workspace's templates and the built-in gallery. Picking one creates a
 * new top-level page from it (in `teamspaceId`: a teamspace, or null for the private section) and opens it. Templates can be opened for editing and deleted here,
 * the only place besides their own page where they are listed.
 */
export function TemplatesDialog({
  workspaceId,
  open,
  onClose,
  teamspaceId,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Where new pages go: a teamspace, null for private, undefined for the workspace default. */
  teamspaceId?: string | null;
}) {
  const router = useRouter();
  const t = useTranslations("sidebar.templates");
  const tc = useTranslations("common");
  const [data, setData] = useState<TemplatePickerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = async () => {
    const result = await listTemplatesAction(workspaceId);
    if (result.ok) setData(result.data);
    else setError(result.error);
  };
  useEffect(() => {
    if (!open) return;
    setError(null);
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loads each time the dialog opens
  }, [open, workspaceId]);

  function create(run: () => ReturnType<typeof createFromTemplateAction>) {
    setError(null);
    startTransition(async () => {
      const result = await run();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.push(`/w/${result.data.workspaceId}/p/${result.data.id}`);
    });
  }

  function edit(id: string) {
    onClose();
    router.push(`/w/${workspaceId}/p/${id}`);
  }

  function remove(id: string) {
    if (!confirm(t("confirmDelete"))) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteTemplateAction(id);
      if (!result.ok) setError(result.error);
      await load();
    });
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <p className="mt-0.5 text-xs text-fg-muted">{t("description")}</p>
      </div>
      {error && (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className={cn("max-h-[60vh] overflow-y-auto p-1", pending && "pointer-events-none opacity-60")} aria-busy={pending}>
        <h3 className="px-3 pt-2 pb-1 text-xs font-medium text-fg-muted">{t("workspace")}</h3>
        {!data && <p className="px-3 py-2 text-sm text-fg-muted">{tc("loading")}</p>}
        {data?.templates.length === 0 && <p className="px-3 py-2 text-sm text-fg-muted">{t("empty")}</p>}
        <ul>
          {data?.templates.map((item) => (
            <li key={item.id} className="group flex items-center gap-2 rounded-md px-3 py-1.5 hover:bg-bg-hover">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-start text-sm"
                title={t("use")}
                onClick={() => create(() => createFromTemplateAction(item.id, null, teamspaceId))}
              >
                <PageIcon icon={item.icon} kind={item.kind} className="text-sm" />
                <span className="truncate">{pageLabel(item.title, tc("untitled"))}</span>
                {item.kind === "database" && <span className="shrink-0 text-xs text-fg-faint">{t("database")}</span>}
              </button>
              <IconButton label={item.canEdit ? t("edit") : t("open")} onClick={() => edit(item.id)}>
                <Pencil className="h-3.5 w-3.5" />
              </IconButton>
              {item.canDelete && (
                <IconButton label={t("delete")} onClick={() => remove(item.id)} className="hover:text-danger">
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>

        <h3 className="mt-2 border-t border-border px-3 pt-3 pb-1 text-xs font-medium text-fg-muted">{t("builtIn")}</h3>
        <ul>
          {data?.builtins.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className="flex w-full items-start gap-2 rounded-md px-3 py-1.5 text-start hover:bg-bg-hover"
                onClick={() => create(() => createFromBuiltinAction(workspaceId, item.key, null, teamspaceId))}
              >
                <PageIcon icon={item.icon} kind={item.kind} className="mt-0.5 text-sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.title}</span>
                  <span className="block text-xs text-fg-muted">{item.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
