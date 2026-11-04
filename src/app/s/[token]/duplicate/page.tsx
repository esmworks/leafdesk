import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DuplicateForm } from "@/components/published/duplicate-form";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { publishedHref } from "@/lib/site";
import { duplicateTargets } from "@/server/published-duplicate";
import { getSession } from "@/server/session";
import { loadPublished } from "../load";

type Params = { params: Promise<{ token: string }>; searchParams: Promise<{ page?: string | string[] }> };

// Who is signed in and where they may add pages changes per visit.
export const dynamic = "force-dynamic";

const pageParam = (value: string | string[] | undefined) => (typeof value === "string" && value.length <= 64 ? value : undefined);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("publish.duplicate");
  return { title: t("metaTitle") };
}

/**
 * "Duplicate" on a published page (`?page=` the page, the published page without it): pick one of
 * your workspaces to copy it to. Visitors who aren't signed in sign in first and come back here.
 */
export default async function DuplicatePublishedRoute({ params, searchParams }: Params) {
  const [{ token: key }, query] = await Promise.all([params, searchParams]);
  const pageId = pageParam(query.page);
  const session = await getSession();
  if (!session) {
    const back = `/s/${key}/duplicate${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`;
    redirect(`/sign-in?next=${encodeURIComponent(back)}`);
  }
  const { data } = await loadPublished(key, pageId);
  const [t, tc, targets] = await Promise.all([
    getTranslations("publish.duplicate"),
    getTranslations("common"),
    data.allowDuplicate ? duplicateTargets(session.user.id) : Promise.resolve([]),
  ]);
  const title = pageLabel(data.title, tc("untitled"));
  const back = publishedHref(data.links, data.id, data.title);

  return (
    <div className="flex min-h-full flex-col bg-bg text-fg">
      <header className="flex h-11 items-center justify-between gap-3 border-b border-border px-3">
        <Link href={back} className="min-w-0 truncate text-sm text-fg-muted hover:text-fg">
          ← {t("back")}
        </Link>
        <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight text-fg-faint hover:text-fg-muted">
          leafdesk
        </Link>
      </header>
      <main className="mx-auto w-full max-w-lg flex-1 px-4 pt-10 pb-24 sm:pt-16">
        <div className="flex items-center gap-2 text-fg-muted">
          <PageIcon icon={data.icon} kind={data.kind} className="text-2xl" />
        </div>
        <h1 className="mt-2 font-display text-2xl leading-tight tracking-tight break-words">{t("title", { title })}</h1>
        <p className="mt-2 text-sm text-fg-muted">{t("description")}</p>
        <div className="mt-6 rounded-xl border border-border bg-bg-subtle/60 p-5">
          {!data.allowDuplicate ? (
            <p className="text-sm text-fg-muted">{t("notAllowed")}</p>
          ) : targets.length === 0 ? (
            <p className="text-sm text-fg-muted">{t("noWorkspaces")}</p>
          ) : (
            <DuplicateForm pageKey={key} pageId={data.id} targets={targets} />
          )}
        </div>
      </main>
    </div>
  );
}
