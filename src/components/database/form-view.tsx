"use client";

import { propertyDescription } from "@/lib/property-description";
import { ArrowDown, ArrowUp, Check, ExternalLink, Globe, Link2, Plus, Share2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
  getFormSharingAction,
  publishFormAction,
  submitFormAction,
  unpublishFormAction,
  type FormActionResult,
} from "@/app/actions/forms";
import { useLocalMode } from "@/components/local-mode";
import { Button, cn, MenuItem, Switch } from "@/components/ui";
import type { FormConfig, FormQuestion } from "@/db/schema/app";
import {
  FORM_TITLE,
  formQuestions,
  canDefault,
  isAskable,
  isPublicAskable,
  MAX_CONFIRMATION,
  MAX_FORM_DESCRIPTION,
  MAX_FORM_TITLE,
  MAX_QUESTION_DESCRIPTION,
  MAX_QUESTION_LABEL,
} from "@/lib/forms";
import type { FormSharing } from "@/server/forms";
import { Floating, useFloating } from "./floating";
import { postFile } from "./files-cell";
import { FormFill } from "./form-fill";
import { PropertyCell } from "./property-cell";
import { usePropertyAccess } from "./property-access";
import { PropertyTypeIcon, usePropertyTypeLabel } from "./property-icons";
import type { Property, View } from "./types";
import type { DatabaseApi } from "./use-database";

/**
 * Form views: people with edit access build the form here (questions, texts, values every answer
 * gets) and can switch to a preview that really submits. Everyone else sees the form to fill in,
 * disabled for viewers, since answering adds a row.
 */
export function FormView({
  view,
  properties,
  databaseTitle,
  api,
  editable,
  archived,
  preview,
}: {
  view: View;
  properties: Property[];
  databaseTitle: string;
  api: DatabaseApi;
  /** Edit access and the database isn't in the trash: build the form and fill it in. */
  editable: boolean;
  archived: boolean;
  /** Editors: show the form as people fill it in. */
  preview: boolean;
}) {
  const t = useTranslations("form");
  const tc = useTranslations("common");
  const form = view.config.form ?? {};
  const access = usePropertyAccess();

  if (editable && !preview) {
    return (
      <FormBuilder
        form={form}
        properties={properties}
        databaseTitle={databaseTitle}
        api={api}
        onChange={(next) => void api.updateView(view, { config: { ...view.config, form: next } })}
      />
    );
  }

  return (
    <div className="page-gutter pb-16">
      <div className="mx-auto max-w-2xl pt-6">
        <FormFill
          key={view.id}
          title={form.title?.trim() || databaseTitle || tc("untitled")}
          description={form.description?.trim()}
          // Answers are written as the person answering: questions about values they may not
          // change (property access) aren't asked, since the server would leave them out.
          questions={formQuestions(form, properties).filter((q) => !q.prop || access.canEditValues(q.prop.id))}
          confirmation={form.confirmation}
          allowAnother={form.allowAnother}
          disabled={!editable}
          note={archived ? t("fill.archived") : !editable ? t("fill.viewOnly") : undefined}
          onSubmit={async (answers) => {
            const result = await submitFormAction(view.id, answers);
            if (result.ok) void api.refetch();
            return result.ok ? { ok: true } : result;
          }}
          upload={(file) => postFile(`/api/files?form=${encodeURIComponent(view.id)}`, file)}
          renderPicker={(question, value, onChange) =>
            question.prop && (
              <PropertyCell
                variant="panel"
                wrap
                prop={question.prop}
                value={value}
                onChange={onChange}
                onCreateOption={async () => null}
              />
            )
          }
        />
      </div>
    </div>
  );
}

/** Edit and Preview switch plus the Share button, in the view's toolbar. */
export function FormToolbar({
  view,
  properties,
  workspaceId,
  databaseId,
  editable,
  preview,
  onPreview,
}: {
  view: View;
  properties: Property[];
  workspaceId: string;
  databaseId: string;
  editable: boolean;
  preview: boolean;
  onPreview: (preview: boolean) => void;
}) {
  const t = useTranslations("form");
  const share = useFloating<HTMLButtonElement>();
  return (
    <div className="flex shrink-0 items-center gap-1">
      {editable && (
        <div role="radiogroup" aria-label={t("builder.mode")} className="flex items-center rounded-md border border-border p-0.5">
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              role="radio"
              aria-checked={preview === on}
              onClick={() => onPreview(on)}
              className={cn(
                "h-6 rounded px-2 text-xs font-medium",
                preview === on ? "bg-bg-active text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {on ? t("builder.preview") : t("builder.edit")}
            </button>
          ))}
        </div>
      )}
      <Button ref={share.ref} size="sm" variant="ghost" onClick={share.toggle} aria-expanded={share.open}>
        <Share2 className="h-3.5 w-3.5" />
        {t("share.button")}
      </Button>
      <Floating open={share.open} anchor={share.el} onClose={share.close} align="end" className="w-[22rem] max-w-[calc(100vw-16px)] p-0">
        <FormSharePanel view={view} properties={properties} workspaceId={workspaceId} databaseId={databaseId} />
      </Floating>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations("form.share");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-sm hover:bg-bg-hover"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-accent" /> : <Link2 className="h-3.5 w-3.5" />}
      {copied ? t("copied") : label}
    </button>
  );
}

/** Who can fill in the form: people in the workspace, and anyone with the public link when it is on. */
function FormSharePanel({
  view,
  properties,
  workspaceId,
  databaseId,
}: {
  view: View;
  properties: Property[];
  workspaceId: string;
  databaseId: string;
}) {
  const t = useTranslations("form.share");
  const localMode = useLocalMode();
  const [sharing, setSharing] = useState<FormSharing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const result = await getFormSharingAction(view.id).catch(() => null);
    if (result?.ok) setSharing(result.data);
    else setError(result?.error ?? t("failed"));
  };
  useEffect(() => {
    void load();
    // Loaded once per opening; changes made here update the state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  const change = async (action: () => Promise<FormActionResult<unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.error);
    } catch {
      setError(t("failed"));
    } finally {
      await load();
      setBusy(false);
    }
  };

  const absolute = (path: string) => new URL(path, window.location.origin).toString();
  const internal = absolute(`/w/${workspaceId}/p/${databaseId}?view=${view.id}`);
  const publication = sharing?.publication ?? null;
  const blocker = sharing?.blocker ?? null;
  // Turning the link off needs only full access; opening it (or making it anonymous) also the policy.
  // With publishing off, an open link takes no answers.
  const hint = publication ? (blocker === "needsFullAccess" || blocker === "publishingOff" ? blocker : null) : blocker;
  const hidden = formQuestions(view.config.form, properties).filter((q) => q.prop && !isPublicAskable(q.prop.type)).length;

  return (
    <div className="divide-y divide-border">
      <div className="p-3">
        <p className="text-sm font-medium">{t("internalTitle")}</p>
        <p className="mt-0.5 text-xs text-fg-muted">{t("internalDescription")}</p>
        <div className="mt-2 flex justify-end">
          <CopyButton text={internal} label={t("copyLink")} />
        </div>
      </div>
      {/* Leafdesk on one computer has no public address: the form has no public link there. */}
      {!localMode && (
        <div className="p-3">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                publication ? "bg-accent/15 text-accent" : "bg-bg-hover text-fg-muted",
              )}
            >
              <Globe className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("publicTitle")}</p>
              <p className="mt-0.5 text-xs text-fg-muted">{t("publicDescription")}</p>
            </div>
          </div>

          {sharing === null && !error && <p className="mt-3 text-sm text-fg-muted">…</p>}

          {publication && (
            <>
              <div className="mt-3 flex items-center gap-1 rounded-md border border-border bg-bg-subtle p-1 ps-2">
                <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{absolute(publication.url)}</span>
                <CopyButton text={absolute(publication.url)} label={t("copyLink")} />
                <a
                  href={publication.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("open")}
                  title={t("open")}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">{t("anonymous")}</p>
                  <p className="mt-0.5 text-xs text-fg-muted">{t("anonymousDescription")}</p>
                </div>
                <Switch
                  label={t("anonymous")}
                  checked={publication.anonymous}
                  disabled={busy || blocker !== null}
                  onChange={(anonymous) => void change(() => publishFormAction(view.id, anonymous))}
                />
              </div>
              {hidden > 0 && <p className="mt-3 text-xs text-fg-muted">{t("hiddenQuestions", { count: hidden })}</p>}
              {!publication.live && (
                <div className="mt-3 rounded-md border border-border p-2">
                  <p className="text-xs text-danger">{t("stale")}</p>
                  <Button
                    size="sm"
                    className="mt-2"
                    disabled={busy || blocker !== null}
                    onClick={() => void change(() => publishFormAction(view.id, publication.anonymous))}
                  >
                    {t("reactivate")}
                  </Button>
                </div>
              )}
            </>
          )}

          {error ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              {error}
            </p>
          ) : (
            hint && <p className="mt-2 text-xs text-fg-muted">{t(hint)}</p>
          )}

          {sharing && (
            <div className="mt-3">
              {publication ? (
                <Button
                  size="sm"
                  className="w-full justify-center"
                  disabled={busy || blocker === "needsFullAccess"}
                  onClick={() => {
                    if (confirm(t("confirmDisable"))) void change(() => unpublishFormAction(view.id));
                  }}
                >
                  {t("disable")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  className="w-full justify-center"
                  disabled={busy || blocker !== null}
                  onClick={() => void change(() => publishFormAction(view.id, false))}
                >
                  {t("enable")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A text field saved when it loses focus, so refetches never overwrite what is being typed. */
function DraftText({
  value,
  onCommit,
  multiline,
  placeholder,
  maxLength,
  className,
  label,
}: {
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  maxLength: number;
  className?: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const props = {
    value: draft,
    placeholder,
    maxLength,
    "aria-label": label,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      if (draft !== value) onCommit(draft);
    },
    className: cn(
      "w-full min-w-0 rounded-md bg-transparent outline-none placeholder:text-fg-faint hover:bg-bg-hover focus:bg-bg-hover",
      className,
    ),
  };
  return multiline ? (
    <textarea {...props} rows={1} onChange={(e) => setDraft(e.target.value)} className={cn(props.className, "resize-none [field-sizing:content]")} />
  ) : (
    <input
      {...props}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

function FormBuilder({
  form,
  properties,
  databaseTitle,
  api,
  onChange,
}: {
  form: FormConfig;
  properties: Property[];
  databaseTitle: string;
  api: DatabaseApi;
  onChange: (form: FormConfig) => void;
}) {
  const t = useTranslations("form.builder");
  const tf = useTranslations("form");
  const tc = useTranslations("common");
  const typeLabel = usePropertyTypeLabel();
  const addQuestion = useFloating<HTMLButtonElement>();
  const addDefault = useFloating<HTMLButtonElement>();

  const questions = formQuestions(form, properties);
  // Saved questions include ones about deleted properties; edits keep only the ones shown.
  const stored: FormQuestion[] = questions.map((q) => (form.questions ?? []).find((s) => s.propertyId === q.propertyId)!);
  const asked = new Set(questions.map((q) => q.propertyId));
  const setQuestions = (next: FormQuestion[]) => onChange({ ...form, questions: next });
  const patchQuestion = (i: number, patch: Partial<FormQuestion>) =>
    setQuestions(stored.map((q, j) => (j === i ? clean({ ...q, ...patch }) : q)));
  const move = (i: number, by: number) => {
    const next = [...stored];
    const [q] = next.splice(i, 1);
    next.splice(i + by, 0, q);
    setQuestions(next);
  };

  const unasked = [
    ...(asked.has(FORM_TITLE) ? [] : [null]),
    ...properties.filter((p) => isAskable(p.type) && !asked.has(p.id)),
  ];
  const ask = (prop: Property | null) => {
    addQuestion.close();
    const propertyId = prop?.id ?? FORM_TITLE;
    // An answer replaces a default value, so asking for a property drops its default.
    const defaults = { ...form.defaults };
    delete defaults[propertyId];
    onChange({ ...form, questions: [...stored, { propertyId }], defaults });
  };

  const defaults = form.defaults ?? {};
  // Properties just added to the list: shown empty until a value is picked (empty values aren't saved).
  const [adding, setAdding] = useState<string[]>([]);
  const listed = (p: Property) => (p.id in defaults || adding.includes(p.id)) && canDefault(p.type) && !asked.has(p.id);
  const defaulted = properties.filter(listed);
  const defaultable = properties.filter((p) => canDefault(p.type) && !asked.has(p.id) && !listed(p));
  const setDefault = (id: string, value: unknown) => {
    const next = { ...defaults };
    if (value === null || value === undefined || (Array.isArray(value) && !value.length)) delete next[id];
    else next[id] = value;
    onChange({ ...form, defaults: next });
  };
  const removeDefault = (id: string) => {
    setAdding((list) => list.filter((x) => x !== id));
    setDefault(id, null);
  };

  return (
    <div className="page-gutter pb-16">
      <div className="mx-auto max-w-2xl pt-4">
        <DraftText
          value={form.title ?? ""}
          onCommit={(title) => onChange({ ...form, title: title.trim() || undefined })}
          placeholder={databaseTitle || t("titlePlaceholder")}
          maxLength={MAX_FORM_TITLE}
          label={t("titlePlaceholder")}
          className="-mx-1.5 px-1.5 py-1 text-3xl font-bold"
        />
        <DraftText
          multiline
          value={form.description ?? ""}
          onCommit={(description) => onChange({ ...form, description: description.trim() || undefined })}
          placeholder={t("descriptionPlaceholder")}
          maxLength={MAX_FORM_DESCRIPTION}
          label={t("descriptionPlaceholder")}
          className="-mx-1.5 mt-1 px-1.5 py-1 text-sm text-fg-muted"
        />

        <ol className="mt-6 flex flex-col gap-3">
          {questions.map((q, i) => {
            const name = q.prop?.name || tf("nameQuestion");
            return (
              <li key={q.propertyId} className="rounded-lg border border-border bg-bg p-3">
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 text-fg-muted">
                    <PropertyTypeIcon type={q.prop?.type ?? "title"} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <DraftText
                      value={q.label}
                      onCommit={(label) => patchQuestion(i, { label })}
                      placeholder={name}
                      maxLength={MAX_QUESTION_LABEL}
                      label={t("labelPlaceholder")}
                      className="-mx-1 px-1 py-0.5 text-sm font-medium"
                    />
                    <DraftText
                      multiline
                      value={q.description}
                      onCommit={(description) => patchQuestion(i, { description })}
                      // Left empty, the question shows its property's description.
                      placeholder={(q.prop && propertyDescription(q.prop)) || t("helpPlaceholder")}
                      maxLength={MAX_QUESTION_DESCRIPTION}
                      label={t("helpPlaceholder")}
                      className="-mx-1 px-1 py-0.5 text-xs text-fg-muted"
                    />
                  </div>
                  <div className="flex shrink-0 items-center">
                    <IconAction label={t("moveUp")} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </IconAction>
                    <IconAction label={t("moveDown")} disabled={i === questions.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </IconAction>
                    <IconAction label={t("remove")} onClick={() => setQuestions(stored.filter((_, j) => j !== i))}>
                      <X className="h-3.5 w-3.5" />
                    </IconAction>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 ps-6 text-xs text-fg-muted">
                  <span className="min-w-0">
                    {q.prop ? t("savedTo", { property: `${q.prop.name} (${typeLabel(q.prop.type)})` }) : t("savedToName")}
                    {q.prop && !isPublicAskable(q.prop.type) && <> · {t("notPublic")}</>}
                  </span>
                  <label className="flex items-center gap-2">
                    {t("required")}
                    <Switch label={t("required")} checked={q.required} onChange={(required) => patchQuestion(i, { required })} />
                  </label>
                </div>
              </li>
            );
          })}
        </ol>
        {!questions.length && <p className="mt-6 text-sm text-fg-muted">{t("empty")}</p>}

        <Button ref={addQuestion.ref} size="sm" variant="ghost" className="mt-3" onClick={addQuestion.toggle}>
          <Plus className="h-3.5 w-3.5" />
          {t("addQuestion")}
        </Button>
        <Floating open={addQuestion.open} anchor={addQuestion.el} onClose={addQuestion.close} className="max-h-80 overflow-y-auto">
          {unasked.map((prop) => (
            <MenuItem key={prop?.id ?? FORM_TITLE} icon={<PropertyTypeIcon type={prop?.type ?? "title"} />} onClick={() => ask(prop)}>
              {prop ? prop.name || tc("untitled") : tf("nameQuestion")}
            </MenuItem>
          ))}
          {!unasked.length && <p className="px-2 py-1.5 text-sm text-fg-muted">{t("noMoreQuestions")}</p>}
        </Floating>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">{t("defaultsTitle")}</h2>
          <p className="mt-0.5 text-xs text-fg-muted">{t("defaultsDescription")}</p>
          <div className="mt-2 flex flex-col gap-0.5">
            {defaulted.map((prop) => (
              <div key={prop.id} className="flex min-h-[30px] items-start gap-2">
                <div className="flex h-[30px] w-40 shrink-0 items-center gap-1.5 px-1 text-sm text-fg-muted">
                  <PropertyTypeIcon type={prop.type} className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate" title={prop.name}>
                    {prop.name}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <PropertyCell
                    variant="panel"
                    wrap
                    prop={prop}
                    value={defaults[prop.id]}
                    onChange={(value) => setDefault(prop.id, value)}
                    onCreateOption={api.createOption}
                  />
                </div>
                <IconAction label={t("removeDefault")} onClick={() => removeDefault(prop.id)}>
                  <X className="h-3.5 w-3.5" />
                </IconAction>
              </div>
            ))}
          </div>
          <Button ref={addDefault.ref} size="sm" variant="ghost" className="mt-1" onClick={addDefault.toggle}>
            <Plus className="h-3.5 w-3.5" />
            {t("addDefault")}
          </Button>
          <Floating open={addDefault.open} anchor={addDefault.el} onClose={addDefault.close} className="max-h-80 overflow-y-auto">
            {defaultable.map((prop) => (
              <MenuItem
                key={prop.id}
                icon={<PropertyTypeIcon type={prop.type} />}
                onClick={() => {
                  addDefault.close();
                  // Checkboxes have no empty state to pick from, so they start ticked.
                  if (prop.type === "checkbox") setDefault(prop.id, true);
                  else setAdding((list) => [...list, prop.id]);
                }}
              >
                {prop.name || tc("untitled")}
              </MenuItem>
            ))}
            {!defaultable.length && <p className="px-2 py-1.5 text-sm text-fg-muted">{t("noMoreDefaults")}</p>}
          </Floating>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold">{t("afterTitle")}</h2>
          <DraftText
            multiline
            value={form.confirmation ?? ""}
            onCommit={(confirmation) => onChange({ ...form, confirmation: confirmation.trim() || undefined })}
            placeholder={t("confirmationPlaceholder")}
            maxLength={MAX_CONFIRMATION}
            label={t("confirmationLabel")}
            className="mt-2 border border-border px-2.5 py-2 text-sm hover:bg-transparent focus:border-accent focus:bg-transparent"
          />
          <label className="mt-3 flex items-center justify-between gap-3 text-sm">
            {t("allowAnother")}
            <Switch
              label={t("allowAnother")}
              checked={form.allowAnother !== false}
              onChange={(on) => onChange({ ...form, allowAnother: on ? undefined : false })}
            />
          </label>
        </section>
      </div>
    </div>
  );
}

/** Drops empty texts and a false `required`, so saved questions stay minimal. */
function clean(q: FormQuestion): FormQuestion {
  return {
    propertyId: q.propertyId,
    ...(q.required ? { required: true } : {}),
    ...(q.label?.trim() ? { label: q.label.trim() } : {}),
    ...(q.description?.trim() ? { description: q.description.trim() } : {}),
  };
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
