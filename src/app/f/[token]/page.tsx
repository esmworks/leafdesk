import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { cache } from "react";
import { PublicFormFill } from "@/components/published/public-form";
import { SourceFooter } from "@/components/published/source-footer";
import { getPublicForm, issueFormTicket, listOwnPublicSubmissions } from "@/server/forms";
import { getSession } from "@/server/session";

type Params = { params: Promise<{ token: string }> };

// Every visit gets a fresh ticket (see issueFormTicket) and the form's current questions.
export const dynamic = "force-dynamic";

const loadForm = cache(async (token: string) => {
  const form = await getPublicForm(token);
  if (!form) notFound();
  return form;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  const [form, tc] = await Promise.all([loadForm(token), getTranslations("common")]);
  return { title: form.title || tc("untitled") };
}

export default async function PublicFormRoute({ params }: Params) {
  const { token } = await params;
  const form = await loadForm(token);
  const [t, tc] = await Promise.all([getTranslations("form.public"), getTranslations("common")]);
  // Anonymous forms never look at who is signed in: nobody is recorded there.
  const session = form.anonymous ? null : await getSession();
  // Someone signed in sees what they sent before, when the form shows people their answers.
  const submissions = session && form.showOwnAnswers ? await listOwnPublicSubmissions(token, session.user.id) : null;

  return (
    <div className="flex min-h-full flex-col bg-bg text-fg">
      <header className="flex h-11 items-center justify-end border-b border-border px-3">
        <Link href="/" className="text-sm font-semibold tracking-tight text-fg-faint hover:text-fg-muted">
          leafdesk
        </Link>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-10 pb-16 sm:pt-14">
        {!form.anonymous && !session ? (
          <div>
            <h1 className="text-3xl font-bold leading-tight break-words">{form.title || tc("untitled")}</h1>
            <div className="mt-8 rounded-lg border border-border bg-bg-subtle p-5">
              <p className="text-base font-medium">{t("signInTitle")}</p>
              <p className="mt-1 text-sm text-fg-muted">{t("signInBody")}</p>
              <Link
                href={`/sign-in?next=${encodeURIComponent(`/f/${token}`)}`}
                className="mt-4 inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90"
              >
                {t("signIn")}
              </Link>
            </div>
          </div>
        ) : (
          <PublicFormFill
            form={{ ...form, title: form.title || tc("untitled") }}
            ticket={issueFormTicket(token)}
            note={form.anonymous ? t("anonymous") : t("signedInAs", { name: session!.user.name || session!.user.email })}
            submissions={submissions}
          />
        )}
      </main>
      <SourceFooter />
    </div>
  );
}
