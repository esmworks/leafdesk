"use client";

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "next-intl";
import { cn } from "@/components/ui";
import styles from "@/components/published/published-body.module.css";
import { openLinksAside } from "./previews";

const REMARK_PLUGINS = [remarkGfm];

/**
 * A Markdown file rendered in the file viewer (GitHub's dialect), loaded with the first one shown.
 * Raw HTML in the file is left out (no rehype-raw), and images are not loaded: a file can point
 * anywhere, and showing it shouldn't fetch from there (their description shows instead). Links
 * open in a new tab.
 */
export default function MarkdownPreview({ text }: { text: string }) {
  const t = useTranslations("page.viewer");
  const components: Components = {
    img: ({ alt }) => <span className="text-fg-muted">[{alt ? t("markdownImage", { alt }) : t("markdownImageUntitled")}]</span>,
    a: ({ node: _, href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ),
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
    hr: () => <hr className="my-4 border-border" />,
  };
  return (
    <div className={cn(styles.body, "px-5 py-6 sm:px-12 sm:py-10")} onClick={openLinksAside}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
