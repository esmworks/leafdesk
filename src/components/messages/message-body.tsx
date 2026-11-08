"use client";

import { FileText, Hash } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, memo, useContext } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/components/ui";
import { MENTION_SCHEME, messageRef } from "@/lib/message-text";
import { messagesPath } from "@/lib/messages";
import { stayInMessages } from "./messages-sidebar";
import { channelTitle, useView } from "./store";

const REMARK_PLUGINS = [remarkGfm];

/** `leafdesk:` references stay (they become chips); every other address goes through the library's own check. */
const urlTransform = (url: string) => (url.startsWith(MENTION_SCHEME) ? url : defaultUrlTransform(url));

/** The workspace the body is shown in: references link within it. */
const WorkspaceOf = createContext("");

const chip = "rounded px-0.5 font-medium";

function Reference({ href, children }: { href: string; children: React.ReactNode }) {
  const t = useTranslations("messages");
  const workspaceId = useContext(WorkspaceOf);
  const ref = messageRef(href);
  const s = useView();
  if (!ref) return <>{children}</>;
  if (ref.kind === "here" || ref.kind === "everyone") {
    return <span className={cn(chip, "bg-accent/15 text-accent")}>{ref.kind === "here" ? "@here" : "@channel"}</span>;
  }
  if (ref.kind === "user") {
    const person = s.people.get(ref.id);
    const me = ref.id === s.me;
    // The name they have now; someone the reader can't know keeps the words written.
    return (
      <span title={person?.email} className={cn(chip, me ? "bg-accent/25 text-fg" : "bg-accent/10 text-accent")}>
        @{person?.name || String(children).replace(/^@/, "")}
      </span>
    );
  }
  if (ref.kind === "channel") {
    const channel = s.channels.get(ref.id);
    const target = messagesPath(workspaceId, { channelId: ref.id });
    if (!channel) return <span className={cn(chip, "text-fg-muted")}>{children}</span>;
    return (
      <a href={target} onClick={(e) => stayInMessages(e, target)} className={cn(chip, "inline-flex items-center gap-0.5 bg-bg-active text-fg hover:underline")}>
        <Hash className="h-3 w-3" />
        {channelTitle(s, channel, { you: t("you"), someone: t("someone") })}
      </a>
    );
  }
  // A page: its own address checks who may open it.
  return (
    <a href={`/w/${workspaceId}/p/${ref.id}`} className={cn(chip, "inline-flex items-center gap-0.5 text-fg underline decoration-border underline-offset-2 hover:decoration-fg")}>
      <FileText className="h-3.5 w-3.5 text-fg-icon" />
      {children}
    </a>
  );
}

const COMPONENTS: Components = {
  a: ({ node: _, href, children }) => {
    if (typeof href === "string" && href.startsWith(MENTION_SCHEME)) return <Reference href={href}>{children}</Reference>;
    const inApp = typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
    return inApp ? (
      <a href={href} className="text-accent hover:underline">
        {children}
      </a>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent hover:underline">
        {children}
      </a>
    );
  },
  // Images written into the text load nothing (they could tell another site who read it): their address shows as a link.
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="text-accent hover:underline">
        {alt || src}
      </a>
    ) : null,
  p: ({ node: _, className, ...props }) => <p {...props} className={cn("my-0 [&+*]:mt-1.5", className)} />,
  pre: ({ node: _, className, ...props }) => <pre {...props} className={cn("my-1.5 overflow-x-auto rounded-md border border-border bg-bg-subtle p-2.5 text-[13px] leading-snug", className)} />,
  code: ({ node: _, className, ...props }) => <code {...props} className={cn("rounded bg-bg-subtle px-1 font-mono text-[0.88em] [pre_&]:bg-transparent [pre_&]:p-0", className)} />,
  ul: ({ node: _, className, ...props }) => <ul {...props} className={cn("my-1 list-disc ps-5", className)} />,
  ol: ({ node: _, className, ...props }) => <ol {...props} className={cn("my-1 list-decimal ps-5", className)} />,
  li: ({ node: _, className, ...props }) => <li {...props} className={cn(className?.includes("task-list-item") && "list-none [&>input]:me-1.5", className)} />,
  blockquote: ({ node: _, className, ...props }) => <blockquote {...props} className={cn("my-1 border-s-2 border-border ps-3 text-fg-muted", className)} />,
  h1: ({ node: _, ...props }) => <p {...props} className="my-1 text-base font-semibold" />,
  h2: ({ node: _, ...props }) => <p {...props} className="my-1 text-[15px] font-semibold" />,
  h3: ({ node: _, ...props }) => <p {...props} className="my-1 font-semibold" />,
  h4: ({ node: _, ...props }) => <p {...props} className="my-1 font-semibold" />,
  h5: ({ node: _, ...props }) => <p {...props} className="my-1 font-semibold" />,
  h6: ({ node: _, ...props }) => <p {...props} className="my-1 font-semibold" />,
  table: ({ node: _, className, ...props }) => (
    <div className="my-1 overflow-x-auto">
      <table {...props} className={cn("border-collapse text-[13px]", className)} />
    </div>
  ),
  th: ({ node: _, className, ...props }) => <th {...props} className={cn("border border-border bg-bg-subtle px-2 py-1 text-start font-medium", className)} />,
  td: ({ node: _, className, ...props }) => <td {...props} className={cn("border border-border px-2 py-1 align-top", className)} />,
  hr: () => <hr className="my-2 border-border" />,
};

/** Only emoji (up to a few): shown large. */
const ONLY_EMOJI = /^(?:\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\u{FE0F}|\u{200D}\p{Extended_Pictographic})*\s*){1,3}$/u;

/**
 * A message's text: Markdown (no raw HTML), with people, channels, pages and @here/@channel drawn
 * as chips by what the reader knows now (lib/message-text.ts).
 */
export const MessageBody = memo(function MessageBody({ body, workspaceId, edited }: { body: string; workspaceId: string; edited?: string | null }) {
  const t = useTranslations("messages");
  const big = ONLY_EMOJI.test(body.trim());
  return (
    <WorkspaceOf.Provider value={workspaceId}>
      <div className={cn("min-w-0 text-sm leading-relaxed break-words text-fg [overflow-wrap:anywhere]", big && "text-[32px] leading-tight")}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} urlTransform={urlTransform} skipHtml>
          {body}
        </Markdown>
        {edited && (
          <span className="ms-1 text-xs text-fg-faint" title={edited}>
            {t("edited")}
          </span>
        )}
      </div>
    </WorkspaceOf.Provider>
  );
});
