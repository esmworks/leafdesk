import "katex/dist/katex.min.css";
import { getFormatter, getTranslations } from "next-intl/server";
import { PublishedBody, PublishedRowProperties } from "@/components/published/published-body";
import { PublishedDatabaseView } from "@/components/published/published-database";
import styles from "@/components/published/published-body.module.css";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { pageTextClasses } from "@/lib/page-style";
import { PRINT_MAX_PAGES } from "@/lib/print";
import type { PrintDocument, PrintSection } from "@/server/print";
import { PrintToolbar } from "./print-toolbar";

const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

// The printed page's margins. A fixed string of ours, nothing from the document.
const PAGE_CSS = "@page { margin: 16mm 15mm; }";

/**
 * A page (and with subpages, the pages under it) laid out for the browser's "Save as PDF": the
 * published page's rendering (components/published), always in the light theme, with rules for
 * where pages break (see published-body.module.css). Links to other pages print as their titles.
 */
export async function PrintView({
  doc,
  pageId,
  subpages,
  auto,
}: {
  doc: PrintDocument;
  pageId: string;
  subpages: boolean;
  auto: boolean;
}) {
  const [t, format] = await Promise.all([getTranslations("page.print"), getFormatter()]);
  const root = doc.sections[0];
  return (
    <div data-print-view="" className={cn("min-h-full bg-bg text-fg", styles.printView)}>
      <style>{PAGE_CSS}</style>
      <PrintToolbar
        workspaceId={doc.workspaceId}
        pageId={pageId}
        subpages={subpages}
        canIncludeSubpages={root.kind !== "database"}
        auto={auto}
      />
      <main className="mx-auto w-full max-w-[900px] px-4 pt-10 pb-24 sm:px-[54px] print:max-w-none print:p-0">
        {doc.sections.map((section, i) => (
          <Section
            key={section.id}
            section={section}
            first={i === 0}
            // Without subpages, the page's own subpages are listed by title at its end.
            listChildren={!subpages}
            updated={t("lastUpdated", { date: format.dateTime(section.updatedAt, { dateStyle: "medium", timeStyle: "short" }) })}
          />
        ))}
        {doc.truncated && (
          <p className="mt-10 border-t border-border pt-3 text-sm text-fg-muted">{t("truncated", { count: PRINT_MAX_PAGES })}</p>
        )}
      </main>
    </div>
  );
}

async function Section({
  section,
  first,
  listChildren,
  updated,
}: {
  section: PrintSection;
  first: boolean;
  listChildren: boolean;
  updated: string;
}) {
  const [t, tc] = await Promise.all([getTranslations("page.print"), getTranslations("common")]);
  const untitled = tc("untitled");
  const above = section.crumbs.slice(0, -1);
  return (
    <article className={cn(!first && styles.newPage, pageTextClasses(section.style))} data-print-section={section.id}>
      <header className={styles.keep}>
        {!first && above.length > 0 && (
          <p className="mb-2 flex flex-wrap items-center gap-1 text-xs text-fg-faint">
            {above.map((c, i) => (
              <span key={c.id} className="flex items-center gap-1">
                {i > 0 && <span>/</span>}
                <span>{pageLabel(c.title, untitled)}</span>
              </span>
            ))}
          </p>
        )}
        {section.icon && <div className="mb-3 text-5xl leading-none">{section.icon}</div>}
        <h1 className="text-4xl leading-tight font-bold break-words">{pageLabel(section.title, untitled)}</h1>
        <p className="mt-2 text-xs text-fg-faint">{updated}</p>
      </header>

      {section.row && section.row.properties.length > 0 && <PublishedRowProperties row={section.row} print />}

      {section.body.length > 0 && (
        <PublishedBody blocks={section.body} crumbs={section.crumbs} links={null} unavailable={t("embedUnavailable")} print />
      )}

      {section.database && <PublishedDatabaseView table={section.database} links={null} print className="mt-6" />}

      {listChildren && section.children.length > 0 && (
        <section className={cn("mt-10", styles.keep)}>
          <h2 className="mb-2 text-sm font-medium text-fg-muted">{t("subpages")}</h2>
          <ul className="flex flex-col">
            {section.children.map((child) => (
              <li key={child.id} className="flex items-center gap-2 py-1">
                <PageIcon icon={child.icon} kind={child.kind} className="text-base" />
                <span className="break-words">{pageLabel(child.title, untitled)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
