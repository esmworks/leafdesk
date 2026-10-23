"use client";

import { FileText } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { SelectOption } from "@/db/schema/app";
import type { OwnSubmission } from "@/server/forms";
import type { FormFillQuestion, FormProperty } from "./form-fill";
import { CheckboxBox, OptionChip, useFormatDate, useFormatNumber } from "./property-cell";

/**
 * What the person sent through a form, newest first, when the form shows people their answers
 * (see server/forms ownSubmissions): each answer as the form's questions with what they said.
 * `renderValue` shows values the generic display can't (people and linked rows, in the app).
 */
export function OwnAnswers<P extends FormProperty>({
  questions,
  submissions,
  renderValue,
}: {
  questions: FormFillQuestion<P>[];
  submissions: OwnSubmission[];
  renderValue?: (question: FormFillQuestion<P>, value: unknown) => ReactNode;
}) {
  const t = useTranslations("form.own");
  const tf = useTranslations("form");
  const format = useFormatter();
  return (
    <section className="mt-12" aria-labelledby="own-answers-title">
      <h2 id="own-answers-title" className="text-base font-semibold">
        {t("title")}
      </h2>
      <p className="mt-0.5 text-xs text-fg-muted">{t("description")}</p>
      {!submissions.length && <p className="mt-3 text-sm text-fg-muted">{t("none")}</p>}
      <ul className="mt-3 flex flex-col gap-2">
        {submissions.map((submission, i) => {
          const answered = questions.filter((q) => Object.hasOwn(submission.values, q.propertyId));
          return (
            <li key={`${new Date(submission.createdAt).getTime()}-${i}`}>
              <details open={i === 0} className="group rounded-lg border border-border">
                <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-bg-hover">
                  <FileText className="h-4 w-4 shrink-0 text-fg-muted" />
                  {t("sentAt", { date: format.dateTime(new Date(submission.createdAt), { dateStyle: "medium", timeStyle: "short" }) })}
                </summary>
                <dl className="flex flex-col gap-3 border-t border-border px-3 py-3">
                  {answered.map((q) => (
                    <div key={q.propertyId} className="min-w-0">
                      <dt className="text-xs text-fg-muted">{q.label || q.prop?.name || tf("nameQuestion")}</dt>
                      <dd className="mt-0.5 text-sm break-words">
                        {(q.prop && renderValue?.(q, submission.values[q.propertyId])) ?? (
                          <AnswerValue prop={q.prop} value={submission.values[q.propertyId]} />
                        )}
                      </dd>
                    </div>
                  ))}
                  {!answered.length && <p className="text-sm text-fg-muted">{t("empty")}</p>}
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One answer as text, option chips, ticks or file names. */
function AnswerValue({ prop, value }: { prop: FormProperty | null; value: unknown }) {
  const formatDate = useFormatDate();
  const formatNumber = useFormatNumber();
  if (!prop) return <span className="whitespace-pre-wrap">{String(value)}</span>;
  switch (prop.type) {
    case "number":
      return <span>{typeof value === "number" ? formatNumber(value, prop.options.number) : String(value)}</span>;
    case "date":
      return <span>{typeof value === "string" ? formatDate(value) : null}</span>;
    case "checkbox":
      return <CheckboxBox checked={value === true} />;
    case "select":
    case "status":
    case "multi_select": {
      const ids = Array.isArray(value) ? value : [value];
      const options = ids.flatMap((id) => prop.options.options?.find((o: SelectOption) => o.id === id) ?? []);
      return (
        <span className="flex flex-wrap gap-1">
          {options.map((option) => (
            <OptionChip key={option.id} option={option} dot={prop.type === "status"} />
          ))}
        </span>
      );
    }
    case "checklist":
      return (
        <ul className="flex flex-col gap-0.5">
          {(Array.isArray(value) ? (value as { text: string; checked: boolean }[]) : []).map((item, i) => (
            <li key={i} className="flex items-center gap-2">
              <CheckboxBox checked={item.checked === true} />
              <span className="min-w-0">{item.text}</span>
            </li>
          ))}
        </ul>
      );
    case "files":
      return (
        <ul className="flex flex-col gap-0.5">
          {(Array.isArray(value) ? (value as { name?: string }[]) : []).map((f, i) => (
            <li key={i} className="truncate">
              {f.name}
            </li>
          ))}
        </ul>
      );
    case "text":
    case "url":
    case "email":
    case "phone":
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
    default:
      return null;
  }
}
