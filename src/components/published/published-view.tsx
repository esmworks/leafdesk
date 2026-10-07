import "katex/dist/katex.min.css";
import { Copy, Menu } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { LoadedPage } from "@/app/s/[token]/load";
import { CoverArt } from "@/components/page/cover-art";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { pageTextClasses } from "@/lib/page-style";
import { publishedHref } from "@/lib/site";
import { PublishedBody, PublishedRowProperties } from "./published-body";
import { PublishedDatabaseView } from "./published-database";
import { SiteNav } from "./site-nav";

// `cn` from components/ui is a client export; server components join classes themselves.
const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

/**
 * Read-only public view of a published page (`/s/<token>/…`), or of a page of a workspace's site
 * (`/s/<slug>/…`), which adds the site's title and navigation. Rendered on the server for visitors
 * without a session: no editor, no client data fetching.
 */
export async function PublishedView({ loaded }: { loaded: LoadedPage }) {
  const { data, site, key } = loaded;
  const [t, tc, format] = await Promise.all([getTranslations("publish"), getTranslations("common"), getFormatter()]);
  const untitled = tc("untitled");
  const titles = new Map<string, string>([...data.crumbs, ...data.children].map((p) => [p.id, p.title]));
  const href = (id: string, title?: string) => publishedHref(data.links, id, title ?? titles.get(id) ?? "");
  const wide = data.kind === "database";
  const title = pageLabel(data.title, untitled);
  const duplicateHref = data.allowDuplicate
    ? `/s/${key}/duplicate?page=${encodeURIComponent(data.id)}`
    : null;
  const current = new Set(data.crumbs.map((c) => c.id));

  const crumbs = (
    <nav aria-label={t("breadcrumbs")} className={cn("flex min-w-0 items-center gap-1 text-sm text-fg-muted", site && "max-sm:hidden")}>
      {data.crumbs.map((c, i) => {
        const last = i === data.crumbs.length - 1;
        return (
          <span key={c.id} className="flex min-w-0 items-center gap-1">
            {last ? (
              <span aria-current="page" className="flex min-w-0 items-center gap-1 px-1 text-fg">
                <PageIcon icon={c.icon} kind={c.kind} className="text-sm" />
                <span className="max-w-60 truncate">{pageLabel(c.title, untitled)}</span>
              </span>
            ) : (
              <>
                <Link href={href(c.id, c.title)} className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-bg-hover hover:text-fg">
                  <PageIcon icon={c.icon} kind={c.kind} className="text-sm" />
                  <span className="max-w-40 truncate">{pageLabel(c.title, untitled)}</span>
                </Link>
                <span className="text-fg-faint">/</span>
              </>
            )}
          </span>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-full flex-col bg-bg text-fg">
      <header className="sticky top-0 z-20 flex h-11 items-center justify-between gap-3 border-b border-border bg-bg/90 px-3 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          {site && (
            <>
              <Link href={site.links.base} className="max-w-48 shrink-0 truncate text-sm font-semibold hover:underline">
                {site.title || pageLabel(site.nav[0]?.title ?? "", untitled)}
              </Link>
              {data.crumbs.length > 0 && <span className="text-fg-faint max-sm:hidden">·</span>}
            </>
          )}
          {crumbs}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {duplicateHref && (
            <Link
              href={duplicateHref}
              prefetch={false}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg px-2 text-xs font-medium hover:bg-bg-hover"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {t("duplicate.button")}
            </Link>
          )}
          <Link href="/" className="text-sm font-semibold tracking-tight text-fg-faint hover:text-fg-muted">
            leafdesk
          </Link>
        </div>
      </header>

      {site && site.nav.length > 0 && (
        <details className="group border-b border-border md:hidden">
          <summary className="flex h-10 cursor-pointer list-none items-center gap-2 px-3 text-sm text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            <Menu className="h-4 w-4" aria-hidden />
            {t("site.menu")}
          </summary>
          <div className="max-h-[60dvh] overflow-y-auto px-2 pb-3">
            <SiteNav nodes={site.nav} currentId={data.id} open={current} untitled={untitled} label={t("site.navigation")} />
          </div>
        </details>
      )}

      <div className="flex flex-1">
        {site && site.nav.length > 0 && (
          <aside className="sticky top-11 hidden h-[calc(100dvh-2.75rem)] w-64 shrink-0 overflow-y-auto border-r border-border bg-bg-subtle p-2 md:block">
            <SiteNav nodes={site.nav} currentId={data.id} open={current} untitled={untitled} label={t("site.navigation")} />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {data.cover && <CoverArt cover={data.cover} className="h-[30vh] max-h-72 min-h-32 max-md:h-40 max-md:min-h-0" />}
          <main
            className={cn(
              "w-full min-w-0 flex-1 pb-32",
              wide ? "pt-10" : data.style.fullWidth ? "page-full-width pt-12" : "mx-auto max-w-[900px] pt-12",
              !wide && pageTextClasses(data.style),
            )}
          >
            <div className={wide ? "page-gutter" : "px-4 sm:px-[54px]"}>
              <div className={cn(wide ? "flex items-center gap-3" : "")}>
                {data.icon && <div className={cn("leading-none", wide ? "text-4xl" : "mb-3 text-5xl")}>{data.icon}</div>}
                <h1 className={cn("font-bold leading-tight break-words", wide ? "text-3xl" : "text-4xl")}>{title}</h1>
              </div>
              <p className="mt-2 text-xs text-fg-faint">
                {t("lastUpdated", { date: format.dateTime(data.updatedAt, { dateStyle: "medium", timeStyle: "short" }) })}
              </p>
            </div>

            {data.row && data.row.properties.length > 0 && <PublishedRowProperties row={data.row} />}

            {data.body.length > 0 && (
              <PublishedBody blocks={data.body} crumbs={data.crumbs} links={data.links} unavailable={t("embedUnavailable")} />
            )}

            {data.database && (
              <PublishedDatabaseView table={data.database} links={data.links} viewPath={href(data.id, data.title)} className="page-gutter mt-6" />
            )}

            {data.children.length > 0 && (
              <section className="mt-10 px-4 sm:px-[54px]">
                <h2 className="mb-2 text-sm font-medium text-fg-muted">{t("subpages")}</h2>
                <ul className="flex flex-col">
                  {data.children.map((child) => (
                    <li key={child.id}>
                      <Link href={href(child.id, child.title)} className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover">
                        <PageIcon icon={child.icon} kind={child.kind} className="text-base" />
                        <span className="truncate underline decoration-border underline-offset-4">{pageLabel(child.title, untitled)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
