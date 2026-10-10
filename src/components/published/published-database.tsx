"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { GroupLabel } from "@/components/database/group-label";
import { isEmptyValue, PropertyDisplay } from "@/components/database/property-cell";
import { PropertyTypeIcon, ViewIcon } from "@/components/database/property-icons";
import { PageIcon } from "@/components/ui";
import type { CardSize } from "@/db/schema";
import { pageLabel } from "@/lib/labels";
import { publishedHref, type PublishedLinks } from "@/lib/site";
import type { PublishedDatabase, PublishedRow } from "@/server/publication";

const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

const CARD_WIDTH: Record<CardSize, string> = { small: "11rem", medium: "15rem", large: "20rem" };
const COVER_HEIGHT: Record<CardSize, string> = { small: "h-24", medium: "h-36", large: "h-48" };
/** Makes a row's title link cover its whole card or line. */
const STRETCH = "before:absolute before:inset-0 before:content-['']";

type Props = {
  table: PublishedDatabase;
  /**
   * Where the page links to (the publication's link or its site): rows link to their pages there.
   * Null in the print view, where rows are named, not linked.
   */
  links: PublishedLinks | null;
  /** The page showing the database, to switch views on; without it, no view tabs (database blocks in a body). */
  viewPath?: string;
  className?: string;
  /** For print: boards wrap their columns and tables fit the page instead of scrolling sideways. */
  print?: boolean;
};

type Href = ((id: string) => string) | null;

/** A published database drawn like its view: a table, board, list or gallery, read-only. */
export function PublishedDatabaseView({ table, links, viewPath, className, print = false }: Props) {
  const titles = new Map(table.rows.map((r) => [r.id, r.title]));
  const href: Href = links ? (id: string) => publishedHref(links, id, titles.get(id) ?? "") : null;
  const viewHref = (viewId: string) => `${viewPath}?view=${encodeURIComponent(viewId)}`;
  const tabs = viewPath && table.views.length > 1 ? table.views : [];
  return (
    <div className={className}>
      {tabs.length > 0 && (
        <nav className="mb-2 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
          {tabs.map((v) => {
            const current = v.id === table.view?.id;
            return (
              <Link
                key={v.id}
                href={viewHref(v.id)}
                scroll={false}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-1.5 text-sm",
                  current ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg",
                )}
              >
                <ViewIcon type={v.type} className="h-3.5 w-3.5" />
                {v.name}
              </Link>
            );
          })}
        </nav>
      )}
      <Layout table={table} href={href} print={print} />
    </div>
  );
}

function Layout({ table, href, print }: { table: PublishedDatabase; href: Href; print: boolean }) {
  const t = useTranslations("publish");
  if (!table.rows.length) return <p className="border-y border-border px-2 py-6 text-sm text-fg-faint">{t("noRows")}</p>;
  const byId = new Map(table.rows.map((r) => [r.id, r]));
  const rowsOf = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []);
  switch (table.layout) {
    case "board":
      return (
        <div className={cn("flex gap-3 pb-3", print ? "flex-wrap" : "overflow-x-auto")}>
          {table.groups?.list.map((g) => (
            <section key={g.key} className="flex w-64 shrink-0 flex-col gap-2">
              <h3 className="flex h-7 items-center gap-2 px-1">
                <GroupLabel prop={table.groups!.property} group={g} />
                <span className="text-xs text-fg-faint">{g.rowIds.length}</span>
              </h3>
              {rowsOf(g.rowIds).map((row) => (
                <Card key={row.id} row={row} table={table} href={href} />
              ))}
            </section>
          ))}
        </div>
      );
    case "gallery":
      return (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${CARD_WIDTH[table.cardSize]}, 100%), 1fr))` }}
        >
          {table.rows.map((row) => (
            <Card key={row.id} row={row} table={table} href={href} cover={row.cover !== undefined} />
          ))}
        </div>
      );
    case "list":
      return (
        <div role="list" className="border-t border-border">
          {table.rows.map((row) => (
            <ListRow key={row.id} row={row} table={table} href={href} />
          ))}
        </div>
      );
    case "table":
      if (!table.groups) return <Table rows={table.rows} table={table} href={href} print={print} />;
      return (
        <div className="flex flex-col gap-6">
          {table.groups.list.map((g) => (
            <section key={g.key}>
              <h3 className="mb-1 flex h-8 items-center gap-2 px-1">
                <GroupLabel prop={table.groups!.property} group={g} />
                <span className="text-xs text-fg-faint">{g.rowIds.length}</span>
              </h3>
              <Table rows={rowsOf(g.rowIds)} table={table} href={href} print={print} />
            </section>
          ))}
        </div>
      );
  }
}

function Title({ row, className }: { row: PublishedRow; className?: string }) {
  const tc = useTranslations("common");
  return <span className={cn("min-w-0 break-words", !row.title && "text-fg-faint", className)}>{pageLabel(row.title, tc("untitled"))}</span>;
}

/** A row's title, linked to its page when the database is on a published site. */
function RowLink({ row, href, className, children }: { row: PublishedRow; href: Href; className?: string; children: React.ReactNode }) {
  return href ? (
    <Link href={href(row.id)} className={className}>
      {children}
    </Link>
  ) : (
    <span className={className}>{children}</span>
  );
}

function Card({ row, table, href, cover }: { row: PublishedRow; table: PublishedDatabase; href: Href; cover?: boolean }) {
  const shown = table.properties.filter((p) => !isEmptyValue(p, row.properties[p.id]));
  // A cover that fails to load leaves the plain cover area instead of a broken image.
  const [failed, setFailed] = useState(false);
  const image = row.cover && !failed ? row.cover : null;
  return (
    // The title's link covers the card; values that are links themselves (email, URL) sit above it.
    <div className="board-card relative flex min-w-0 flex-col overflow-hidden rounded-lg">
      {cover && (
        <div className={cn(COVER_HEIGHT[table.cardSize], "shrink-0 overflow-hidden border-b border-border bg-bg-subtle")}>
          {image ? (
            // Covers are arbitrary URLs from row bodies: plain img, no optimizer, no referrer.
            <img
              src={image}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            row.icon && (
              <div className="flex h-full items-center justify-center">
                <PageIcon icon={row.icon} className="text-4xl" />
              </div>
            )
          )}
        </div>
      )}
      <div className="min-w-0 px-3 py-2.5">
        <RowLink row={row} href={href} className={cn("flex min-w-0 gap-1.5 text-sm leading-5 font-medium", href && STRETCH)}>
          {row.icon && (!cover || image) && <span className="shrink-0">{row.icon}</span>}
          <Title row={row} />
        </RowLink>
        {shown.length > 0 && (
          <div className="relative mt-2 flex flex-col items-start gap-1.5 text-xs">
            {shown.map((p) => (
              <div key={p.id} className="flex max-w-full min-w-0 items-center text-fg-muted" title={p.name}>
                <PropertyDisplay prop={p} value={row.properties[p.id]} style={row.styles?.[p.id]} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ListRow({ row, table, href }: { row: PublishedRow; table: PublishedDatabase; href: Href }) {
  const shown = table.properties.filter((p) => !isEmptyValue(p, row.properties[p.id]));
  return (
    <div role="listitem" className="relative flex min-h-9 min-w-0 items-center gap-2 border-b border-border px-2 hover:bg-bg-hover">
      <RowLink row={row} href={href} className={cn("flex min-w-0 items-center gap-2", href && STRETCH)}>
        <PageIcon icon={row.icon} className="shrink-0" />
        <Title row={row} className="truncate text-sm font-medium" />
      </RowLink>
      {shown.length > 0 && (
        <span className="relative ml-auto flex max-w-[60%] min-w-0 shrink items-center justify-end gap-3 overflow-hidden text-xs text-fg-muted">
            {shown.map((p) => (
            <span key={p.id} className="flex min-w-0 shrink-0 items-center last:shrink" title={p.name}>
              <PropertyDisplay prop={p} value={row.properties[p.id]} style={row.styles?.[p.id]} />
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function Table({ rows, table, href, print }: { rows: PublishedRow[]; table: PublishedDatabase; href: Href; print: boolean }) {
  const t = useTranslations("publish");
  const { properties } = table;
  return (
    // In print the table fits the page: columns share its width and long values wrap.
    <div className={cn("pb-3", !print && "overflow-x-auto [color-scheme:light_dark]")}>
      <table className={cn("w-full border-collapse text-sm", !print && "min-w-max")}>
        <thead>
          <tr>
            <th className={cn("h-[33px] border-y border-border px-2 text-left font-normal text-fg-muted", !print && "min-w-60")}>
              <span className="flex items-center gap-1.5">
                <PropertyTypeIcon type="title" className="h-3.5 w-3.5 shrink-0" />
                {t("name")}
              </span>
            </th>
            {properties.map((prop) => (
              <th
                key={prop.id}
                className={cn("h-[33px] border-y border-l border-border px-2 text-left font-normal text-fg-muted", !print && "min-w-40")}
              >
                <span className="flex items-center gap-1.5">
                  <PropertyTypeIcon type={prop.type} className="h-3.5 w-3.5 shrink-0" />
                  <span className={print ? "min-w-0" : "truncate"}>{prop.name}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="border-b border-border px-2 py-1.5 align-top">
                <RowLink row={row} href={href} className={cn("flex items-center gap-1.5 font-medium", href && "hover:underline")}>
                  {row.icon && <PageIcon icon={row.icon} className="text-sm" />}
                  <Title row={row} />
                </RowLink>
              </td>
              {properties.map((prop) => (
                <td key={prop.id} className={cn("border-b border-l border-border px-2 py-1.5 align-top", !print && "max-w-80")}>
                  <div className="flex min-h-5 min-w-0 items-center">
                    <PropertyDisplay prop={prop} value={row.properties[prop.id]} style={row.styles?.[prop.id]} wrap />
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
