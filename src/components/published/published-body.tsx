import { FileText } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PropertyDisplay } from "@/components/database/property-cell";
import { PropertyTypeIcon } from "@/components/database/property-icons";
import { PublishedMermaid } from "@/components/page/mermaid-diagram";
import { HeadingList, Trail } from "@/components/page/page-outline";
import { PdfViewer } from "@/components/page/pdf-viewer";
import { BookmarkCard, EmbedFrame } from "@/components/page/web-card";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { holdsNothing, rowPageSections } from "@/lib/page-visibility";
import { publishedHref, type PublishedLinks } from "@/lib/site";
import { displayHost } from "@/lib/web-blocks";
import type { PublishedBlock, PublishedCrumb, PublishedPage } from "@/server/publication";
import { PublishedDatabaseView } from "./published-database";
import styles from "./published-body.module.css";

// `cn` from components/ui is a client export; server components join classes themselves.
const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

const GUTTER = "px-4 sm:px-[54px]";

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
  links,
  unavailable,
  print = false,
}: {
  blocks: PublishedBlock[];
  crumbs: PublishedCrumb[];
  links: PublishedLinks | null;
  /** What a database block the reader can't see says. */
  unavailable: string;
  print?: boolean;
}) {
  const [tc, tb, tw, tp] = await Promise.all([
    getTranslations("common"),
    getTranslations("page.blocks"),
    getTranslations("page.web"),
    getTranslations("page.pdf"),
  ]);
  const untitled = tc("untitled");
  const titles = new Map(crumbs.map((c) => [c.id, c.title]));
  const href = links ? (id: string, title?: string) => publishedHref(links, id, title ?? titles.get(id) ?? "") : null;

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
      case "breadcrumb":
        return (
          <div key={i} className={cn("my-2", pad)}>
            <Trail crumbs={crumbs} href={href ? (id) => href(id) : undefined} label={tb("breadcrumb.label")} untitled={untitled} />
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
        return (
          <div key={i} className={cn("my-2", pad, styles.keep)}>
            {print ? (
              <div className="rounded-md border border-border px-3.5 py-3">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <FileText className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
                  <span className="break-words">{block.name || tp("untitled")}</span>
                </p>
                {block.caption && <p className="pt-1.5 text-sm text-fg-muted">{block.caption}</p>}
              </div>
            ) : (
              <PdfViewer fileId={block.fileId} name={block.name} caption={block.caption} />
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
              {href ? (
                <Link href={href(block.database.id, block.database.title)} className="inline-flex items-center gap-1.5 hover:underline">
                  {label}
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1.5">{label}</span>
              )}
            </h2>
            <PublishedDatabaseView table={block.database.table} links={links} print={print} className={cn("mt-2", pad)} />
          </section>
        );
      }
    }
  };

  return <div className="mt-6">{blocks.map((block, i) => segment(block, i, false))}</div>;
}
