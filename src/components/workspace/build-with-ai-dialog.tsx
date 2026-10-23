"use client";

/**
 * "Build with AI": the person describes what they need, the AI drafts databases for it
 * (server/ai-build.ts), and the plan shows here to adjust (rename a database or property, remove
 * one, a view, the example rows or the intro page) before *Create* makes it, as them, where the
 * dialog was opened. Opened from the sidebar's "+" menus, the home page, Cmd+K and the editor's
 * slash menu (`inPage`: the databases go under the page, without an intro page).
 */
import { ArrowLeft, ArrowUpRight, Sparkles, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { createFromPlanAction, draftDatabasePlanAction } from "@/app/actions/ai-build";
import { PROPERTY_TYPE_META, usePropertyTypeLabel, ViewIcon } from "@/components/database/property-icons";
import { Button, cn, Dialog, IconButton, Input, PageIcon, textareaClass } from "@/components/ui";
import {
  MAX_BUILD_REQUEST,
  MAX_PLAN_NAME,
  MAX_PLAN_TITLE,
  renameDatabase,
  renameProperty,
  withoutDatabase,
  withoutProperty,
  withoutRows,
  withoutView,
  type DatabasePlan,
  type PlanDatabase,
  type PlanProperty,
} from "@/lib/database-plan";

export type BuildCreated = { rootId: string; databases: { id: string; title: string }[] };
export type BuildTarget = { parentId: string } | { teamspaceId?: string | null };

export function BuildWithAiDialog({
  workspaceId,
  target,
  inPage = false,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  target: BuildTarget;
  /** Opened in a page: no intro page, the databases go under it. */
  inPage?: boolean;
  onClose: () => void;
  onCreated: (created: BuildCreated) => void;
}) {
  const t = useTranslations("build");
  const tc = useTranslations("common");
  const [request, setRequest] = useState("");
  const [plan, setPlan] = useState<DatabasePlan | null>(null);
  const [rows, setRows] = useState(true);
  const [intro, setIntro] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const text = request.trim();

  const draft = () => {
    if (!text || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await draftDatabasePlanAction(workspaceId, text).catch(() => null);
      if (!result) return setError(tc("genericError"));
      if (!result.ok) return setError(result.error);
      setPlan(result.data);
      setRows(true);
      setIntro(true);
    });
  };

  const create = () => {
    if (!plan || pending) return;
    setError(null);
    let final = rows ? plan : withoutRows(plan);
    if (inPage || !intro) final = { ...final, intro: null };
    startTransition(async () => {
      const result = await createFromPlanAction(workspaceId, final, target).catch(() => null);
      if (!result) return setError(tc("genericError"));
      if (!result.ok) return setError(result.error);
      onCreated(result.data);
    });
  };

  const rowCount = plan?.databases.reduce((n, d) => n + d.rows.length, 0) ?? 0;

  return (
    <Dialog open onClose={pending ? () => {} : onClose} className="max-w-2xl">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        {plan && (
          <IconButton label={t("back")} onClick={() => setPlan(null)} disabled={pending} className="mt-1">
            <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
          </IconButton>
        )}
        <Sparkles className="mt-1 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{t(plan ? "reviewTitle" : "title")}</h2>
          <p className="text-sm text-fg-muted">{t(plan ? "reviewHint" : "hint")}</p>
        </div>
        <IconButton label={tc("close")} onClick={onClose} disabled={pending} className="h-7 w-7">
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      {plan ? (
        <>
          <div className={cn("max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4", pending && "opacity-70")}>
            {plan.databases.map((database) => (
              <DatabaseCard
                key={database.key}
                database={database}
                plan={plan}
                removable={plan.databases.length > 1}
                onChange={setPlan}
                disabled={pending}
              />
            ))}
            {(rowCount > 0 || (plan.intro && !inPage)) && (
              <div className="space-y-1.5">
                {plan.intro && !inPage && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={intro} onChange={(e) => setIntro(e.target.checked)} disabled={pending} />
                    {t("intro", { title: plan.intro.title })}
                  </label>
                )}
                {rowCount > 0 && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={rows} onChange={(e) => setRows(e.target.checked)} disabled={pending} />
                    {t("exampleRows", { count: rowCount })}
                  </label>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {error && (
              <p role="alert" className="me-auto text-xs text-danger">
                {error}
              </p>
            )}
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button variant="primary" onClick={create} disabled={pending}>
              {pending ? t("creating") : t("create")}
            </Button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            draft();
          }}
        >
          <div className={cn("space-y-2 px-5 py-4", pending && "opacity-70")}>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-fg-muted">{t("label")}</span>
              <textarea
                autoFocus
                rows={5}
                value={request}
                maxLength={MAX_BUILD_REQUEST}
                placeholder={t("placeholder")}
                readOnly={pending}
                onChange={(e) => setRequest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    draft();
                  }
                }}
                className={textareaClass}
              />
            </label>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {error && (
              <p role="alert" className="me-auto text-xs text-danger">
                {error}
              </p>
            )}
            <Button variant="ghost" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!text || pending}>
              {pending ? t("drafting") : t("draft")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** One database of the plan: its name, properties and views, each renamed or removed in place. */
function DatabaseCard({
  database,
  plan,
  removable,
  onChange,
  disabled,
}: {
  database: PlanDatabase;
  plan: DatabasePlan;
  removable: boolean;
  onChange: (plan: DatabasePlan) => void;
  disabled: boolean;
}) {
  const t = useTranslations("build");
  const tv = useTranslations("database.views");
  const typeLabel = usePropertyTypeLabel();
  const title = (key: string | undefined) => plan.databases.find((d) => d.key === key)?.title ?? "";
  return (
    <section className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <PageIcon icon={database.icon} kind="database" className="h-4 w-4 shrink-0" />
        <NameInput
          value={database.title}
          max={MAX_PLAN_TITLE}
          label={t("databaseTitle")}
          disabled={disabled}
          className="font-medium"
          onCommit={(next) => onChange(renameDatabase(plan, database.key, next))}
        />
        {removable && (
          <IconButton label={t("removeDatabase", { name: database.title })} onClick={() => onChange(withoutDatabase(plan, database.key))} disabled={disabled}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <div className="space-y-3 px-3 py-2">
        <div>
          <h3 className="mb-1 text-xs font-medium text-fg-muted">{t("properties")}</h3>
          {database.properties.length ? (
            <ul className="space-y-1">
              {database.properties.map((property) => (
                <PropertyLine
                  key={property.name}
                  property={property}
                  typeLabel={typeLabel(property.type)}
                  linked={property.type === "relation" ? title(property.database) : null}
                  disabled={disabled}
                  taken={(name) => database.properties.some((p) => p !== property && p.name.trim().toLowerCase() === name.trim().toLowerCase())}
                  onRename={(next) => onChange(renameProperty(plan, database.key, property.name, next))}
                  onRemove={() => onChange(withoutProperty(plan, database.key, property.name))}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-muted">{t("noProperties")}</p>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-xs font-medium text-fg-muted">{t("views")}</h3>
          <ul className="flex flex-wrap gap-1.5">
            {database.views.map((view, i) => {
              const name = view.name || tv(view.type);
              return (
                <li key={`${i}-${view.type}`} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs">
                  <ViewIcon type={view.type} className="h-3.5 w-3.5 text-fg-muted" />
                  <span className="max-w-48 truncate">{name}</span>
                  {database.views.length > 1 && (
                    <button
                      type="button"
                      aria-label={t("removeView", { name })}
                      disabled={disabled}
                      onClick={() => onChange(withoutView(plan, database.key, i))}
                      className="rounded text-fg-muted hover:text-fg"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function PropertyLine({
  property,
  typeLabel,
  linked,
  disabled,
  taken,
  onRename,
  onRemove,
}: {
  property: PlanProperty;
  typeLabel: string;
  linked: string | null;
  disabled: boolean;
  taken: (name: string) => boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("build");
  const Icon = PROPERTY_TYPE_META[property.type].icon;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Icon className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
      <NameInput
        value={property.name}
        max={MAX_PLAN_NAME}
        label={t("rename", { name: property.name })}
        disabled={disabled}
        invalid={taken}
        className="w-40 text-sm"
        onCommit={onRename}
      />
      <span className="text-xs text-fg-muted">{typeLabel}</span>
      {linked !== null && (
        <span className="inline-flex items-center gap-0.5 text-xs text-fg-muted">
          <ArrowUpRight className="h-3 w-3 rtl:-scale-x-100" aria-hidden />
          {property.two_way ? t("linksBoth", { database: linked }) : t("linksTo", { database: linked })}
        </span>
      )}
      {property.options?.length ? (
        <span className="flex min-w-0 flex-wrap gap-1">
          {property.options.map((o) => (
            <span key={o.name} className={`opt-${o.color} inline-flex max-w-40 items-center rounded px-1.5 text-xs leading-5`}>
              <span className="truncate">{o.name}</span>
            </span>
          ))}
        </span>
      ) : null}
      <IconButton label={t("removeProperty", { name: property.name })} onClick={onRemove} disabled={disabled} className="ms-auto h-6 w-6">
        <X className="h-3.5 w-3.5" />
      </IconButton>
    </li>
  );
}

/** A name edited in place: kept when the field is left, unless it is empty or `invalid` says it can't be. */
function NameInput({
  value,
  max,
  label,
  disabled,
  invalid,
  className,
  onCommit,
}: {
  value: string;
  max: number;
  label: string;
  disabled: boolean;
  invalid?: (name: string) => boolean;
  className?: string;
  onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // A rename elsewhere (undoing one, say) shows here.
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    const next = draft.trim();
    if (!next || next === value || invalid?.(next)) return setDraft(value);
    onCommit(next);
  };
  return (
    <Input
      aria-label={label}
      value={draft}
      maxLength={max}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
        }
      }}
      className={cn("h-7 min-w-0 flex-1 px-1.5", className)}
    />
  );
}
