"use client";

import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/components/ui";
import styles from "@/components/published/published-body.module.css";

const REMARK_PLUGINS = [remarkGfm];

/** Images from the web or from this app (uploaded files); nothing protocol-relative or scripted. */
const SAFE_IMAGE = /^(https?:\/\/|\/(?![/\\]))/i;

const COMPONENTS: Components = {
  // Uploaded images and images the row's body shows anyway; plain img, no referrer.
  img: ({ src, alt }) =>
    typeof src === "string" && SAFE_IMAGE.test(src) ? (
      <img src={src} alt={alt ?? ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="max-h-96 rounded-md" />
    ) : null,
  a: ({ node: _, href, children }) => {
    // App links (page mentions) stay in the tab; others open beside it.
    const inApp = typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
    return inApp ? <a href={href}>{children}</a> : <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
  },
  pre: ({ node: _, className, ...props }) => <pre {...props} className={cn("overflow-x-auto rounded-md bg-bg-subtle p-3 text-[13px]", className)} />,
  code: ({ node: _, className, ...props }) => <code {...props} className={cn("font-mono text-[0.9em]", className)} />,
  table: ({ node: _, className, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props} className={cn("border-collapse", className)} />
    </div>
  ),
  th: ({ node: _, className, ...props }) => <th {...props} className={cn("border border-border bg-bg-subtle px-2 py-1 text-start font-medium", className)} />,
  td: ({ node: _, className, ...props }) => <td {...props} className={cn("border border-border px-2 py-1 align-top", className)} />,
  ul: ({ node: _, className, ...props }) => <ul {...props} className={cn("list-disc ps-6", className)} />,
  ol: ({ node: _, className, ...props }) => <ol {...props} className={cn("list-decimal ps-6", className)} />,
  li: ({ node: _, className, ...props }) => <li {...props} className={cn(className?.includes("task-list-item") && "list-none [&>input]:me-1.5", className)} />,
  blockquote: ({ node: _, className, ...props }) => <blockquote {...props} className={cn("border-s-2 border-border ps-3 text-fg-muted", className)} />,
  hr: () => <hr className="my-3 border-border" />,
};

/**
 * A post's body in a feed view (Markdown of the row's body, see server/feed.ts), read-only. Raw HTML
 * is left out: the app's own block lines are HTML comments, and nothing else is passed through.
 */
export const FeedMarkdown = memo(function FeedMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className={cn(styles.body, "min-w-0 text-[15px] leading-relaxed break-words")}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} skipHtml>
        {markdown}
      </Markdown>
    </div>
  );
});
