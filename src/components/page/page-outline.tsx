import Link from "next/link";
import { PageIcon } from "@/components/ui";
import type { PageKind } from "@/db/schema/app";
import { pageLabel } from "@/lib/labels";

/**
 * What the table of contents, breadcrumb and subpages blocks show, in the editor (components/page/
 * content-blocks.tsx) and on published pages alike. No hooks and no client-only code, so server
 * components can draw them too.
 */

export type TrailCrumb = { id: string; title: string; icon: string | null; kind: PageKind };
export type OutlineHeading = { key: string; level: number; text: string };

/** Links to the headings of a page, indented by level (counted from the shallowest one used). */
export function HeadingList({
  headings,
  label,
  empty,
  untitled,
  link,
}: {
  headings: OutlineHeading[];
  label: string;
  empty: string;
  untitled: string;
  link: (key: string) => { href: string; onClick?: (event: React.MouseEvent) => void };
}) {
  if (!headings.length) return <p className="py-1 text-sm text-fg-faint">{empty}</p>;
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <nav aria-label={label} className="w-full py-1">
      <ul className="m-0 flex list-none flex-col p-0">
        {headings.map((h) => (
          <li key={h.key} className="m-0" style={{ paddingInlineStart: `${(h.level - top) * 1.25}rem` }}>
            <a
              {...link(h.key)}
              className="block truncate rounded px-1 py-0.5 text-sm text-fg-muted underline decoration-border underline-offset-4 hover:bg-bg-hover hover:text-fg"
            >
              {h.text || untitled}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * A page and the pages above it, the ones above as links (the last crumb is the page itself).
 * Without `href` (print) they are all plain text.
 */
export function Trail({
  crumbs,
  href,
  label,
  untitled,
}: {
  crumbs: TrailCrumb[];
  href?: (id: string) => string;
  label: string;
  untitled: string;
}) {
  return (
    <nav aria-label={label} className="flex w-full min-w-0 flex-wrap items-center gap-1 py-1 text-sm text-fg-muted">
      {crumbs.map((c, i) => {
        const inner = (
          <>
            <PageIcon icon={c.icon} kind={c.kind} className="text-sm" />
            <span className="max-w-60 truncate">{pageLabel(c.title, untitled)}</span>
          </>
        );
        return (
          <span key={c.id} className="flex min-w-0 items-center gap-1">
            {i === crumbs.length - 1 ? (
              <span aria-current="page" className="flex min-w-0 items-center gap-1 px-1 text-fg">
                {inner}
              </span>
            ) : (
              <>
                {href ? (
                  <Link
                    href={href(c.id)}
                    className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 no-underline hover:bg-bg-hover hover:text-fg"
                  >
                    {inner}
                  </Link>
                ) : (
                  <span className="flex min-w-0 items-center gap-1 px-1 py-0.5">{inner}</span>
                )}
                <span className="text-fg-faint">/</span>
              </>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * The pages under a page, one per line with its icon. Without `href` (print) they are plain text.
 */
export function SubpageList({
  pages,
  href,
  label,
  empty,
  untitled,
}: {
  pages: TrailCrumb[];
  href?: (id: string) => string;
  label: string;
  empty: string;
  untitled: string;
}) {
  if (!pages.length) return <p className="py-1 text-sm text-fg-faint">{empty}</p>;
  return (
    <nav aria-label={label} className="w-full py-1">
      <ul className="m-0 flex list-none flex-col p-0">
        {pages.map((p) => {
          const inner = (
            <>
              <PageIcon icon={p.icon} kind={p.kind} className="text-base" />
              <span className="min-w-0 truncate underline decoration-border underline-offset-4">{pageLabel(p.title, untitled)}</span>
            </>
          );
          return (
            <li key={p.id} className="m-0">
              {href ? (
                <Link href={href(p.id)} className="-mx-1 flex min-w-0 items-center gap-2 rounded px-1 py-1 text-sm no-underline hover:bg-bg-hover">
                  {inner}
                </Link>
              ) : (
                <span className="flex min-w-0 items-center gap-2 py-1 text-sm">{inner}</span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
