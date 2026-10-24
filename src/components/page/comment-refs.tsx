"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { Link2, Lock, MessageSquare, MessageSquareQuote } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { resolveCommentRefsAction } from "@/app/actions/mentions";
import { cn, PageIcon, pageLabel } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { commentPath, commentPreviewBlockConfig, COMMENT_PREVIEW_BLOCK } from "@/lib/comment-refs";
import type { CommentRef } from "@/server/comment-refs";
import type { PageEditor } from "./embed-blocks";

/**
 * Comment threads shown in a page (lib/comment-refs): a comment mention (inline) and a comment
 * preview block, both worked out for the reader by the server each time (server/comment-refs), and
 * the choice a pasted link to a thread of the workspace offers: mention, preview or plain link.
 */

// ---------------------------------------------------------------------------------------------
// What the reader may see of each thread, shared by every chip and card on the page

const refs = new Map<string, CommentRef>();
const listeners = new Set<() => void>();
const wanted = new Map<string, { pageId: string; threadId: string }>();
let batch: ReturnType<typeof setTimeout> | null = null;

const keyOf = (pageId: string, threadId: string) => `${pageId}:${threadId}`;

function request(pageId: string, threadId: string) {
  const key = keyOf(pageId, threadId);
  if (!pageId || !threadId || refs.has(key) || wanted.has(key)) return;
  wanted.set(key, { pageId, threadId });
  batch ??= setTimeout(async () => {
    batch = null;
    const keys = [...wanted.values()];
    wanted.clear();
    try {
      for (const ref of await resolveCommentRefsAction(keys)) refs.set(keyOf(ref.pageId, ref.threadId), ref);
    } catch {
      // Offline or signed out: they keep showing "Loading…", and are asked for again next time.
      return;
    }
    for (const listener of listeners) listener();
  }, 10);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function useCommentRef(pageId: string, threadId: string): CommentRef | undefined {
  const ref = useSyncExternalStore(
    subscribe,
    () => refs.get(keyOf(pageId, threadId)),
    () => undefined,
  );
  useEffect(() => request(pageId, threadId), [pageId, threadId]);
  return ref;
}

/** Opens the thread: on this page its hash opens the comments there (page-view.tsx), elsewhere the page. */
function openThread(event: MouseEvent, href: string, push: (href: string) => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const url = new URL(href, window.location.href);
  if (url.pathname === window.location.pathname) window.location.hash = url.hash;
  else push(href);
}

// ---------------------------------------------------------------------------------------------
// The mention

/** A mentioned thread: who wrote it and what, or "No access" (never the text) where the reader can't see it. */
export function CommentMentionChip({ pageId, threadId }: { pageId: string; threadId: string }) {
  const t = useTranslations("page.mention");
  const router = useRouter();
  const ref = useCommentRef(pageId, threadId);
  if (!ref || ref.status !== "ok") {
    return (
      <span className="leafdesk-mention leafdesk-mention-comment leafdesk-mention-muted" data-mention-status={ref ? "noAccess" : "loading"}>
        {ref ? <Lock className="leafdesk-mention-icon" aria-hidden /> : <Link2 className="leafdesk-mention-icon" aria-hidden />}
        <span className="leafdesk-mention-label">{t(ref ? "noAccess" : "loading")}</span>
      </span>
    );
  }
  const href = commentPath(ref.workspaceId, ref.pageId, ref.threadId);
  return (
    <a href={href} className="leafdesk-mention leafdesk-mention-comment" onClick={(e) => openThread(e, href, router.push)} data-mention-status="ok">
      <MessageSquare className="leafdesk-mention-icon" aria-hidden />
      <span className="leafdesk-mention-label">
        <span className="font-medium">{ref.authorName}</span>
        {ref.text && <span className="text-fg-muted">: {ref.text}</span>}
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// The preview block

function CommentPreviewCard({ pageId, threadId }: { pageId: string; threadId: string }) {
  const t = useTranslations("page.commentRef");
  const tm = useTranslations("page.mention");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const ref = useCommentRef(pageId, threadId);
  const box = "w-full rounded-lg border border-border bg-bg px-3 py-2.5";
  if (!ref || ref.status !== "ok") {
    return (
      <div contentEditable={false} className={cn(box, "flex items-center gap-2 text-sm text-fg-faint")} data-mention-status={ref ? "noAccess" : "loading"}>
        {ref ? <Lock className="h-4 w-4 shrink-0" aria-hidden /> : <MessageSquare className="h-4 w-4 shrink-0" aria-hidden />}
        <span>{ref ? t("noAccess") : tm("loading")}</span>
      </div>
    );
  }
  const href = commentPath(ref.workspaceId, ref.pageId, ref.threadId);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ref.createdAt));
  return (
    <div contentEditable={false} className={box} data-mention-status="ok">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <UserAvatar name={ref.authorName} image={ref.authorImage} size="sm" />
        <span className="truncate font-medium">{ref.authorName}</span>
        <span className="shrink-0 text-xs text-fg-faint">{when}</span>
        {ref.resolved && <span className="shrink-0 rounded bg-bg-hover px-1.5 text-xs text-fg-muted">{t("resolved")}</span>}
      </div>
      {ref.text && <p className="mt-1.5 line-clamp-4 text-sm whitespace-pre-wrap">{ref.text}</p>}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
        <span className="flex min-w-0 items-center gap-1">
          <PageIcon icon={ref.pageIcon} kind="page" className="text-xs" />
          <span className="truncate">{t("onPage", { title: pageLabel(ref.pageTitle, tc("untitled")) })}</span>
        </span>
        <span>{t("replies", { count: ref.replies })}</span>
        <a href={href} onClick={(e) => openThread(e, href, router.push)} className="font-medium text-accent hover:underline">
          {t("openThread")}
        </a>
      </div>
    </div>
  );
}

const CommentPreviewBlock = createReactBlockSpec(commentPreviewBlockConfig, {
  render: function CommentPreviewView({ block }) {
    return <CommentPreviewCard pageId={block.props.pageId} threadId={block.props.threadId} />;
  },
  // Copied out of the editor: a link to the thread for a reader who may see it, never its text.
  toExternalHTML: function CommentPreviewHTML({ block }) {
    const ref = refs.get(keyOf(block.props.pageId, block.props.threadId));
    return ref?.status === "ok" ? (
      <p>
        <a href={commentPath(ref.workspaceId, ref.pageId, ref.threadId)}>{ref.pageTitle}</a>
      </p>
    ) : (
      <p />
    );
  },
});

export const commentPreviewBlockSpecs = { commentPreview: CommentPreviewBlock() };

// ---------------------------------------------------------------------------------------------
// Pasting a link to a thread

export type PastedComment = { url: string; pageId: string; threadId: string };

/**
 * What a link to a thread of the workspace, pasted on its own, becomes: a menu at the cursor offers
 * a mention, a preview block or the plain link; Escape or a click elsewhere keeps the plain link.
 */
export function CommentPasteChooser({ editor, pasted, onDone }: { editor: PageEditor; pasted: PastedComment; onDone: () => void }) {
  const t = useTranslations("page.commentRef");
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    try {
      const view = editor.prosemirrorView;
      const coords = view?.coordsAtPos(view.state.selection.from);
      if (coords) setAt({ top: coords.bottom + 4, left: coords.left });
    } catch {
      setAt({ top: 120, left: 120 });
    }
  }, [editor]);

  const finish = (how: "mention" | "preview" | "link") => {
    onDone();
    editor.focus();
    if (how === "mention") {
      editor.insertInlineContent([{ type: "mention", props: { kind: "comment", pageId: pasted.pageId, threadId: pasted.threadId } }, " "] as never, {
        updateSelection: true,
      });
    } else if (how === "preview") {
      const current = editor.getTextCursorPosition().block;
      const block = { type: COMMENT_PREVIEW_BLOCK, props: { pageId: pasted.pageId, threadId: pasted.threadId } };
      const empty = current.type === "paragraph" && Array.isArray(current.content) && current.content.length === 0;
      if (empty) editor.updateBlock(current, block as never);
      else editor.insertBlocks([block] as never, current, "after");
    } else {
      editor.insertInlineContent([{ type: "link", href: pasted.url, content: pasted.url }, " "] as never, { updateSelection: true });
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finishRef.current("link");
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      finishRef.current("link");
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [at]);

  if (!at) return null;
  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover focus:bg-bg-hover focus:outline-none";
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={t("pasteTitle")}
      className="fixed z-50 w-56 rounded-lg border border-border bg-bg p-1 shadow-lg"
      style={{ top: at.top, left: Math.min(at.left, window.innerWidth - 240) }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }}
    >
      <button type="button" role="menuitem" className={item} onClick={() => finish("mention")}>
        <MessageSquare className="h-4 w-4 text-fg-muted" aria-hidden />
        {t("pasteAsMention")}
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => finish("preview")}>
        <MessageSquareQuote className="h-4 w-4 text-fg-muted" aria-hidden />
        {t("pasteAsPreview")}
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => finish("link")}>
        <Link2 className="h-4 w-4 text-fg-muted" aria-hidden />
        {t("pasteAsLink")}
      </button>
    </div>,
    document.body,
  );
}

/** The address a "Copy link" in a thread's menu copies. */
export const threadUrl = (workspaceId: string, pageId: string, threadId: string) =>
  new URL(commentPath(workspaceId, pageId, threadId), window.location.origin).href;
