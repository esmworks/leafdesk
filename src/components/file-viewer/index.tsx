"use client";

import { lazy, Suspense, useCallback, useState, type MouseEvent, type ReactNode } from "react";
import type { UrlKind } from "@/lib/file-viewer";
import { FILE_ROUTE, fileIdOf, fileUrl } from "@/lib/files";

/**
 * Opening uploaded files in the file viewer (./file-viewer.tsx), an overlay that shows a file of
 * any kind without downloading it, with the other files of the same page or value a key away.
 *
 * The viewer's code (and the readers it brings: Markdown, code colors) loads the first time a file
 * is opened. Whatever opens it hands over the files in the order the page shows them and which one
 * to start at; places that can't (serialized HTML on published pages) mark nothing and let
 * FileViewerArea find the files in the DOM.
 */

/**
 * A file the viewer shows: its URL (`/api/files/<id>`), name, stored type when known, and what the
 * place it opens from shows it as (an image block, a PDF viewer), when that is one of the kinds the
 * viewer can show before asking the file route (see lib/file-viewer knownFormat).
 */
export type ViewerFile = { url: string; name: string; type?: string; shows?: UrlKind };

const FileViewer = lazy(() => import("./file-viewer"));

/** Opens the viewer; `element` is what to render while it is open (it portals itself to the body). */
export function useFileViewer() {
  const [shown, setShown] = useState<{ files: ViewerFile[]; index: number } | null>(null);
  const open = useCallback((files: ViewerFile[], index = 0) => {
    if (files.length) setShown({ files, index: Math.min(Math.max(index, 0), files.length - 1) });
  }, []);
  const close = useCallback(() => setShown(null), []);
  const element = shown ? (
    <Suspense fallback={null}>
      <FileViewer files={shown.files} start={shown.index} onClose={close} />
    </Suspense>
  ) : null;
  return { open, element };
}

/** The `/api/files/<id>` path of a same-origin uploaded file's URL; null for anything else. */
export function uploadedPath(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url, location.href);
  } catch {
    return null;
  }
  if (parsed.origin !== location.origin || !parsed.pathname.startsWith(`${FILE_ROUTE}/`)) return null;
  const id = fileIdOf(parsed.pathname);
  return id ? fileUrl(id) : null;
}

/** Whether a click is a plain one (no modifier, main button): others keep a link's own meaning. */
export const plainClick = (event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** Elements that show an uploaded file, in what FileViewerArea and data-file-view buttons read. */
const SHOWS_FILE = "[data-file-url], img[src], video[src], audio[src], a[href]";

/** The file an element shows (see SHOWS_FILE), or null. */
function fileOf(element: Element): ViewerFile | null {
  const attr = (name: string) => element.getAttribute(name);
  const url = uploadedPath(attr("data-file-url") ?? attr("src") ?? attr("href"));
  if (!url) return null;
  const name =
    attr("data-file-name") ??
    (element.closest("[data-name]")?.getAttribute("data-name") || attr("alt") || (element.tagName === "A" ? element.textContent?.trim() : "") || "");
  return { url, name, shows: element.hasAttribute("data-leafdesk-pdf") ? "pdf" : SHOWN_AS[element.tagName] };
}

/** What an element showing a file shows it as (a PDF viewer is marked `data-leafdesk-pdf`). */
const SHOWN_AS: Record<string, UrlKind | undefined> = { IMG: "image", VIDEO: "video", AUDIO: "audio" };

/** The uploaded files `root` shows, in document order, each once. */
export function filesIn(root: Element): ViewerFile[] {
  const seen = new Set<string>();
  const files: ViewerFile[] = [];
  for (const element of root.querySelectorAll(SHOWS_FILE)) {
    const file = fileOf(element);
    if (!file || seen.has(file.url)) continue;
    seen.add(file.url);
    files.push(file);
  }
  return files;
}

/**
 * Opens files shown in its content (serialized HTML on published pages): an uploaded image, a link
 * to an uploaded file and anything marked `data-file-view="<url>"` (the PDF and workbook viewers'
 * buttons) open the viewer, with every file the area shows to go through. A click with a modifier
 * keeps its usual meaning (a link opens in a new tab).
 */
export function FileViewerArea({ children, className }: { children: ReactNode; className?: string }) {
  const viewer = useFileViewer();
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const root = event.currentTarget;
    const opened = openedFile(event, root);
    if (!opened) return;
    event.preventDefault();
    const files = filesIn(root);
    const index = files.findIndex((f) => f.url === opened.url);
    viewer.open(index < 0 ? [opened, ...files] : files, Math.max(index, 0));
  };
  return (
    <div className={className} onClick={onClick}>
      {children}
      {viewer.element}
    </div>
  );
}

/** The file a click inside `root` opens: on an uploaded image, a link to one, or a data-file-view button. */
export function openedFile(event: MouseEvent, root: Element, { links = true }: { links?: boolean } = {}): ViewerFile | null {
  if (!plainClick(event) || !(event.target instanceof Element) || !root.contains(event.target)) return null;
  const button = event.target.closest("[data-file-view]");
  if (button && root.contains(button)) {
    const url = uploadedPath(button.getAttribute("data-file-view"));
    return url ? { url, name: button.getAttribute("data-file-name") ?? "" } : null;
  }
  const found = event.target.closest(links ? "img[src], a[href]" : "img[src]");
  // An image in a link (lib/image-links) follows the link, unless that link is to a file too.
  const link = found?.tagName === "IMG" ? found.closest("a[href]") : null;
  const shown = link && root.contains(link) ? link : found;
  return shown && root.contains(shown) ? fileOf(shown) : null;
}
