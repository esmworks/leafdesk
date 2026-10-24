"use client";

import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core/extensions";
import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { AtSign, Bookmark, Link2, MonitorPlay, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { fetchLinkPreviewAction } from "@/app/actions/link-preview";
import { cn } from "@/components/ui";
import {
  BOOKMARK_BLOCK,
  bookmarkBlockConfig,
  bookmarkWidth,
  displayHost,
  embedFor,
  isLoneUrl,
  parseWebUrl,
  WEB_EMBED_BLOCK,
  webEmbedBlockConfig,
} from "@/lib/web-blocks";
import { mediaWidth } from "@/lib/media-placement";
import { linkedPageRef } from "@/lib/mentions";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";
import { BookmarkCard, EmbedFrame } from "./web-card";
import { linkToMention } from "./link-mention-toolbar";
import { isRtl } from "@/components/direction";

/**
 * The editor's side of the web blocks (configs shared with the server in lib/web-blocks): a
 * bookmark card and an embed. Both are widgets like the database blocks, so events inside them
 * (typing a URL, clicking the card) belong to them rather than the editor.
 */

/** Blocks just added from the slash menu: their URL field takes the focus once. */
const justInserted = new Set<string>();
/** Bookmarks whose details are being fetched in this tab, so a block fetches once at a time. */
const fetching = new Set<string>();

type AnyEditor = { isEditable: boolean };

/** Whether this viewer may change the block: the editor is editable and the page allows it. */
function useCanEdit(editor: AnyEditor) {
  const host = useEmbedHost();
  return Boolean(host?.editable && editor.isEditable);
}

/** The field where a new bookmark or embed gets its URL. */
function UrlForm({
  blockId,
  kind,
  onSubmit,
}: {
  blockId: string;
  kind: "bookmark" | "embed";
  onSubmit: (url: string) => void;
}) {
  const t = useTranslations("page.web");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focus] = useState(() => justInserted.delete(blockId));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = parseWebUrl(value);
    if (!url) {
      setError(t("invalidUrl"));
      return;
    }
    onSubmit(url.href);
  };
  return (
    // The browser's own URL check would refuse "example.com"; parseWebUrl accepts it.
    <form onSubmit={submit} noValidate className="w-full">
      <div className="flex w-full items-center gap-2 rounded-md border border-border bg-bg-subtle px-3 py-1.5">
        {kind === "bookmark" ? <Bookmark className="h-4 w-4 shrink-0 text-fg-muted" /> : <MonitorPlay className="h-4 w-4 shrink-0 text-fg-muted" />}
        <input
          autoFocus={focus}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          type="url"
          inputMode="url"
          placeholder={t(kind === "bookmark" ? "bookmark.placeholder" : "embed.placeholder")}
          aria-label={t(kind === "bookmark" ? "bookmark.placeholder" : "embed.placeholder")}
          className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
        <button type="submit" className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90">
          {t(kind === "bookmark" ? "bookmark.submit" : "embed.submit")}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
      {kind === "embed" && !error && <p className="mt-1 text-xs text-fg-faint">{t("embed.providers")}</p>}
    </form>
  );
}

/** Puts the cursor in the block after `blockId` (adding a paragraph when there is none). */
function moveCursorAfter(editor: PageEditor, blockId: string) {
  if (!editor.getBlock(blockId)) return;
  const next = editor.getNextBlock(blockId) ?? editor.insertBlocks([{ type: "paragraph" }], blockId, "after")[0];
  editor.setTextCursorPosition(next, "start");
  editor.focus();
}

// ---------------------------------------------------------------------------------------------
// Bookmark

/**
 * The handle on the end edge of a bookmark card, an embed or a file shown in place that makes it
 * narrower or wider, as images have: the box follows the pointer, and letting go stores the width
 * (a share of the column, lib/media-blocks mediaWidth) as one change of the block.
 */
export function MediaResizeHandle({
  card,
  label,
  onDrag,
  onDone,
}: {
  card: RefObject<HTMLDivElement | null>;
  label: string;
  onDrag: (width: number | null) => void;
  onDone: (width: number | null) => void;
}) {
  const widthAt = (clientX: number) => {
    const element = card.current;
    const column = element?.parentElement;
    if (!element || !column) return null;
    const box = element.getBoundingClientRect();
    const span = isRtl(element) ? box.right - clientX : clientX - box.left;
    return mediaWidth((span / column.clientWidth) * 100);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        let last: number | null = widthAt(event.clientX);
        const move = (e: PointerEvent) => {
          last = widthAt(e.clientX);
          onDrag(last);
        };
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
          onDone(last);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
      }}
      className={cn(
        "absolute inset-y-0 -end-3 flex w-3 cursor-ew-resize touch-none items-center justify-center",
        "opacity-0 transition-opacity group-hover/bookmark:opacity-100",
      )}
    >
      <span className="h-10 max-h-[70%] w-1.5 rounded-full border border-bg bg-fg-muted shadow-sm" />
    </div>
  );
}

const BookmarkBlock = createReactBlockSpec(bookmarkBlockConfig, {
  meta: { selectable: false },
  render: function BookmarkBlockView({ block, editor: anyEditor }) {
    const t = useTranslations("page.web");
    const editor = anyEditor as unknown as PageEditor;
    const host = useEmbedHost();
    const canEdit = useCanEdit(anyEditor);
    const { url, fetchedAt } = block.props;
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The width while the card's edge is dragged; undefined when not dragging.
    const [dragWidth, setDragWidth] = useState<number | null | undefined>(undefined);
    const card = useRef<HTMLDivElement>(null);
    const width = dragWidth === undefined ? bookmarkWidth(block.props.width) : dragWidth;

    const refresh = useCallback(async () => {
      if (!host || !url || fetching.has(block.id)) return;
      fetching.add(block.id);
      setLoading(true);
      setError(null);
      try {
        const res = await fetchLinkPreviewAction(host.pageId, url);
        const current = editor.getBlock(block.id);
        // The block may have gone, or point elsewhere now.
        if (!current || current.type !== BOOKMARK_BLOCK || current.props.url !== url) return;
        if (res.ok) {
          editor.updateBlock(block.id, { props: { ...res.data, url } });
        } else {
          setError(res.error);
          // Tried: don't fetch again on every visit; "Refresh" tries again.
          if (!current.props.fetchedAt) editor.updateBlock(block.id, { props: { fetchedAt: new Date().toISOString() } });
        }
      } catch {
        setError(t("errors.unreachable"));
      } finally {
        fetching.delete(block.id);
        setLoading(false);
      }
    }, [host, url, block.id, editor, t]);

    // A bookmark written without its details (just made, or written as Markdown by MCP) gets them
    // the first time someone who may edit the page sees it.
    useEffect(() => {
      if (canEdit && url && !fetchedAt) void refresh();
    }, [canEdit, url, fetchedAt, refresh]);

    if (!url) {
      if (!canEdit) return null;
      return (
        <div contentEditable={false} className="w-full">
          <UrlForm
            blockId={block.id}
            kind="bookmark"
            onSubmit={(next) => {
              editor.updateBlock(block.id, { props: { url: next, title: "", description: "", image: "", favicon: "", siteName: "", fetchedAt: "" } });
              moveCursorAfter(editor, block.id);
            }}
          />
        </div>
      );
    }

    return (
      <div contentEditable={false} className="w-full">
        <div ref={card} data-media-box="" className="group/bookmark relative max-w-full" style={{ width: width ? `${width}%` : "100%" }}>
          {loading && !block.props.title ? (
            <div className="flex w-full flex-col gap-1 rounded-md border border-border px-3.5 py-3 text-sm">
              <span className="text-fg-muted">{t("bookmark.loading")}</span>
              <span className="truncate text-xs text-fg-faint">{displayHost(url)}</span>
            </div>
          ) : (
            <BookmarkCard bookmark={{ ...block.props, width: null }} />
          )}
          {canEdit && (
            <MediaResizeHandle
              card={card}
              label={t("bookmark.resize")}
              onDrag={setDragWidth}
              onDone={(next) => {
                setDragWidth(undefined);
                if (next !== bookmarkWidth(block.props.width)) editor.updateBlock(block.id, { props: { width: next ?? 0 } });
              }}
            />
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label={t("bookmark.refresh")}
              title={t("bookmark.refresh")}
              className={cn(
                "absolute inset-e-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-bg text-fg-muted shadow-sm hover:bg-bg-hover hover:text-fg",
                "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/bookmark:opacity-100",
                loading && "opacity-100",
              )}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  },
  toExternalHTML: ({ block }) => (
    <p>
      <a href={parseWebUrl(block.props.url)?.href}>{block.props.title || block.props.url}</a>
    </p>
  ),
});

// ---------------------------------------------------------------------------------------------
// Embed

const WebEmbedBlock = createReactBlockSpec(webEmbedBlockConfig, {
  meta: { selectable: false },
  render: function WebEmbedBlockView({ block, editor: anyEditor }) {
    const t = useTranslations("page.web");
    const editor = anyEditor as unknown as PageEditor;
    const canEdit = useCanEdit(anyEditor);
    const url = parseWebUrl(block.props.url)?.href ?? "";
    const embed = useMemo(() => embedFor(url), [url]);
    // The width while the frame's edge is dragged; undefined when not dragging.
    const [dragWidth, setDragWidth] = useState<number | null | undefined>(undefined);
    const box = useRef<HTMLDivElement>(null);
    const width = dragWidth === undefined ? mediaWidth(block.props.width) : dragWidth;

    if (!url) {
      if (!canEdit) return null;
      return (
        <div contentEditable={false} className="w-full">
          <UrlForm
            blockId={block.id}
            kind="embed"
            onSubmit={(next) => {
              // Sites that can't be embedded become a bookmark instead.
              if (embedFor(next)) editor.updateBlock(block.id, { props: { url: next } });
              else editor.updateBlock(block.id, { type: BOOKMARK_BLOCK, props: { url: next } });
              moveCursorAfter(editor, block.id);
            }}
          />
        </div>
      );
    }
    return (
      <div contentEditable={false} className="w-full">
        <div ref={box} data-media-box="" className="group/bookmark relative max-w-full" style={{ width: width ? `${width}%` : "100%" }}>
          {embed ? (
            <EmbedFrame url={url} embed={embed} title={t("embed.frameTitle", { host: displayHost(url) })} />
          ) : (
            <BookmarkCard bookmark={{ url, title: "", description: "", image: "", favicon: "" }} />
          )}
          {canEdit && (
            <MediaResizeHandle
              card={box}
              label={t("embed.resize")}
              onDrag={setDragWidth}
              onDone={(next) => {
                setDragWidth(undefined);
                if (next !== mediaWidth(block.props.width)) editor.updateBlock(block.id, { props: { width: next ?? 0 } });
              }}
            />
          )}
        </div>
      </div>
    );
  },
  toExternalHTML: ({ block }) => (
    <p>
      <a href={parseWebUrl(block.props.url)?.href}>{block.props.url}</a>
    </p>
  ),
});

export const webBlockSpecs = {
  bookmark: BookmarkBlock(),
  webEmbed: WebEmbedBlock(),
};

// ---------------------------------------------------------------------------------------------
// Slash menu

/** "Web bookmark" and "Embed" in the slash menu, with BlockNote's media blocks. */
export function useWebSlashItems(editor: PageEditor): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.web");
  const host = useEmbedHost();
  return useMemo(() => {
    if (!host?.editable) return [];
    const group = editor.dictionary.slash_menu.image.group;
    const insert = (type: typeof BOOKMARK_BLOCK | typeof WEB_EMBED_BLOCK) => {
      const block = insertOrUpdateBlockForSlashMenu(editor, { type });
      justInserted.add(block.id);
      if (!editor.getNextBlock(block.id)) editor.insertBlocks([{ type: "paragraph" }], block.id, "after");
    };
    return [
      {
        title: t("bookmark.title"),
        subtext: t("bookmark.subtext"),
        aliases: t("bookmark.aliases").split(" "),
        group,
        icon: <Bookmark size={18} />,
        onItemClick: () => insert(BOOKMARK_BLOCK),
      },
      {
        title: t("embed.title"),
        subtext: t("embed.subtext"),
        aliases: t("embed.aliases").split(" "),
        group,
        icon: <MonitorPlay size={18} />,
        onItemClick: () => insert(WEB_EMBED_BLOCK),
      },
    ];
  }, [editor, host, t]);
}

// ---------------------------------------------------------------------------------------------
// Pasting a link

/**
 * A link just pasted: in block `blockId`, from `from` (a document position) on. `line`: it is
 * the whole line, so it may also become a bookmark or an embed; else only a mention.
 */
type PastedLink = { blockId: string; url: string; from: number; line: boolean; top: number; left: number };
type PasteChoice = "bookmark" | "embed" | "mention" | "keep";

/** Whether the document holds `url` as text from `from` on (the paste landed there). */
function holdsAt(editor: PageEditor, from: number, url: string) {
  const doc = editor.prosemirrorState.doc;
  const to = from + url.length;
  return to <= doc.content.size && doc.textBetween(from, to, "\n", "\ufffc") === url;
}

/** Whether a block is a paragraph holding exactly `url` (as a link or as text). */
function holdsOnly(editor: PageEditor, blockId: string, url: string) {
  const block = editor.getBlock(blockId);
  if (!block || block.type !== "paragraph" || !Array.isArray(block.content)) return false;
  const text = block.content
    .map((node) => (node.type === "text" ? node.text : node.type === "link" ? node.content.map((c) => c.text).join("") : "￼"))
    .join("")
    .trim();
  return text === url;
}

/**
 * After a lone URL is pasted into an empty line, offers to turn it into a bookmark, an embed or a
 * mention (or leave it a link); pasted within text, a mention (link-mention-toolbar.tsx) or a link. The
 * paste itself happens as usual; the menu only changes the block afterwards.
 * Arrow keys pick an option and Enter takes it; any other key, a click elsewhere or scrolling
 * closes the menu and leaves the link.
 */
export function PasteLinkMenu({ editor }: { editor: PageEditor }) {
  const t = useTranslations("page.web.paste");
  const canEdit = useCanEdit(editor);
  const [pasted, setPasted] = useState<PastedLink | null>(null);
  const [active, setActive] = useState(-1);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canEdit) return;
    const onPaste = (event: ClipboardEvent) => {
      const root = editor.domElement;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      // A page of this app becomes a mention instead (see components/page/mentions.tsx).
      if (!isLoneUrl(text) || linkedPageRef(text.trim(), window.location.origin)) return;
      const cursor = editor.getTextCursorPosition().block;
      const selection = editor.prosemirrorState.selection;
      // Text only: not code, where a link is just text, and not a table cell.
      if (!selection.empty || !Array.isArray(cursor.content) || cursor.type === "codeBlock") return;
      const line = cursor.type === "paragraph" && cursor.content.length === 0;
      const url = text.trim();
      const blockId = cursor.id;
      const from = selection.from;
      // Let the paste land first, then offer the menu under the new link.
      setTimeout(() => {
        if (!holdsAt(editor, from, url) || (line && !holdsOnly(editor, blockId, url))) return;
        const element = root.querySelector(`[data-node-type="blockOuter"][data-id="${CSS.escape(blockId)}"]`);
        if (!element) return;
        const rtl = isRtl(element);
        let rect: { top: number; bottom: number; left: number; right: number } = element.getBoundingClientRect();
        // Within text, under the link's end.
        if (!line) rect = editor.prosemirrorView.coordsAtPos(from + url.length);
        setActive(-1);
        // From the start edge (the right edge right to left; the menu is 224px).
        setPasted({ blockId, url, from, line, top: rect.bottom + 4, left: rtl ? rect.right - 224 : rect.left });
      });
    };
    document.addEventListener("paste", onPaste, true);
    return () => document.removeEventListener("paste", onPaste, true);
  }, [editor, canEdit]);

  const embeddable = pasted ? embedFor(pasted.url) !== null : false;
  const line = pasted?.line ?? false;
  const options = useMemo(() => {
    const list: { key: PasteChoice; icon: React.JSX.Element }[] = [];
    if (line) list.push({ key: "bookmark", icon: <Bookmark className="h-4 w-4" /> });
    if (line && embeddable) list.push({ key: "embed", icon: <MonitorPlay className="h-4 w-4" /> });
    list.push({ key: "mention", icon: <AtSign className="h-4 w-4" /> });
    list.push({ key: "keep", icon: <Link2 className="h-4 w-4" /> });
    return list;
  }, [embeddable, line]);

  const choose = useCallback(
    (key: PasteChoice) => {
      const current = pasted;
      setPasted(null);
      if (!current || key === "keep" || !holdsAt(editor, current.from, current.url)) return;
      if (key === "mention") {
        linkToMention(editor, current.from, current.from + current.url.length, current.url);
        return;
      }
      const url = parseWebUrl(current.url)?.href;
      if (!url || !current.line || !holdsOnly(editor, current.blockId, current.url)) return;
      editor.updateBlock(current.blockId, key === "embed" ? { type: WEB_EMBED_BLOCK, props: { url } } : { type: BOOKMARK_BLOCK, props: { url } });
      moveCursorAfter(editor, current.blockId);
    },
    [editor, pasted],
  );

  useEffect(() => {
    if (!pasted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i < 0 ? (step > 0 ? 0 : options.length - 1) : (i + step + options.length) % options.length));
        return;
      }
      if (event.key === "Enter" && active >= 0) {
        event.preventDefault();
        event.stopPropagation();
        choose(options[active].key);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      setPasted(null);
    };
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setPasted(null);
    };
    const close = () => setPasted(null);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointer, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pasted, active, options, choose]);

  if (!pasted) return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("label")}
      style={{ top: pasted.top, left: Math.max(8, Math.min(pasted.left, window.innerWidth - 232)) }}
      className="fixed z-50 w-56 rounded-md border border-border bg-bg p-1 text-sm shadow-lg"
    >
      <p className="px-2 pb-1 pt-0.5 text-xs text-fg-muted">{t("label")}</p>
      {options.map((option, i) => (
        <button
          key={option.key}
          type="button"
          role="menuitem"
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => choose(option.key)}
          className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-fg", i === active && "bg-bg-hover")}
        >
          <span className="text-fg-muted">{option.icon}</span>
          {t(option.key)}
        </button>
      ))}
    </div>,
    document.body,
  );
}
