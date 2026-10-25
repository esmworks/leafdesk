import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { submitPageReportAction } from "@/app/actions/page-reports";
import { Button, Input, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { MAX_REPORT_DETAILS, MAX_REPORT_EMAIL, REPORT_REASONS } from "@/lib/page-reports";
import { publishedHref } from "@/lib/site";
import { loadPublished } from "../load";

type Query = { page?: string | string[]; sent?: string | string[]; error?: string | string[] };
type Params = { params: Promise<{ token: string }>; searchParams: Promise<Query> };

export const dynamic = "force-dynamic";

const pageParam = (value: string | string[] | undefined) => (typeof value === "string" && value.length <= 64 ? value : undefined);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("publish.report");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/**
 * "Report page" at the foot of a published page (`?page=` the page, the published page without
 * it): tells the workspace's owners what is wrong with it (server/page-reports.ts). A plain form
 * that works without scripts: it posts to submitPageReportAction, which comes back here with
 * `sent=1` or `error=`. Served at the app's address; a site's domain sends it here (lib/site.ts
 * routeOnSiteHost). No account needed. Plain links rather than next/link: this route then loads no
 * script of its own.
 */
export default async function ReportPublishedRoute({ params, searchParams }: Params) {
  const [{ token: key }, query] = await Promise.all([params, searchParams]);
  const { data } = await loadPublished(key, pageParam(query.page));
  const [t, tc] = await Promise.all([getTranslations("publish.report"), getTranslations("common")]);
  const title = pageLabel(data.title, tc("untitled"));
  const back = publishedHref(data.links, data.id, data.title);
  const error = query.error === "invalid" || query.error === "rateLimited" ? t(`errors.${query.error}`) : query.error ? tc("genericError") : null;

  return (
    <div className="flex min-h-full flex-col bg-bg text-fg">
      <header className="flex h-11 items-center justify-between gap-3 border-b border-border px-3">
        <a href={back} className="min-w-0 truncate text-sm text-fg-muted hover:text-fg">
          ← {t("back")}
        </a>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- no script on this route (see above) */}
        <a href="/" className="shrink-0 text-sm font-semibold tracking-tight text-fg-faint hover:text-fg-muted">
          leafdesk
        </a>
      </header>
      <main className="mx-auto w-full max-w-lg flex-1 px-4 pt-10 pb-24 sm:pt-16">
        <div className="flex items-center gap-2 text-fg-muted">
          <PageIcon icon={data.icon} kind={data.kind} className="text-2xl" />
        </div>
        <h1 className="mt-2 text-2xl font-bold leading-tight break-words">{t("title", { title })}</h1>
        <p className="mt-2 text-sm text-fg-muted">{t("description")}</p>
        <div className="mt-6 rounded-xl border border-border bg-bg-subtle/60 p-5">
          {query.sent ? (
            <p role="status" className="text-sm">
              {t("sent")}
            </p>
          ) : (
            <form action={submitPageReportAction} className="relative flex flex-col gap-4">
              <input type="hidden" name="key" value={key} />
              <input type="hidden" name="page" value={data.id} />
              <fieldset className="flex flex-col gap-2 text-sm">
                <legend className="mb-1.5 font-medium">{t("reason")}</legend>
                {REPORT_REASONS.map((reason) => (
                  <label key={reason} className="flex cursor-pointer items-center gap-2">
                    <input type="radio" name="reason" value={reason} required className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
                    {t(`reasons.${reason}`)}
                  </label>
                ))}
              </fieldset>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{t("details")}</span>
                <textarea
                  name="details"
                  rows={4}
                  maxLength={MAX_REPORT_DETAILS}
                  className="w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{t("email")}</span>
                <Input type="email" name="email" maxLength={MAX_REPORT_EMAIL} autoComplete="email" />
                <span className="text-xs text-fg-muted">{t("emailHint")}</span>
              </label>
              {/* Left empty by people; bots that fill every field give themselves away. */}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] h-0 w-0 opacity-0" />
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
              <div>
                <Button type="submit" variant="primary">
                  {t("send")}
                </Button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
