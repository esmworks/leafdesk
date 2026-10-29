"use client";

import { Sparkles } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { PageIcon, pageLabel } from "@/components/ui";
import { blockPath, pagePath } from "@/lib/mentions";
import type { RelatedPage } from "@/server/related-pages";
import { openBlockLink } from "./block-focus";
import { read } from "@/components/read";

/**
 * "Related pages" under a page's body: pages close to it in meaning that it doesn't link to and
 * isn't linked from (server/related-pages), each opening at its closest passage. Asked for once it
 * scrolls into view, and nothing shows when there are none (no embeddings model, AI off).
 */
export function RelatedPages({ pageId }: { pageId: string }) {
  const t = useTranslations("page.related");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<RelatedPage[]>([]);
  const [wanted, setWanted] = useState(false);

  useEffect(() => {
    setWanted(false);
    setPages([]);
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setWanted(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageId]);

  useEffect(() => {
    if (!wanted) return;
    let current = true;
    read("relatedPages", pageId).then(
      (list) => current && setPages(list),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [pageId, wanted]);

  function open(event: MouseEvent, href: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openBlockLink(href, router.push);
  }

  return (
    <div ref={ref} className="print:hidden">
      {pages.length > 0 && (
        <section aria-label={t("title")} className="mt-6 border-t border-border px-4 pt-4 md:px-[54px]">
          <h2 className="flex items-center gap-1.5 text-xs font-medium text-fg-muted" title={t("hint")}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            {t("title")}
          </h2>
          <ul className="mt-1.5 flex flex-col">
            {pages.map((p) => {
              const href = p.blockId ? blockPath(p.workspaceId, p.id, p.blockId) : pagePath(p.workspaceId, p.id);
              return (
                <li key={p.id} className="mb-1">
                  <a
                    href={href}
                    onClick={(e) => open(e, href)}
                    className="-mx-1 flex items-center gap-2 rounded px-1 py-1 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
                  >
                    <PageIcon icon={p.icon} kind={p.kind} className="text-sm" />
                    <span className="truncate">{pageLabel(p.title, tc("untitled"))}</span>
                    <span className="ms-auto shrink-0 text-xs text-fg-faint">
                      {t("edited", { time: format.relativeTime(new Date(p.updatedAt), new Date()) })}
                    </span>
                  </a>
                  {p.passage && <p className="ms-5 line-clamp-2 px-1 text-xs text-fg-faint">{p.passage}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
