"use client";

import { Check, ChevronDown, FileText, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useState, useTransition } from "react";
import { createRowTemplateAction, deleteTemplateAction, setDefaultRowTemplateAction } from "@/app/actions/templates";
import { cn, IconButton, MenuSeparator, PageIcon, pageLabel, Popover } from "@/components/ui";
import { TemplateRepeatDialog } from "./template-repeat-dialog";
import type { DatabaseSnapshot, View } from "./types";

/**
 * The arrow beside "New": add a row from one of the database's row templates or an empty one, pick
 * which of them "New" uses (in the open view alone, or in all views), and open, add or delete
 * templates. Templates are edited on their own page, like rows. A template can repeat: a row is
 * added from it on a schedule (TemplateRepeatDialog).
 */
export function RowTemplatesMenu({
  workspaceId,
  snapshot,
  view,
  onViewDefault,
  onCreate,
  onChanged,
  onError,
}: {
  workspaceId: string;
  snapshot: DatabaseSnapshot;
  /** The open view, when its settings may change: "New" there may use its own default (ViewConfig defaultTemplateId). */
  view?: View | null;
  /** Saves the view's own default: a template id, null for empty rows, undefined to follow the database's. */
  onViewDefault?: (view: View, templateId: string | null | undefined) => void;
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
  // The template (or "" for empty rows) whose "Use for New" asks: in this view, or in all of them.
  const [choosing, setChoosing] = useState<string | null>(null);
  const databaseId = snapshot.database.id;
  // The view's own choice counts while it names one of the templates (a deleted one falls back).
  const own = view?.config.defaultTemplateId;
  const viewOwn = own === null || (typeof own === "string" && snapshot.templates.some((t) => t.id === own));
  const defaultId = viewOwn ? (own ?? null) : snapshot.database.defaultTemplateId;

  function run<T>(action: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, then?: (data: T) => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) onError(result.error);
      else then?.(result.data);
      onChanged();
    });
  }

  const setDefault = (templateId: string | null) => {
    setChoosing(null);
    run(() => setDefaultRowTemplateAction(databaseId, templateId, true));
  };
  const setViewDefault = (templateId: string | null | undefined) => {
    setChoosing(null);
    if (view && onViewDefault) onViewDefault(view, templateId);
  };

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

  const choosable = !!view && !!onViewDefault;
  const defaultToggle = (id: string | null) => {
    const active = id === defaultId;
    const key = id ?? "";
    return (
      <IconButton
        label={active ? t(viewOwn ? "isViewDefault" : "isDefault") : t("setDefault")}
        aria-pressed={active}
        aria-expanded={choosable && !active ? choosing === key : undefined}
        disabled={active}
        // With a view open, the choice is where: in this view, or in all of them (see DefaultChoice).
        onClick={() => (choosable ? setChoosing(choosing === key ? null : key) : setDefault(id))}
        className={cn(
          active || choosing === key ? "text-fg" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <Check className="h-3.5 w-3.5" />
      </IconButton>
    );
  };
  /** Under a template whose check was pressed: use it for "New" in this view, or in all views. */
  const defaultChoice = (id: string | null) =>
    choosable && choosing === (id ?? "") ? (
      <li className="flex gap-1 px-2 pb-1.5">
        <DefaultChoice onClick={() => setViewDefault(id)}>{t("forThisView")}</DefaultChoice>
        <DefaultChoice onClick={() => setDefault(id)}>{t("forAllViews")}</DefaultChoice>
      </li>
    ) : null;

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
            className="inline-flex h-7 items-center justify-center rounded-e-md border-s border-accent-fg/25 bg-accent px-1.5 text-accent-fg hover:opacity-90"
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
              <Fragment key={template.id}>
                <li className="group flex items-center gap-1 rounded pe-1 hover:bg-bg-hover">
                  <button
                    type="button"
                    onClick={() => create(template.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start text-sm"
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
                {defaultChoice(template.id)}
              </Fragment>
            ))}
            <li className="group flex items-center gap-1 rounded pe-1 hover:bg-bg-hover">
              <button
                type="button"
                onClick={() => create(null)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start text-sm"
              >
                <FileText className="h-4 w-4 text-fg-muted" />
                <span className="truncate">{t("blank")}</span>
              </button>
              {defaultToggle(null)}
            </li>
            {defaultChoice(null)}
          </ul>
          {viewOwn && choosable && (
            // This view keeps its own choice until it follows the one for all views again.
            <button
              type="button"
              onClick={() => setViewDefault(undefined)}
              className="w-full rounded px-2 py-1 text-start text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              {t("followAllViews")}
            </button>
          )}
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
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover"
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

/** One of the two places a default template is for: this view, or all views. */
function DefaultChoice({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-md border border-border px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
    >
      {children}
    </button>
  );
}
