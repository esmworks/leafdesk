"use client";

import { CircleCheck, Plus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";
import { Button, cn } from "@/components/ui";
import type { NumberFormat, SelectOption } from "@/db/schema/app";
import { checkAnswers, MAX_TEXT_ANSWER, MAX_TITLE_ANSWER, type AnswerError, type ResolvedQuestion } from "@/lib/forms";
import { isDatabaseErrorCode, sortStatusOptions } from "@/lib/properties";
import { FilesEditor, type UploadFile } from "./files-cell";
import { CheckboxBox, INPUT_MODE, OptionChip, parseInput } from "./property-cell";
import type { PropertyType } from "./types";

/** What a question needs to know about its property: enough for a public page, too. */
export type FormProperty = { id: string; name: string; type: PropertyType; options: { options?: SelectOption[]; number?: NumberFormat } };
export type FormFillQuestion<P extends FormProperty = FormProperty> = ResolvedQuestion<P>;
export type FormSubmitResult = { ok: true } | { ok: false; error: string; fields?: Record<string, string> };

const FIELD_CODES = ["required", "tooLong", "tooMany", "invalidText"];

const inputClass =
  "w-full rounded-md border border-border bg-bg px-2.5 text-sm outline-none placeholder:text-fg-faint focus:border-accent disabled:opacity-60";

/**
 * A form to fill in: the questions with an input each, checked in the browser the way the server
 * checks them, then sent through `onSubmit`. Used in the app and on public form pages.
 */
export function FormFill<P extends FormProperty>({
  title,
  description,
  questions,
  onSubmit,
  confirmation,
  allowAnother,
  disabled,
  note,
  honeypot,
  renderPicker,
  upload,
}: {
  title: string;
  description?: string;
  questions: FormFillQuestion<P>[];
  onSubmit: (answers: Record<string, unknown>, extra: { honeypot: string }) => Promise<FormSubmitResult>;
  confirmation?: string;
  allowAnother?: boolean;
  /** Shown but can't be sent (viewers, a database in the trash, the builder's preview for viewers). */
  disabled?: boolean;
  /** Shown above the submit button, e.g. why the form can't be sent. */
  note?: ReactNode;
  /** Adds the hidden field bots fill in (public forms). */
  honeypot?: boolean;
  /** Inputs for relation and person questions, which only the app offers. */
  renderPicker?: (question: FormFillQuestion<P>, value: unknown, onChange: (value: unknown) => void) => ReactNode;
  /** Stores a file picked for a files question (see server/forms); without it they can't be answered. */
  upload?: UploadFile;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [trap, setTrap] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const formId = useId();

  const message = (e: AnswerError) => {
    if (FIELD_CODES.includes(e.code)) return t(`form.errors.${e.code as "required"}`, e.params);
    if (isDatabaseErrorCode(e.code)) return t(`database.errors.${e.code}`, e.params);
    return t("common.genericError");
  };

  const set = (id: string, value: unknown) => {
    setValues((v) => ({ ...v, [id]: value }));
    setErrors((e) => {
      if (!(id in e)) return e;
      const next = { ...e };
      delete next[id];
      return next;
    });
  };

  /** Typed text as values the server stores; text it can't read goes as typed, to be refused with a reason. */
  const answers = () => {
    const out: Record<string, unknown> = {};
    for (const q of questions) {
      const raw = values[q.propertyId];
      if (raw === undefined) continue;
      const type = q.prop?.type;
      if (typeof raw === "string" && (type === "number" || type === "url" || type === "email" || type === "phone")) {
        // A percent question takes percent points, as a percent cell does.
        const parsed = parseInput({ type, options: q.prop?.options }, raw, locale);
        out[q.propertyId] = parsed === undefined ? raw : parsed;
      } else out[q.propertyId] = raw;
    }
    return out;
  };

  const submit = async () => {
    if (disabled || busy) return;
    setFormError(null);
    const input = answers();
    const checked = checkAnswers(questions, input);
    if (!checked.ok) {
      setErrors(Object.fromEntries(checked.errors.map((e) => [e.propertyId, message(e)])));
      setFormError(t("form.errors.invalidAnswers"));
      document.getElementById(`${formId}-${checked.errors[0].propertyId}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await onSubmit(input, { honeypot: trap });
      if (result.ok) {
        setDone(true);
        setValues({});
        setErrors({});
      } else {
        setErrors(result.fields ?? {});
        setFormError(result.error);
      }
    } catch {
      setFormError(t("common.genericError"));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-lg border border-border bg-bg-subtle px-6 py-10 text-center" role="status">
        <CircleCheck className="mx-auto h-8 w-8 text-accent" strokeWidth={1.5} />
        <p className="mt-3 text-base font-medium whitespace-pre-wrap">{confirmation?.trim() || t("form.fill.thanks")}</p>
        {allowAnother !== false && (
          <Button className="mt-5" onClick={() => setDone(false)}>
            {t("form.fill.another")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className="text-3xl font-bold leading-tight break-words">{title}</h1>
      {description && <p className="mt-2 text-sm whitespace-pre-wrap text-fg-muted">{description}</p>}

      <div className="mt-8 flex flex-col gap-7">
        {questions.map((q) => {
          const inputId = `${formId}-${q.propertyId}`;
          const error = errors[q.propertyId];
          const label = q.label || q.prop?.name || t("form.nameQuestion");
          const describedBy = [q.description && `${inputId}-help`, error && `${inputId}-error`].filter(Boolean).join(" ") || undefined;
          const field = {
            id: inputId,
            question: q,
            value: values[q.propertyId],
            onChange: (v: unknown) => set(q.propertyId, v),
            disabled: disabled || busy,
            invalid: Boolean(error),
            describedBy,
            renderPicker,
            upload,
          };
          const inline = q.prop?.type === "checkbox";
          return (
            <div key={q.propertyId}>
              {inline ? (
                <div className="flex items-start gap-2.5">
                  <AnswerInput {...field} label={label} />
                  <label htmlFor={inputId} className="text-sm font-medium break-words">
                    {label}
                    <RequiredMark required={q.required} />
                  </label>
                </div>
              ) : (
                <label htmlFor={inputId} className="block text-sm font-medium break-words">
                  {label}
                  <RequiredMark required={q.required} />
                </label>
              )}
              {q.description && (
                <p id={`${inputId}-help`} className={cn("mt-0.5 text-xs whitespace-pre-wrap text-fg-muted", inline && "pl-[26px]")}>
                  {q.description}
                </p>
              )}
              {!inline && (
                <div className="mt-2">
                  <AnswerInput {...field} label={label} />
                </div>
              )}
              {error && (
                <p id={`${inputId}-error`} className="mt-1.5 text-xs text-danger">
                  {error}
                </p>
              )}
            </div>
          );
        })}
        {!questions.length && <p className="text-sm text-fg-muted">{t("form.fill.noQuestions")}</p>}
      </div>

      {honeypot && (
        // People never see or reach this field; bots that fill in every input do. Its name says
        // nothing browsers autofill, and password managers are told to leave it alone.
        <div aria-hidden className="pointer-events-none absolute -left-[10000px] h-px w-px overflow-hidden">
          <label>
            {t("form.fill.honeypot")}
            <input
              type="text"
              name="leave_empty"
              tabIndex={-1}
              autoComplete="off"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              data-form-type="other"
              value={trap}
              onChange={(e) => setTrap(e.target.value)}
            />
          </label>
        </div>
      )}

      {note && <p className="mt-8 text-sm text-fg-muted">{note}</p>}
      {formError && (
        <p role="alert" className="mt-8 text-sm text-danger">
          {formError}
        </p>
      )}
      <div className={cn(note || formError ? "mt-3" : "mt-8")}>
        <Button type="submit" variant="primary" disabled={disabled || busy || !questions.length}>
          {busy ? t("form.fill.submitting") : t("form.fill.submit")}
        </Button>
      </div>
    </form>
  );
}

function RequiredMark({ required }: { required: boolean }) {
  const t = useTranslations("form");
  if (!required) return null;
  return (
    <>
      <span aria-hidden className="ml-0.5 text-danger">
        *
      </span>
      <span className="sr-only"> ({t("requiredMark")})</span>
    </>
  );
}

type FieldProps<P extends FormProperty> = {
  id: string;
  label: string;
  question: FormFillQuestion<P>;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
  renderPicker?: (question: FormFillQuestion<P>, value: unknown, onChange: (value: unknown) => void) => ReactNode;
  upload?: UploadFile;
};

function AnswerInput<P extends FormProperty>({
  id,
  label,
  question,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
  renderPicker,
  upload,
}: FieldProps<P>) {
  const prop = question.prop;
  const a11y = { id, "aria-invalid": invalid || undefined, "aria-describedby": describedBy, "aria-required": question.required || undefined };
  const border = invalid ? "border-danger" : "";
  const text = typeof value === "string" ? value : "";

  if (!prop) {
    return (
      <input
        {...a11y}
        type="text"
        value={text}
        maxLength={MAX_TITLE_ANSWER}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputClass, "h-9", border)}
      />
    );
  }
  switch (prop.type) {
    case "text":
      return (
        <textarea
          {...a11y}
          value={text}
          rows={3}
          maxLength={MAX_TEXT_ANSWER}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, "min-h-20 resize-y py-2 [field-sizing:content]", border)}
        />
      );
    case "number":
    case "url":
    case "email":
    case "phone":
      return (
        <input
          {...a11y}
          type={prop.type === "email" ? "email" : prop.type === "url" ? "url" : prop.type === "phone" ? "tel" : "text"}
          inputMode={INPUT_MODE[prop.type]}
          autoComplete={prop.type === "email" ? "email" : prop.type === "phone" ? "tel" : "off"}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, "h-9", border)}
        />
      );
    case "date":
      return (
        <input
          {...a11y}
          type="date"
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, "h-9 w-auto min-w-44", border)}
        />
      );
    case "checkbox":
      return (
        <button
          {...a11y}
          type="button"
          role="checkbox"
          aria-checked={value === true}
          aria-label={label}
          disabled={disabled}
          onClick={() => onChange(value !== true)}
          className="mt-0.5 inline-flex rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60"
        >
          <CheckboxBox checked={value === true} />
        </button>
      );
    case "select":
    case "status":
    case "multi_select":
      return <OptionChoices {...a11y} prop={prop} value={value} onChange={onChange} disabled={disabled} label={label} />;
    case "checklist":
      return <ChecklistAnswer id={id} value={value} onChange={onChange} disabled={disabled} invalid={invalid} />;
    case "files":
      return (
        <div className={cn("rounded-md border border-border", border)}>
          <FilesEditor
            name={label}
            value={value}
            onChange={onChange}
            upload={upload}
            answer={{ id, disabled: disabled || !upload, invalid, describedBy }}
          />
        </div>
      );
    default:
      return renderPicker ? (
        <div id={id} className={cn("rounded-md border border-border", border)}>
          {renderPicker(question, value, onChange)}
        </div>
      ) : null;
  }
}

/** Options as a list to pick from: one for selects and statuses, any number for multi-selects. */
function OptionChoices({
  id,
  prop,
  value,
  onChange,
  disabled,
  label,
  ...a11y
}: {
  id: string;
  prop: FormProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  label: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-required"?: boolean;
}) {
  const multi = prop.type === "multi_select";
  const options = prop.type === "status" ? sortStatusOptions(prop.options.options ?? []) : (prop.options.options ?? []);
  const picked = Array.isArray(value) ? (value as string[]) : typeof value === "string" ? [value] : [];
  const toggle = (optionId: string) => {
    if (multi) onChange(picked.includes(optionId) ? picked.filter((x) => x !== optionId) : [...picked, optionId]);
    else onChange(picked.includes(optionId) ? null : optionId);
  };
  return (
    <div id={id} role={multi ? "group" : "radiogroup"} aria-label={label} {...a11y} className="flex flex-col items-start gap-0.5">
      {options.map((option) => {
        const on = picked.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            disabled={disabled}
            onClick={() => toggle(option.id)}
            className="-mx-1.5 flex max-w-full items-center gap-2 rounded-md px-1.5 py-1 hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-60"
          >
            {multi ? (
              <CheckboxBox checked={on} />
            ) : (
              <span
                aria-hidden
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                  on ? "border-accent" : "border-fg-faint",
                )}
              >
                {on && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
            )}
            <OptionChip option={option} dot={prop.type === "status"} />
          </button>
        );
      })}
    </div>
  );
}

/** A list of items the person types, one per line; they arrive unticked. */
function ChecklistAnswer({
  id,
  value,
  onChange,
  disabled,
  invalid,
}: {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const t = useTranslations("form.fill");
  const items = Array.isArray(value) ? (value as string[]) : [];
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...items, text]);
    setDraft("");
  };
  return (
    <div className={cn("rounded-md border border-border", invalid && "border-danger")}>
      {items.length > 0 && (
        <ul className="flex flex-col gap-0.5 p-1">
          {items.map((item, i) => (
            <li key={i} className="group flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-bg-hover">
              <CheckboxBox checked={false} />
              <span className="min-w-0 flex-1 text-sm break-words">{item}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={t("removeItem", { text: item })}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted hover:text-danger"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={cn("flex items-center gap-2 px-2.5 py-1.5", items.length > 0 && "border-t border-border")}>
        <Plus className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <input
          id={id}
          value={draft}
          disabled={disabled}
          placeholder={t("addItem")}
          aria-label={t("newItem")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
    </div>
  );
}
