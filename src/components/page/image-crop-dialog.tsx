"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";
import { dragCrop, formatImageCrop, isWholeImage, parseImageCrop, type CropHandle, type ImageCrop } from "@/lib/image-crop";
import { IMAGE_BLOCK } from "@/lib/image-links";
import type { PageEditor } from "./embed-blocks";

/**
 * The crop dialog of an image block (opened from its block menu, image-crop-item.tsx): the whole
 * image with a frame over the part to show. The frame moves by dragging it or with the arrow keys,
 * and resizes from its edges and corners or with Shift and the arrow keys. Saving writes the
 * block's `crop` prop (lib/image-crop); the file itself is never changed.
 */

const HANDLES: Exclude<CropHandle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// Sides of the image, so left and right whatever the text's direction (the image isn't mirrored).
const HANDLE_PLACE: Record<Exclude<CropHandle, "move">, string> = {
  nw: "-left-1.5 -top-1.5 cursor-nwse-resize",
  n: "left-1/2 -top-1.5 -translate-x-1/2 cursor-ns-resize",
  ne: "-right-1.5 -top-1.5 cursor-nesw-resize",
  e: "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize",
  se: "-right-1.5 -bottom-1.5 cursor-nwse-resize",
  s: "left-1/2 -bottom-1.5 -translate-x-1/2 cursor-ns-resize",
  sw: "-left-1.5 -bottom-1.5 cursor-nesw-resize",
  w: "-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize",
};

/** The image's address as the editor shows it (resolved the way the block resolved it), or its prop. */
function shownUrl(editor: PageEditor, blockId: string, url: string): string {
  const img = editor.domElement?.querySelector<HTMLImageElement>(`[data-id="${CSS.escape(blockId)}"] img.bn-visual-media`);
  return img?.currentSrc || img?.src || url;
}

export default function ImageCropDialog({ editor, blockId, onClose }: { editor: PageEditor; blockId: string; onClose: () => void }) {
  const t = useTranslations("page.imageCrop");
  const tc = useTranslations("common");
  const block = editor.getBlock(blockId);
  const props = (block?.type === IMAGE_BLOCK ? block.props : {}) as { url?: string; crop?: string; previewWidth?: number };
  const url = props.url ?? "";
  const [src] = useState(() => (url ? shownUrl(editor, blockId, url) : ""));
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [crop, setCrop] = useState<ImageCrop | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: CropHandle; x: number; y: number; start: ImageCrop } | null>(null);

  // The crop it had, once the image's shape is known (a crop's own ratio is the file's).
  useEffect(() => {
    if (ratio === null) return;
    const stored = parseImageCrop(props.crop);
    setCrop(stored ? { ...stored, ar: ratio } : { x: 0, y: 0, w: 1, h: 1, ar: ratio });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the image is in
  }, [ratio]);

  const save = () => {
    const current = editor.getBlock(blockId);
    if (crop && current?.type === IMAGE_BLOCK) {
      const next: Record<string, unknown> = { crop: formatImageCrop(crop) };
      // Shown as wide as before: an image without a width of its own would take the whole line.
      if (!current.props.previewWidth) {
        const shown = editor.domElement?.querySelector<HTMLElement>(`[data-id="${CSS.escape(blockId)}"] .bn-file-block-content-wrapper`);
        const width = Math.round(shown?.getBoundingClientRect().width ?? 0);
        if (width > 0) next.previewWidth = width;
      }
      editor.updateBlock(blockId, { props: next } as never);
    }
    onClose();
  };

  const onPointerDown = (handle: CropHandle) => (event: PointerEvent) => {
    if (!crop || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { handle, x: event.clientX, y: event.clientY, start: crop };
  };
  const onPointerMove = (event: PointerEvent) => {
    const rect = area.current?.getBoundingClientRect();
    if (!drag.current || !rect?.width || !rect.height) return;
    const dx = (event.clientX - drag.current.x) / rect.width;
    const dy = (event.clientY - drag.current.y) / rect.height;
    setCrop(dragCrop(drag.current.start, drag.current.handle, dx, dy));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!crop) return;
    const step = 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setCrop(dragCrop(crop, event.shiftKey ? "se" : "move", move[0], move[1]));
  };

  const whole = !crop || isWholeImage(crop);
  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader title={t("title")} description={t("hint")} onClose={onClose} closeLabel={tc("close")} />
      <DialogBody>
        <div className="flex min-h-40 items-center justify-center rounded-md bg-bg-subtle p-3">
          {failed || !src ? (
            <p role="alert" className="text-sm text-danger">
              {t("failed")}
            </p>
          ) : (
            <div ref={area} dir="ltr" className="relative touch-none select-none" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
              <img
                src={src}
                alt=""
                draggable={false}
                className="block max-h-[55vh] max-w-full"
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                  if (w > 0 && h > 0) setRatio(w / h);
                  else setFailed(true);
                }}
                onError={() => setFailed(true)}
              />
              {ratio === null && <p className="absolute inset-0 flex items-center justify-center text-sm text-fg-muted">{t("loading")}</p>}
              {crop && (
                // Everything outside the frame darkened, kept to the image.
                <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                  <div
                    className="absolute"
                    style={{
                      left: `${crop.x * 100}%`,
                      top: `${crop.y * 100}%`,
                      width: `${crop.w * 100}%`,
                      height: `${crop.h * 100}%`,
                      boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.55)",
                    }}
                  />
                </div>
              )}
              {crop && (
                <div
                  role="group"
                  tabIndex={0}
                  aria-label={t("frame")}
                  onKeyDown={onKeyDown}
                  onPointerDown={onPointerDown("move")}
                  className="absolute cursor-move outline-none ring-1 ring-white focus-visible:ring-2 focus-visible:ring-accent"
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.w * 100}%`,
                    height: `${crop.h * 100}%`,
                  }}
                >
                  {/* Thirds, to line things up. */}
                  <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/3 h-1/3 border-y border-white/40" />
                  <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/3 w-1/3 border-x border-white/40" />
                  {HANDLES.map((handle) => (
                    <span
                      key={handle}
                      aria-hidden
                      onPointerDown={onPointerDown(handle)}
                      className={cn("absolute h-3 w-3 rounded-sm border border-black/40 bg-white", HANDLE_PLACE[handle])}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" className="me-auto" disabled={!crop || whole} onClick={() => crop && setCrop({ x: 0, y: 0, w: 1, h: 1, ar: crop.ar })}>
          {t("reset")}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button type="button" variant="primary" disabled={!crop} onClick={save}>
          {tc("save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
