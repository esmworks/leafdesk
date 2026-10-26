"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "katex/dist/katex.min.css";
import { createExtension, docToBlocks } from "@blocknote/core";
import { CommentMark } from "@blocknote/core/comments";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { DirectionProvider } from "@mantine/core";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useDirection } from "@/components/direction";
import { DarkScheme, useColorScheme } from "@/components/theme/theme-provider";
import { trapFocus } from "@/components/trap-focus";
import { cn, PageIcon, pageLabel } from "@/components/ui";
import type { PageKind } from "@/db/schema/app";
import { useEditorDictionary } from "@/i18n/blocknote";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import type { PageBackground } from "@/lib/page-background";
import { pageTextClasses, type PageStyle } from "@/lib/page-style";
import { isMac, opensPresentation } from "@/lib/shortcuts";
import { splitSlides } from "@/lib/slides";
import { suggestionMarks } from "@/lib/suggestion-marks";
import { rejectedView } from "@/lib/suggestions";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { BlockDirection } from "./block-direction";
import { codeHighlighting } from "./code-block";
import { PageTrailProvider, type TrailCrumb } from "./content-blocks";
import { EmbedHostProvider, type EmbedHost } from "./database-embed";
import { pageEditorSchema, TABLE_SETTINGS, type PageEditor } from "./embed-blocks";
import { backdropClass } from "./page-backdrop";
import { SyncedFrameProvider } from "./synced-page";
import type { PageDoc } from "./use-page-doc";

type AnyBlock = PageEditor["document"][number];

/** Comments mark the text they're about: without the mark, that text would read as empty here. */
const commentMarks = createExtension({ key: "commentMarks", tiptapExtensions: [CommentMark] });

/** The controls fade after this long without the pointer moving. */
const IDLE_MS = 2500;
/** Edits made while presenting show once they pause this long. */
const UPDATE_MS = 400;

/** Things in a slide that take a click themselves rather than moving to the next slide. */
const CLICKABLE = "a, button, input, textarea, select, summary, label, iframe, video, audio, [role=button], [role=link], [role=tab], [contenteditable=true]";
/** Keys with a meaning of their own where focus is: the presentation leaves them alone there. */
const OWNS_KEYS = "input, textarea, select, video, audio, [contenteditable=true], [role=tablist], [role=slider]";

/**
 * A page presented as slides, over the whole window (and the whole screen where the browser
 * allows it), read-only. The first slide is the page's icon and title on its background; the body
 * follows, cut into slides at its dividers or else at its headings (lib/slides). Each slide is
 * drawn by the same editor blocks as the page, its text a size larger, and scrolls when it holds
 * more than fits. Edits made meanwhile, by anyone, show as they come.
 *
 * Keys: → Space and Page Down go on, ← and Page Up go back (the arrows mirrored right to left),
 * Home and End go to the first and last slide, ↑ and ↓ scroll a long one, Esc (or the shortcut that
 * opened it) ends it. A click on a slide goes on too, unless it lands on something that takes clicks
 * itself. Images open nothing here: a click on one goes on like any other.
 */
export default function Presentation({
  pageDoc,
  workspaceId,
  pageId,
  title,
  icon,
  kind,
  background,
  style,
  user,
  crumbs,
  onClose,
}: {
  pageDoc: PageDoc;
  workspaceId: string;
  pageId: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  background: PageBackground | null;
  style: PageStyle;
  user: { id: string; name: string };
  /** The page and the pages above it, for breadcrumb blocks. */
  crumbs: TrailCrumb[];
  onClose: () => void;
}) {
  return createPortal(
    // The black background is dark in either theme, as on the page.
    <DarkScheme dark={background?.color === "black"}>
      <Slides
        pageDoc={pageDoc}
        workspaceId={workspaceId}
        pageId={pageId}
        title={title}
        icon={icon}
        kind={kind}
        background={background}
        style={style}
        user={user}
        crumbs={crumbs}
        onClose={onClose}
      />
    </DarkScheme>,
    document.body,
  );
}

function Slides({
  pageDoc,
  workspaceId,
  pageId,
  title,
  icon,
  kind,
  background,
  style,
  user,
  crumbs,
  onClose,
}: Parameters<typeof Presentation>[0]) {
  const t = useTranslations("page.presentation");
  const tc = useTranslations("common");
  const dir = useDirection();
  const colorScheme = useColorScheme();
  const dictionary = useEditorDictionary();
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // One read-only editor shows the slide's blocks, with the page's schema and table options so
  // every block (merged cells, columns, embeds) draws as it does on the page.
  const editor = useCreateBlockNote(
    { schema: pageEditorSchema, dictionary, tables: TABLE_SETTINGS, extensions: [codeHighlighting(), BlockDirection(), commentMarks, suggestionMarks] },
    [dictionary],
  ) as unknown as PageEditor;

  // The page's blocks as the shared document has them, read again once edits pause; as the page
  // reads, without the suggested edits that wait for an answer.
  const [blocks, setBlocks] = useState<AnyBlock[] | null>(null);
  useEffect(() => {
    const fragment = pageDoc.doc.getXmlFragment(COLLAB_FRAGMENT);
    const read = () => setBlocks(docToBlocks(rejectedView(yXmlFragmentToProseMirrorRootNode(fragment, editor.pmSchema))) as unknown as AnyBlock[]);
    read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(read, UPDATE_MS);
    };
    fragment.observeDeep(onChange);
    return () => {
      fragment.unobserveDeep(onChange);
      clearTimeout(timer);
    };
  }, [editor, pageDoc]);

  const slides = useMemo(() => (blocks ? splitSlides(blocks) : []), [blocks]);
  // The title slide, then the body's.
  const count = slides.length + 1;
  const [wanted, setIndex] = useState(0);
  const index = Math.min(wanted, count - 1);
  const slide = index > 0 ? slides[index - 1] : null;
  // From the slide shown when the change applies: key presses quicker than a render all count.
  const go = useCallback(
    (to: (current: number) => number) => setIndex((i) => Math.max(0, Math.min(count - 1, to(Math.min(i, count - 1))))),
    [count],
  );

  useEffect(() => {
    if (slide) editor.replaceBlocks(editor.document, slide as never);
  }, [editor, slide]);

  // Each slide starts at its top, coming in with a short fade unless motion is reduced.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    content.current?.animate?.([{ opacity: 0, transform: "translateY(0.5rem)" }, { opacity: 1, transform: "none" }], {
      duration: 220,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  }, [index]);

  // Focus moves in on open and back to where it was on close; the page behind doesn't scroll.
  // It rests on the slide's scrolling area, so ↑ ↓ scroll a long slide; keys reach the box from there.
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    scroller.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // The page asked for the whole screen as it opened this (page-view.tsx). Leaving it, with Esc
  // (which the browser takes for itself then) or otherwise, ends the presentation; ending the
  // presentation leaves it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    let full = Boolean(document.fullscreenElement);
    const onChange = () => {
      if (document.fullscreenElement) full = true;
      else if (full) close.current();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    };
  }, []);

  // The controls fade while the pointer rests, and the pointer with them.
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(idleTimer.current);
  }, [wake]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" || opensPresentation(event, isMac())) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // From the scrolling area, Tab goes on as from the box itself: to the first or last control.
      if (document.activeElement === scroller.current) box.current?.focus({ preventScroll: true });
      trapFocus(event, box.current);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    if (event.target instanceof Element && event.target.closest(OWNS_KEYS)) return;
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    let to: ((current: number) => number) | null = null;
    if (event.key === forward || event.key === "PageDown" || (event.key === " " && !event.shiftKey)) to = (i) => i + 1;
    else if (event.key === back || event.key === "PageUp" || (event.key === " " && event.shiftKey)) to = (i) => i - 1;
    else if (event.key === "Home") to = () => 0;
    else if (event.key === "End") to = () => count - 1;
    if (to === null) return;
    event.preventDefault();
    go(to);
  };

  // Keys inside the presentation stop at it, natively: the page's own shortcuts (search, the
  // sidebar, the find bar) never see them.
  const keys = useRef(onKeyDown);
  keys.current = onKeyDown;
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      keys.current(event);
    };
    // Focus that falls out to the page (the next button turning disabled on the last slide) comes
    // back, so the keys keep reaching the presentation.
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      setTimeout(() => {
        if (!document.activeElement || document.activeElement === document.body) scroller.current?.focus({ preventScroll: true });
      });
    };
    element.addEventListener("keydown", onKey);
    element.addEventListener("focusout", onFocusOut);
    return () => {
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const onSlideClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest(CLICKABLE)) return;
    // Selecting text to copy it isn't a click.
    if (window.getSelection()?.isCollapsed === false) return;
    go((i) => i + 1);
  };

  const host = useMemo<EmbedHost>(() => ({ workspaceId, pageId, editable: false, doc: pageDoc.doc }), [workspaceId, pageId, pageDoc]);
  const trail = useMemo(() => ({ workspaceId, crumbs }), [workspaceId, crumbs]);
  const frame = useMemo(
    () => ({ chain: [pageId], user: { id: user.id, name: user.name }, offline: false }),
    // `user` is a new object on every render of the page: its fields are what matter.
    [pageId, user.id, user.name],
  );

  const button =
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";
  const Previous = dir === "rtl" ? ChevronRight : ChevronLeft;
  const Next = dir === "rtl" ? ChevronLeft : ChevronRight;
  const label = pageLabel(title, tc("untitled"));

  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      // Nothing behind the presentation acts on what happens in it: React passes events up
      // through the portal to the page that opened it.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={wake}
      className={cn("fixed inset-x-0 top-(--app-top) bottom-0 z-[90] flex flex-col bg-bg text-fg outline-none", idle && "cursor-none")}
      data-presentation=""
    >
      {/* The page's background and typeface; its pattern needs an element of its own to sit behind. */}
      <div className={cn("relative flex min-h-0 flex-1 flex-col bg-bg", backdropClass(background), pageTextClasses(style))}>
        <div ref={scroller} tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none" onClick={onSlideClick}>
          <div ref={content} className="presentation-slide m-auto w-full max-w-[56em] py-[8vh]">
            <h2 id={titleId} className={cn("px-[54px] font-bold leading-tight break-words", index === 0 ? "text-[2.75em]" : "sr-only")}>
              {icon && (
                <span aria-hidden className="mb-[0.25em] block text-[1.4em]">
                  <PageIcon icon={icon} kind={kind} />
                </span>
              )}
              {label}
            </h2>
            <div className={cn(index === 0 && "hidden")}>
              <SyncedFrameProvider value={frame}>
                <EmbedHostProvider value={host}>
                  <PageTrailProvider value={trail}>
                    <DirectionProvider initialDirection={dir}>
                      <BlockNoteView
                        editor={editor as never}
                        theme={colorScheme}
                        editable={false}
                        sideMenu={false}
                        slashMenu={false}
                        formattingToolbar={false}
                        linkToolbar={false}
                        filePanel={false}
                        tableHandles={false}
                        emojiPicker={false}
                        className="leafdesk-editor"
                      />
                    </DirectionProvider>
                  </PageTrailProvider>
                </EmbedHostProvider>
              </SyncedFrameProvider>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "absolute bottom-4 end-4 flex items-center gap-0.5 rounded-lg border border-border bg-bg p-1 shadow-sm transition-opacity duration-300",
            idle && "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100",
          )}
        >
          <button type="button" className={button} aria-label={t("previous")} title={t("previous")} disabled={index === 0} onClick={() => go((i) => i - 1)}>
            <Previous className="h-4 w-4" aria-hidden />
          </button>
          <span className="min-w-12 px-1 text-center text-xs text-fg-muted tabular-nums" aria-hidden>
            {t("counter", { index: index + 1, count })}
          </span>
          <button type="button" className={button} aria-label={t("next")} title={t("next")} disabled={index === count - 1} onClick={() => go((i) => i + 1)}>
            <Next className="h-4 w-4" aria-hidden />
          </button>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <button type="button" className={button} aria-label={t("exit")} title={t("exit")} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {/* How far along the presentation is; it stays when the controls fade. */}
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5">
          <div
            className="h-full bg-accent transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${((index + 1) / count) * 100}%` }}
          />
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {t("announce", { index: index + 1, count })}
      </p>
    </div>
  );
}
