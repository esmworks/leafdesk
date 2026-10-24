"use client";

import { useState } from "react";
import { ownPublicSubmissionsAction, submitPublicFormAction } from "@/app/actions/forms";
import { postFile } from "@/components/database/files-cell";
import { OwnAnswers } from "@/components/database/form-answers";
import { FormFill } from "@/components/database/form-fill";
import type { OwnSubmission, PublicForm } from "@/server/forms";

/**
 * A public form (`/f/<token>`), filled in by anyone with the link. `note` says whether answers are
 * anonymous or who is answering. `submissions` are the signed-in visitor's own earlier answers,
 * when the form shows them (null when it doesn't); they are fetched again after each answer.
 */
export function PublicFormFill({
  form,
  ticket,
  note,
  submissions: initial,
}: {
  form: PublicForm;
  ticket: string;
  note: string;
  submissions: OwnSubmission[] | null;
}) {
  const [submissions, setSubmissions] = useState(initial);
  return (
    <>
      <FormFill
        title={form.title}
        description={form.description}
        questions={form.questions}
        confirmation={form.confirmation}
        allowAnother={form.allowAnother}
        honeypot
        note={note}
        upload={(file) => postFile(`/api/files?formToken=${encodeURIComponent(form.token)}`, file, { "X-Form-Ticket": ticket })}
        onSubmit={async (answers, { honeypot }) => {
          const result = await submitPublicFormAction(form.token, { answers, ticket, honeypot });
          if (result.ok && submissions) {
            const next = await ownPublicSubmissionsAction(form.token).catch(() => null);
            if (next?.ok) setSubmissions(next.data);
          }
          return result.ok ? { ok: true } : result;
        }}
      />
      {submissions && <OwnAnswers questions={form.questions} submissions={submissions} />}
    </>
  );
}
