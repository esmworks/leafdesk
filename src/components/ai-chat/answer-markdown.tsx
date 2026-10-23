"use client";

/**
 * An AI chat answer as markdown (GitHub's dialect: tables, task lists, strikethrough), with its
 * citations as buttons to the sources. Loaded with the chat panel's first answer, so pages don't
 * carry the markdown parser. Raw HTML is shown as text (but for the `<sup>` and `<sub>` page bodies
 * write superscript and subscript in, see lib/remark-text-scripts) and images are not loaded: an
 * answer can repeat what a page says, and an image URL written there would otherwise be fetched by
 * the reader's browser (a way to send data out). Links open in a new tab.
 */
import { BadgeCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn, pageLabel } from "@/components/ui";
import { CITE_HREF, citationLinks, type ChatSourceView } from "@/lib/ai-chat";
import { remarkTextScripts } from "@/lib/remark-text-scripts";

const REMARK_PLUGINS = [remarkGfm, remarkTextScripts];

export default function AnswerMarkdown({
  text,
  sources,
  onSource,
}: {
  text: string;
  sources: Map<number, ChatSourceView>;
  onSource: (source: ChatSourceView) => void;
}) {
  const verifiedLabel = useTranslations("page.verification")("searchBadge");
  const components = useMemo<Components>(
    () => ({
      p: ({ node: _, className, ...props }) => <p {...props} className={cn("mb-2", className)} />,
      ul: ({ node: _, className, ...props }) => <ul {...props} className={cn("mb-2 list-disc space-y-0.5 ps-5 [&_ol]:mb-0 [&_ul]:mb-0", className)} />,
      ol: ({ node: _, className, ...props }) => <ol {...props} className={cn("mb-2 list-decimal space-y-0.5 ps-5 [&_ol]:mb-0 [&_ul]:mb-0", className)} />,
      // A task list item shows its checkbox instead of a bullet.
      li: ({ node: _, className, ...props }) => <li {...props} className={cn(className?.includes("task-list-item") && "list-none [&>input]:me-1.5", className)} />,
      h1: ({ node: _, className, ...props }) => <p {...props} className={cn("mt-3 mb-1 text-sm font-semibold", className)} />,
      h2: ({ node: _, className, ...props }) => <p {...props} className={cn("mt-3 mb-1 font-semibold", className)} />,
      h3: ({ node: _, className, ...props }) => <p {...props} className={cn("mt-2 mb-1 font-semibold", className)} />,
      h4: ({ node: _, className, ...props }) => <p {...props} className={cn("mt-2 mb-1 font-medium", className)} />,
      h5: ({ node: _, className, ...props }) => <p {...props} className={cn("mt-2 mb-1 font-medium", className)} />,
      h6: ({ node: _, className, ...props }) => <p {...props} className={cn("mt-2 mb-1 font-medium", className)} />,
      blockquote: ({ node: _, className, ...props }) => <blockquote {...props} className={cn("mb-2 border-s-2 border-border ps-3 text-fg-muted", className)} />,
      hr: () => <hr className="my-3 border-border" />,
      pre: ({ node: _, className, ...props }) => (
        <pre {...props} className={cn("mb-2 overflow-x-auto rounded bg-bg-subtle p-2 text-sm [&_code]:bg-transparent [&_code]:p-0", className)} />
      ),
      code: ({ node: _, className, ...props }) => <code {...props} className={cn("rounded bg-bg-active px-1 text-[0.9em]", className)} />,
      table: ({ node: _, className, ...props }) => (
        <div className="mb-2 overflow-x-auto">
          <table {...props} className={cn("w-full border-collapse text-sm", className)} />
        </div>
      ),
      th: ({ node: _, className, ...props }) => <th {...props} className={cn("border border-border bg-bg-subtle px-2 py-1 text-start font-medium", className)} />,
      td: ({ node: _, className, ...props }) => <td {...props} className={cn("border border-border px-2 py-1 align-top", className)} />,
      img: ({ alt }) => (alt ? <span>{alt}</span> : null),
      a: ({ node: _, href, children }) => {
        if (href?.startsWith(CITE_HREF)) {
          const n = Number(href.slice(CITE_HREF.length));
          const source = sources.get(n);
          return source?.pageId ? (
            <button
              type="button"
              // On the chat page a source opens in the row panel, which steps through these.
              data-open-row={source.kind === "database" ? undefined : source.pageId}
              onClick={() => onSource(source)}
              title={source.verified ? `${pageLabel(source.title ?? "")} · ${verifiedLabel}` : pageLabel(source.title ?? "")}
              data-verified={source.verified ? "" : undefined}
              className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-0.5 items-center justify-center gap-0.5 rounded bg-bg-active px-1 align-middle text-[10px] font-medium text-fg-muted hover:bg-accent hover:text-accent-fg"
            >
              {source.verified && <BadgeCheck className="h-2.5 w-2.5" aria-label={verifiedLabel} />}
              {n}
            </button>
          ) : (
            <span className="mx-0.5 align-middle text-[10px] text-fg-faint">{n}</span>
          );
        }
        if (!href) return <>{children}</>;
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            {children}
          </a>
        );
      },
    }),
    [sources, onSource, verifiedLabel],
  );
  return (
    <div className="break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {citationLinks(text)}
      </Markdown>
    </div>
  );
}
