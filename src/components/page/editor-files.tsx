"use client";

import { useEditorDOMElement, useEditorSelectionChange } from "@blocknote/react";
import { Link2, Maximize2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { plainClick, uploadedPath, useFileViewer, type ViewerFile } from "@/components/file-viewer";
import type { UrlKind } from "@/lib/file-viewer";
import { pdfFileId } from "@/lib/files";
import { parseImageLink, type ImageLink } from "@/lib/image-links";
import type { PageEditor } from "./embed-blocks";

/**
 * The file viewer in the editor (components/file-viewer): it opens at a file of the page and goes
 * through all of them (images, video, audio and file blocks, in the page's order, columns included).
 *
 * A file block's name and the PDF and workbook viewers' expand buttons open it (they carry
 * `data-file-view`). An image opens with a click where the page can't be edited; where it can, a
 * click selects the image (to resize it, caption it or replace it), so an expand button shows over
 * the image under the pointer or selected, and a double click opens it too.
 *
 * An image that links somewhere (lib/image-links) gets a link button beside it the same way, and
 * where the page can't be edited a click on it follows the link instead of opening the viewer.
 */

type Block = { id: string; type: string; props: Record<string, unknown>; children?: Block[] };

const FILE_BLOCKS = new Set(["image", "video", "audio", "file"]);

/** What a file block shows its file as: its own kind, or a file block's PDF viewer (as file-block.tsx decides). */
function shownAs(block: Block, name: string): UrlKind | undefined {
  if (block.type === "image" || block.type === "video" || block.type === "audio") return block.type;
  return pdfFileId(block.props.url, name) ? "pdf" : undefined;
}

/** The uploaded files the editor's blocks show, in document order, each with the block showing it. */
function editorFiles(blocks: Block[]): (ViewerFile & { blockId: string })[] {
  const found: (ViewerFile & { blockId: string })[] = [];
  const seen = new Set<string>();
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (FILE_BLOCKS.has(block.type)) {
        const url = typeof block.props.url === "string" && block.props.url.trim().startsWith("/") ? uploadedPath(block.props.url) : null;
        if (url && !seen.has(url)) {
          seen.add(url);
          const name = typeof block.props.name === "string" ? block.props.name : "";
          found.push({ url, name, shows: shownAs(block, name), blockId: block.id });
        }
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return found;
}

/** The link of the image block `image` is the picture of, if it has one. */
function linkOfImage(editor: PageEditor, image: HTMLImageElement): ImageLink | null {
  const id = image.closest("[data-id]")?.getAttribute("data-id");
  const block = id ? editor.getBlock(id) : undefined;
  return block?.type === "image" ? parseImageLink((block.props as { link?: unknown }).link) : null;
}

/** The image of an image block an element is in (the picture itself, not its caption), or null. */
const imageOf = (element: Element | null) => {
  const block = element?.closest('[data-content-type="image"]');
  const image = block?.querySelector<HTMLImageElement>("img.bn-visual-media");
  return image && element && (element === image || image.parentElement?.contains(element)) ? image : null;
};

export function EditorFiles({ editor, editable }: { editor: PageEditor; editable: boolean }) {
  const t = useTranslations("page.viewer");
  const tl = useTranslations("page.imageLink");
  const router = useRouter();
  const root = useEditorDOMElement(editor);
  const viewer = useFileViewer();
  const [hovered, setHovered] = useState<HTMLImageElement | null>(null);
  const [selected, setSelected] = useState<HTMLImageElement | null>(null);

  /** Opens the viewer at the file `url` (or a block's), with every file of the page. */
  const openAt = useCallback(
    (url: string | null, blockId?: string) => {
      const files = editorFiles(editor.document as Block[]);
      const index = files.findIndex((f) => (blockId ? f.blockId === blockId : f.url === url));
      if (index >= 0) viewer.open(files, index);
      else if (url) viewer.open([{ url, name: "" }], 0);
    },
    [editor, viewer],
  );

  /** Follows an image's link: a page of the app here, a web address in a new tab. */
  const follow = useCallback(
    (link: ImageLink) => {
      if (link.kind === "page") router.push(link.href);
      else window.open(link.href, "_blank", "noopener,noreferrer");
    },
    [router],
  );

  // Ours are the clicks in this editor, not in a synced page's editor inside it.
  const own = useCallback((target: EventTarget | null): Element | null => {
    if (!(target instanceof Element) || !root) return null;
    return target.closest(".bn-editor") === root ? target : null;
  }, [root]);

  useEffect(() => {
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      const target = own(event.target);
      if (!target || !plainClick(event)) return;
      const button = target.closest("[data-file-view]");
      if (button) {
        event.preventDefault();
        openAt(uploadedPath(button.getAttribute("data-file-view")));
        return;
      }
      const image = !editor.isEditable ? imageOf(target) : null;
      const link = image ? linkOfImage(editor, image) : null;
      if (link) {
        event.preventDefault();
        follow(link);
        return;
      }
      if (image) {
        event.preventDefault();
        openAt(uploadedPath(image.getAttribute("src")), image.closest("[data-id]")?.getAttribute("data-id") ?? undefined);
      }
    };
    const onDoubleClick = (event: MouseEvent) => {
      const image = imageOf(own(event.target));
      if (!image || !editor.isEditable) return;
      event.preventDefault();
      openAt(uploadedPath(image.getAttribute("src")), image.closest("[data-id]")?.getAttribute("data-id") ?? undefined);
    };
    const onOver = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-editor-image-expand]")) return;
      setHovered(imageOf(own(event.target)));
    };
    const onLeave = (event: MouseEvent) => {
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-editor-image-expand]")) return;
      setHovered(null);
    };
    root.addEventListener("click", onClick);
    root.addEventListener("dblclick", onDoubleClick);
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseleave", onLeave);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("dblclick", onDoubleClick);
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseleave", onLeave);
    };
  }, [root, editor, own, openAt, follow]);

  // A selected image block (a tap on a touch screen selects it) gets the button too.
  useEditorSelectionChange(() => {
    if (!root) return;
    const block = editor.getTextCursorPosition().block as Block;
    const image = block.type === "image" ? root.querySelector<HTMLImageElement>(`[data-id="${CSS.escape(block.id)}"] img.bn-visual-media`) : null;
    setSelected(image);
  }, editor);

  const target = hovered ?? selected;
  const expandable = target && editable && uploadedPath(target.getAttribute("src")) ? target : null;
  const link = target ? linkOfImage(editor, target) : null;
  const expand = (image: HTMLImageElement) => {
    // The button goes when the pointer leaves it: focus comes back to the editor on close instead.
    if (!editor.domElement?.contains(document.activeElement)) editor.focus();
    openAt(uploadedPath(image.getAttribute("src")), image.closest("[data-id]")?.getAttribute("data-id") ?? undefined);
  };
  return (
    <>
      {target && (expandable || link) && (
        <ImageButtons
          image={target}
          buttons={[
            ...(link ? [{ key: "link", label: tl("open"), icon: <Link2 className="h-3.5 w-3.5" aria-hidden />, onClick: () => follow(link) }] : []),
            ...(expandable ? [{ key: "expand", label: t("expand"), icon: <Maximize2 className="h-3.5 w-3.5" aria-hidden />, onClick: () => expand(target) }] : []),
          ]}
          onLeave={(to) => !(to && to === target) && setHovered(null)}
        />
      )}
      {viewer.element}
    </>
  );
}

type ImageButton = { key: string; label: string; icon: ReactNode; onClick: () => void };

/** The link and expand buttons at the top corner of an image, following it as the page scrolls. */
function ImageButtons({ image, buttons, onLeave }: { image: HTMLImageElement; buttons: ImageButton[]; onLeave: (to: EventTarget | null) => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRect(image.isConnected ? image.getBoundingClientRect() : null));
    };
    setRect(image.getBoundingClientRect());
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(image);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [image]);
  if (!rect || rect.width < 48 || rect.height < 40) return null;
  const rtl = getComputedStyle(image).direction === "rtl";
  const width = buttons.length * 28 + (buttons.length - 1) * 4;
  return createPortal(
    <div
      data-editor-image-expand=""
      onMouseLeave={(event) => onLeave(event.relatedTarget)}
      className="fixed z-30 flex gap-1"
      style={{ top: rect.top + 8, left: rtl ? rect.left + 8 : rect.right - 8 - width }}
    >
      {buttons.map((button) => (
        <button
          key={button.key}
          type="button"
          aria-label={button.label}
          title={button.label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={button.onClick}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white shadow transition-colors hover:bg-black/80"
        >
          {button.icon}
        </button>
      ))}
    </div>,
    document.body,
  );
}
