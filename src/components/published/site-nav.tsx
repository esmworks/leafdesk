import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import type { SiteNavNode } from "@/server/site";

const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

/**
 * A site's navigation: its listed pages with their subpages, drawn like the app's sidebar. Pages
 * on the way to the current one start open; the rest open with their arrow. No script needed.
 */
export function SiteNav({
  nodes,
  currentId,
  open,
  untitled,
  label,
}: {
  nodes: SiteNavNode[];
  currentId: string;
  /** Pages from the listed page down to the current one. */
  open: Set<string>;
  untitled: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="text-sm">
      <NavList nodes={nodes} currentId={currentId} open={open} untitled={untitled} depth={0} />
    </nav>
  );
}

function NavList({
  nodes,
  currentId,
  open,
  untitled,
  depth,
}: {
  nodes: SiteNavNode[];
  currentId: string;
  open: Set<string>;
  untitled: string;
  depth: number;
}) {
  const indent = 0.25 + depth * 0.75;
  return (
    <ul className="flex flex-col gap-px">
      {nodes.map((node) => {
        const current = node.id === currentId;
        const row = (
          <Link
            href={node.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5",
              current ? "bg-bg-active font-medium text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
            )}
          >
            <PageIcon icon={node.icon} kind={node.kind} className="shrink-0 text-sm" />
            <span className="truncate">{pageLabel(node.title, untitled)}</span>
          </Link>
        );
        return (
          <li key={node.id}>
            {node.children.length ? (
              <details open={open.has(node.id) || undefined}>
                <summary className="flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
                  <span className="shrink-0" style={{ width: `${indent}rem` }} />
                  <span className="flex h-7 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-bg-hover hover:text-fg-muted">
                    <ChevronRight className="h-3.5 w-3.5 transition-transform rtl:rotate-180 [details[open]>summary>span>&]:rotate-90" aria-hidden />
                  </span>
                  {row}
                </summary>
                <NavList nodes={node.children} currentId={currentId} open={open} untitled={untitled} depth={depth + 1} />
              </details>
            ) : (
              <div className="flex items-center">
                {/* Room for the arrow, so icons line up with pages that have subpages. */}
                <span className="shrink-0" style={{ width: `${indent + 1.25}rem` }} />
                {row}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
