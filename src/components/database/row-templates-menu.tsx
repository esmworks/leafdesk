"use client";

import { Check, ChevronDown, FileText, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { createRowTemplateAction, deleteTemplateAction, setDefaultRowTemplateAction } from "@/app/actions/templates";
import { cn, IconButton, MenuSeparator, PageIcon, pageLabel, Popover } from "@/components/ui";
import { TemplateRepeatDialog } from "./template-repeat-dialog";
import type { DatabaseSnapshot } from "./types";

/**
 * The arrow beside "New": add a row from one of the database's row templates or an empty one, pick
 * which of them "New" uses, and open, add or delete templates. Templates are edited on their own
 * page, like rows. A template can repeat: a row is added from it on a schedule (TemplateRepeatDialog).
 */
export function RowTemplatesMenu({
  workspaceId,
  snapshot,
  onCreate,
  onChanged,
  onError,
}: {
  workspaceId: string;
  snapshot: DatabaseSnapshot;
  /** Adds a row from the template, or an empty one for null. */
  onCreate: (templateId: string | null) => void;
  /** Refetches the database after a template change. */
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("database.page.templates");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [repeating, setRepeating] = useState<{ id: string; title: string } | null>(null);
  const databaseId = snapshot.database.id;
  const defaultId = snapshot.database.defaultTemplateId;

  function run<T>(action: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, then?: (data: T) => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) onError(result.error);
      else then?.(result.data);
      onChanged();
    });
  }

  const setDefault = (templateId: string | null) => run(() => setDefaultRowTemplateAction(databaseId, templateId));

  const remove = (templateId: string) => {
    if (!confirm(t("confirmDelete"))) return;
    run(() => deleteTemplateAction(templateId));
  };

  const edit = (templateId: string) => {
    setOpen(false);
    router.push(`/w/${workspaceId}/p/${templateId}`);
  };

  const create = (templateId: string | null) => {
    setOpen(false);
    onCreate(templateId);
  };

  const defaultToggle = (id: string | null) => {
    const active = id === defaultId;
    return (
      <IconButton
        label={active ? t("isDefault") : t("setDefault")}
        aria-pressed={active}
        disabled={active}
        onClick={() => setDefault(id)}
        className={cn(active ? "text-fg" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100")}
      >
        <Check className="h-3.5 w-3.5" />
      </IconButton>
    );
  };

  type Template = DatabaseSnapshot["templates"][number];
  const repeatToggle = (template: Template) => {
    const { repeat } = template;
    const label = !repeat
      ? t("repeat")
      : repeat.enabled && repeat.nextRunAt
        ? t("repeating", { date: format.dateTime(new Date(repeat.nextRunAt), { dateStyle: "medium", timeStyle: "short" }) })
        : t("repeatPaused");
    return (
      <IconButton
        label={label}
        onClick={() => {
          setOpen(false);
          setRepeating({ id: template.id, title: template.title });
        }}
        className={cn(
          !repeat && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
          repeat?.enabled && "text-fg",
          repeat && !repeat.enabled && "text-danger",
        )}
      >
        <Repeat className="h-3.5 w-3.5" />
      </IconButton>
    );
  };

  return (
    <>
      <Popover
        align="end"
        open={open}
        onOpenChange={setOpen}
        className="w-72"
        trigger={({ toggle }) => (
          <button
            type="button"
            aria-label={t("menu")}
            title={t("menu")}
            aria-expanded={open}
            onClick={toggle}
            className="inline-flex h-7 items-center justify-center rounded-r-md border-l border-accent-fg/25 bg-accent px-1.5 text-accent-fg hover:opacity-90"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      >
        <div className={cn(pending && "pointer-events-none opacity-60")} aria-busy={pending}>
          <div className="px-2 pt-1 pb-1 text-xs font-medium text-fg-muted">{t("heading")}</div>
          {snapshot.templates.length === 0 && <p className="px-2 py-1 text-sm text-fg-faint">{t("none")}</p>}
          <ul>
            {snapshot.templates.map((template) => (
              <li key={template.id} className="group flex items-center gap-1 rounded pr-1 hover:bg-bg-hover">
                <button
                  type="button"
                  onClick={() => create(template.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                >
                  <PageIcon icon={template.icon} className="text-sm" />
                  <span className="truncate">{pageLabel(template.title, tc("untitled"))}</span>
                </button>
                {repeatToggle(template)}
                {defaultToggle(template.id)}
                <IconButton label={t("edit")} onClick={() => edit(template.id)}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton label={t("delete")} onClick={() => remove(template.id)} className="hover:text-danger">
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </li>
            ))}
            <li className="group flex items-center gap-1 rounded pr-1 hover:bg-bg-hover">
              <button
                type="button"
                onClick={() => create(null)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
              >
                <FileText className="h-4 w-4 text-fg-muted" />
                <span className="truncate">{t("blank")}</span>
              </button>
              {defaultToggle(null)}
            </li>
          </ul>
          <MenuSeparator />
          <button
            type="button"
            onClick={() =>
              run(
                () => createRowTemplateAction(databaseId),
                (created) => {
                  setOpen(false);
                  router.push(`/w/${workspaceId}/p/${created.id}`);
                },
              )
            }
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
          >
            <Plus className="h-4 w-4 text-fg-muted" />
            {t("newTemplate")}
          </button>
        </div>
      </Popover>
      <TemplateRepeatDialog template={repeating} onClose={() => setRepeating(null)} onChanged={onChanged} />
    </>
  );
}
