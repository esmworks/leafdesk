import { Bot, FileSpreadsheet, FileText } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PropertyDisplay } from "@/components/database/property-cell";
import { FileViewerArea } from "@/components/file-viewer";
import { PropertyTypeIcon } from "@/components/database/property-icons";
import { PublishedMermaid } from "@/components/page/mermaid-diagram";
import { HeadingList, SubpageList, Trail } from "@/components/page/page-outline";
import { PdfViewer } from "@/components/page/pdf-viewer";
import { SpreadsheetViewer } from "@/components/page/spreadsheet-viewer";
import { BookmarkCard, EmbedFrame } from "@/components/page/web-card";
import { PageIcon } from "@/components/ui";
import { DASHBOARD_CLASS, DASHBOARD_GRID_CLASS, WIDGET_SPAN_CLASS, widgetBoxClass } from "@/lib/dashboard";
import { noteParts } from "@/lib/footnotes";
import { pageLabel } from "@/lib/labels";
import { holdsNothing, rowPageSections } from "@/lib/page-visibility";
import { publishedHref, type PublishedLinks } from "@/lib/site";
import { displayHost } from "@/lib/web-blocks";
import type { PublishedBlock, PublishedChild, PublishedCrumb, PublishedEmbed, PublishedPage, PublishedWidget } from "@/server/publication";
import { PublishedDatabaseView } from "./published-database";
import { PublishedTabs } from "./published-tabs";
import styles from "./published-body.module.css";

// `cn` from components/ui is a client export; server components join classes themselves.
const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

const GUTTER = "px-4 sm:px-[54px]";

/** Whether the body has a subpages block, in columns too: the page then lists its subpages there, not again at its end. */
export const showsSubpages = (blocks: PublishedBlock[]): boolean =>
  blocks.some((b) => b.kind === "subpages" || (b.kind === "columns" && b.columns.some((c) => showsSubpages(c.segments))));

/**
 * A database row's properties above its body: those a row page shows before "more properties" is
 * opened (see lib/page-visibility).
 */
export function PublishedRowProperties({ row, print = false }: { row: NonNullable<PublishedPage["row"]>; print?: boolean }) {
  const { shown } = rowPageSections(row.properties, (prop) => holdsNothing(row.values[prop.id]));
  if (!shown.length) return null;
  return (
    <dl className={cn("mt-6 grid grid-cols-[minmax(7rem,12rem)_1fr] gap-x-4 gap-y-1 text-sm", !print && GUTTER)}>
      {shown.map((prop) => (
        <div key={prop.id} className="contents">
          <dt className="flex h-8 items-center gap-1.5 text-fg-muted">
            <PropertyTypeIcon type={prop.type} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{prop.name}</span>
          </dt>
          <dd className="flex min-h-8 min-w-0 items-center py-1">
            <PropertyDisplay prop={prop} value={row.values[prop.id]} style={row.styles?.[prop.id]} wrap />
          </dd>
        </div>
      ))}
    </dl>
  );
}


/**
 * A page body as published pages draw it (see server/published-body.ts), shared by the published
 * view and the print view. `links` is where the publication (or its site) serves pages; without
 * it (print) pages and rows are named, not linked, and blocks that only work on screen (a PDF
 * viewer, an embedded site) print as a card naming what they hold. Columns sit side by side and
 * stack below 640px, on paper too (a printed page is wider than that).
 */
export async function PublishedBody({
  blocks,
  crumbs,
  subpages,
  links,
  unavailable,
  print = false,
}: {
  blocks: PublishedBlock[];
  crumbs: PublishedCrumb[];
  /** The page's subpages the reader may see, for subpages blocks. */
  subpages: PublishedChild[];
  links: PublishedLinks | null;
  /** What a database block the reader can't see says. */
  unavailable: string;
  print?: boolean;
}) {
  const [tc, tb, tw, tp, ts, td, ta, tt] = await Promise.all([
    getTranslations("common"),
    getTranslations("page.blocks"),
    getTranslations("page.web"),
    getTranslations("page.pdf"),
    getTranslations("page.spreadsheet"),
    getTranslations("page.dashboard"),
    getTranslations("page.agentChat"),
    getTranslations("page.databaseTabs"),
  ]);
  const untitled = tc("untitled");
  const titles = new Map(crumbs.map((c) => [c.id, c.title]));
  const href = links ? (id: string, title?: string) => publishedHref(links, id, title ?? titles.get(id) ?? "") : null;
  // A database shown from outside the page has no published address, nor do its rows: no links to them.
  const linksOf = (database: PublishedEmbed) => (database.outside ? null : links);

  /**
   * A part of the body. At the top level each part has the page's side padding (in print the
   * printed page's margins are the padding); inside a column the columns' row has it instead.
   */
  const segment = (block: PublishedBlock, i: number, inColumn: boolean): React.ReactNode => {
    const pad = inColumn || print ? "" : GUTTER;
    switch (block.kind) {
      case "html":
        return (
          <div
            key={i}
            className={cn(styles.body, print && styles.print, pad)}
            // Serialized by BlockNote from our own document with unsafe URLs removed; see published-body.ts.
            dangerouslySetInnerHTML={{ __html: block.html }}
          />
        );
      case "columns":
        return (
          <div key={i} className={cn("my-2", pad)}>
            <div className={styles.columns}>
              {block.columns.map((column, c) => (
                <div key={c} className={styles.column} style={{ flexGrow: column.width }}>
                  {column.segments.map((inner, j) => segment(inner, j, true))}
                </div>
              ))}
            </div>
          </div>
        );
      case "dashboard": {
        const title = (widget: PublishedWidget, database: PublishedEmbed) => widget.title || pageLabel(database.title, untitled);
        const view = (widget: PublishedWidget, database: PublishedEmbed) => {
          const more = widget.rowCount - database.table.rows.length;
          return (
            <>
              <PublishedDatabaseView table={database.table} links={linksOf(database)} print={print} compact className="min-w-0" />
              {database.table.layout === "list" && more > 0 && <p className="mt-1 text-xs text-fg-faint">{td("more", { count: more })}</p>}
            </>
          );
        };
        // As tabs, a visitor gets the tabs of the databases published with the page; on paper each tab
        // is printed, one under another.
        const tabs = block.layout === "tabs";
        if (tabs && !print) {
          const shown = block.widgets.flatMap((w) => (w.database ? [{ widget: w, database: w.database }] : []));
          if (!shown.length) return null;
          return (
            <div key={i} className={cn("my-4", pad)}>
              <PublishedTabs label={tt("title")} tabs={shown.map(({ widget, database }) => ({ id: widget.id, name: title(widget, database), icon: database.icon }))}>
                {shown.map(({ widget, database }) => view(widget, database))}
              </PublishedTabs>
            </div>
          );
        }
        // Each widget is its database as its view shows it: a number, a chart's figures, a list or a table.
        return (
          <div key={i} className={cn("my-4", DASHBOARD_CLASS, pad)}>
            <div className={DASHBOARD_GRID_CLASS}>
              {block.widgets.map((widget) => {
                const { database } = widget;
                if (tabs && !database) return null;
                return (
                  <section
                    key={widget.id}
                    className={cn(
                      "flex min-w-0 flex-col rounded-lg border p-3",
                      widgetBoxClass(widget.color),
                      styles.keep,
                      WIDGET_SPAN_CLASS[tabs ? 4 : widget.span],
                    )}
                  >
                    {database ? (
                      <>
                        <h2 className="mb-2 flex min-w-0 items-center gap-1.5 text-sm font-medium">
                          <PageIcon icon={database.icon} kind="database" className="text-base" />
                          {href && !database.outside ? (
                            <Link href={href(database.id, database.title)} className="truncate hover:underline">
                              {title(widget, database)}
                            </Link>
                          ) : (
                            <span className="truncate">{title(widget, database)}</span>
                          )}
                        </h2>
                        {view(widget, database)}
                      </>
                    ) : (
                      <p className="text-sm text-fg-faint">{unavailable}</p>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        );
      }
      case "toc":
        return (
          <div key={i} className={cn("my-2", pad)}>
            <HeadingList
              headings={block.headings.map((h) => ({ key: h.anchor, level: h.level, text: h.text }))}
              label={tb("toc.label")}
              empty={tb("toc.empty")}
              untitled={untitled}
              link={(anchor) => ({ href: `#${anchor}` })}
            />
          </div>
        );
      case "agentChat":
        // Chats are each reader's own, in the app: here only a note that there is one.
        return (
          <div key={i} className={cn("my-2", pad, print && styles.keep)}>
            <p className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-fg-muted">
              <Bot className="h-4 w-4 shrink-0" aria-hidden />
              {ta("elsewhere")}
            </p>
          </div>
        );
      case "footnotes":
        return (
          <section key={i} aria-label={tb("footnote.list")} className={cn("mt-8 text-sm text-fg-muted", pad)}>
            <ol className="space-y-1 border-t border-border pt-3">
              {block.notes.map((note, n) => (
                <li key={note.anchor} id={note.anchor} className="flex gap-2">
                  <a href={`#${note.refAnchor}`} title={tb("footnote.back")} className="min-w-5 shrink-0 tabular-nums text-fg no-underline hover:text-accent">
                    {n + 1}.
                  </a>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {noteParts(note.text).map((part, j) =>
                      "url" in part ? (
                        <a key={j} href={part.url} rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">
                          {part.url}
                        </a>
                      ) : (
                        part.text
                      ),
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        );
      case "breadcrumb":
        return (
          <div key={i} className={cn("my-2", pad)}>
            <Trail crumbs={crumbs} href={href ? (id) => href(id) : undefined} label={tb("breadcrumb.label")} untitled={untitled} />
          </div>
        );
      case "subpages":
        return (
          <div key={i} className={cn("my-2", pad, print && styles.keep)}>
            <SubpageList
              pages={subpages}
              href={href ? (id) => href(id, subpages.find((p) => p.id === id)?.title) : undefined}
              label={tb("subpages.label")}
              empty={tb("subpages.empty")}
              untitled={untitled}
            />
          </div>
        );
      case "mermaid":
        return (
          <div key={i} className={cn(styles.body, "my-2", pad)}>
            <PublishedMermaid source={block.source} label={tb("mermaid.label")} light={print} />
          </div>
        );
      case "bookmark":
        return (
          <div key={i} className={cn("my-2", pad, styles.keep)}>
            <BookmarkCard bookmark={block.bookmark} />
          </div>
        );
      case "pdf":
      case "spreadsheet":
        return (
          <div key={i} className={cn("my-2", pad, styles.keep)}>
            {print ? (
              <div className="rounded-md border border-border px-3.5 py-3">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  {block.kind === "pdf" ? (
                    <FileText className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
                  ) : (
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
                  )}
                  <span className="break-words">{block.name || (block.kind === "pdf" ? tp("untitled") : ts("untitled"))}</span>
                </p>
                {block.caption && <p className="pt-1.5 text-sm text-fg-muted">{block.caption}</p>}
              </div>
            ) : block.kind === "pdf" ? (
              <PdfViewer fileId={block.fileId} name={block.name} caption={block.caption} />
            ) : (
              <SpreadsheetViewer fileId={block.fileId} name={block.name} caption={block.caption} />
            )}
          </div>
        );
      case "webEmbed":
        return (
          <div key={i} className={cn("my-2", pad, styles.keep)}>
            {print ? (
              <BookmarkCard bookmark={{ url: block.url, title: "", description: "", image: "", favicon: "" }} />
            ) : (
              <EmbedFrame url={block.url} embed={block.embed} title={tw("embed.frameTitle", { host: displayHost(block.url) })} />
            )}
          </div>
        );
      case "embed": {
        if (!block.database) {
          return (
            <p key={i} className={cn("my-4 rounded-md border border-border px-3 py-2 text-sm text-fg-faint", !inColumn && !print && "mx-4 sm:mx-[54px]")}>
              {unavailable}
            </p>
          );
        }
        const label = (
          <>
            <PageIcon icon={block.database.icon} kind="database" className="text-base" />
            {pageLabel(block.database.title, untitled)}
          </>
        );
        return (
          <section key={i} className="my-4">
            <h2 className={cn("text-base font-semibold", pad, styles.heading)}>
              {href && !block.database.outside ? (
                <Link href={href(block.database.id, block.database.title)} className="inline-flex items-center gap-1.5 hover:underline">
                  {label}
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1.5">{label}</span>
              )}
            </h2>
            <PublishedDatabaseView table={block.database.table} links={linksOf(block.database)} print={print} className={cn("mt-2", pad)} />
          </section>
        );
      }
    }
  };

  // On screen, uploaded images and files open in the file viewer, with the page's others a key away.
  if (print) return <div className="mt-6">{blocks.map((block, i) => segment(block, i, false))}</div>;
  return <FileViewerArea className="mt-6">{blocks.map((block, i) => segment(block, i, false))}</FileViewerArea>;
}
