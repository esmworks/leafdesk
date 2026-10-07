"use client";

import { ImageUp, MoveVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { uploadToPage, useUploadErrorMessage } from "@/components/database/files-cell";
import { Button, cn, Input, Popover } from "@/components/ui";
import {
  COVER_GRADIENT_NAMES,
  COVER_GRADIENTS,
  coverImageUrl,
  coverObjectPosition,
  DEFAULT_COVER_Y,
  type PageCover,
} from "@/lib/page-cover";

/** A gradient to start from when someone adds a cover: they change it from the cover itself. */
export function randomCover(): PageCover {
  const names = COVER_GRADIENT_NAMES;
  return { kind: "gradient", gradient: names[Math.floor(Math.random() * names.length)] };
}

/**
 * The picture at the top of a page, across the whole width of the content area. People who may
 * edit change it, remove it, or (for an image) drag it to show another band of it.
 */
export function PageCoverBanner({
  cover,
  pageId,
  editable,
  onChange,
}: {
  cover: PageCover;
  pageId: string;
  editable: boolean;
  onChange: (cover: PageCover | null) => void;
}) {
  const t = useTranslations("page.cover");
  const [repositioning, setRepositioning] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ startY: number; startPos: number; overflow: number } | null>(null);

  const isImage = cover.kind === "image";
  const y = repositioning ?? (isImage ? cover.y : DEFAULT_COVER_Y);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (repositioning === null || !image.current || !frame.current) return;
    const { naturalWidth, naturalHeight } = image.current;
    const { width, height } = frame.current.getBoundingClientRect();
    // object-fit: cover scales the image to the frame's width when it is taller than the frame;
    // the part that doesn't fit is what dragging moves through.
    const overflow = naturalWidth ? (width * naturalHeight) / naturalWidth - height : 0;
    if (overflow <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startPos: repositioning, overflow };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const next = d.startPos - ((event.clientY - d.startY) / d.overflow) * 100;
    setRepositioning(Math.min(100, Math.max(0, Math.round(next * 10) / 10)));
  }

  return (
    // The controls sit outside the clipped frame, so the cover picker can open below the cover.
    <div className="group/cover relative w-full">
      <div
        ref={frame}
        className={cn(
          "relative h-[30vh] max-h-72 min-h-32 w-full overflow-hidden bg-bg-subtle max-md:h-40 max-md:min-h-0",
          repositioning !== null && "cursor-grab touch-none select-none active:cursor-grabbing",
        )}
        style={cover.kind === "gradient" ? { background: COVER_GRADIENTS[cover.gradient] } : undefined}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {isImage && failed !== cover.url && (
          <img
            ref={image}
            src={cover.url}
            alt=""
            draggable={false}
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
            style={{ objectPosition: coverObjectPosition(y) }}
            onError={() => setFailed(cover.url)}
          />
        )}
        {repositioning !== null && (
          <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/55 px-3 py-1.5 text-sm text-white">
            {t("dragToReposition")}
          </span>
        )}
      </div>
      {editable && (
        <div
          className={cn(
            "absolute bottom-3 right-3 flex gap-1 font-sans transition-opacity",
            repositioning === null &&
              !pickerOpen &&
              "opacity-0 group-hover/cover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          {repositioning !== null ? (
            <>
              <CoverButton onClick={() => setRepositioning(null)}>{t("cancel")}</CoverButton>
              <CoverButton
                onClick={() => {
                  if (isImage) onChange({ ...cover, y: repositioning });
                  setRepositioning(null);
                }}
              >
                {t("savePosition")}
              </CoverButton>
            </>
          ) : (
            <>
              <CoverPicker pageId={pageId} cover={cover} onChange={onChange} align="end" open={pickerOpen} onOpenChange={setPickerOpen}>
                {(toggle) => <CoverButton onClick={toggle}>{t("change")}</CoverButton>}
              </CoverPicker>
              {isImage && failed !== cover.url && (
                <CoverButton onClick={() => setRepositioning(cover.y)}>
                  <MoveVertical className="h-3.5 w-3.5" /> {t("reposition")}
                </CoverButton>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CoverButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-black/10 bg-white/90 px-2 text-xs font-medium text-[#1f2328] shadow-sm backdrop-blur hover:bg-white"
    >
      {children}
    </button>
  );
}

/** Choose a cover: a built-in gradient, an image uploaded to the page, or a link to one. */
export function CoverPicker({
  pageId,
  cover,
  onChange,
  align = "start",
  open,
  onOpenChange,
  children,
}: {
  pageId: string;
  cover: PageCover | null;
  onChange: (cover: PageCover | null) => void;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: (toggle: () => void) => React.ReactNode;
}) {
  const t = useTranslations("page.cover");
  const uploadMessage = useUploadErrorMessage();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <Popover
      trigger={({ toggle }) => <>{children(toggle)}</>}
      align={align}
      open={open}
      onOpenChange={onOpenChange}
      className="w-80 p-2"
    >
      {(close) => {
        const choose = (next: PageCover | null) => {
          setError(null);
          setLink("");
          onChange(next);
          close();
        };
        async function upload(file: File | undefined) {
          if (!file) return;
          if (!file.type.startsWith("image/")) {
            setError(t("notAnImage"));
            return;
          }
          setUploading(true);
          setError(null);
          try {
            const stored = await uploadToPage(pageId)(file);
            choose({ kind: "image", url: stored.url, y: DEFAULT_COVER_Y });
          } catch (e) {
            setError(uploadMessage(e));
          } finally {
            setUploading(false);
          }
        }
        return (
          <div className="space-y-3">
            <div>
              <p className="mb-1.5 px-0.5 text-xs font-medium text-fg-muted">{t("gallery")}</p>
              <div className="grid grid-cols-4 gap-1.5">
                {COVER_GRADIENT_NAMES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    aria-label={t(`gradients.${name}`)}
                    title={t(`gradients.${name}`)}
                    onClick={() => choose({ kind: "gradient", gradient: name })}
                    className={cn(
                      "h-10 rounded-md ring-offset-2 ring-offset-bg hover:opacity-90",
                      cover?.kind === "gradient" && cover.gradient === name && "ring-2 ring-accent",
                    )}
                    style={{ background: COVER_GRADIENTS[name] }}
                  />
                ))}
              </div>
            </div>
            <div>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button size="sm" className="w-full" disabled={uploading} onClick={() => fileInput.current?.click()}>
                <ImageUp className="h-3.5 w-3.5" /> {uploading ? t("uploading") : t("upload")}
              </Button>
            </div>
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const url = coverImageUrl(link);
                if (!url) {
                  setError(t("invalidLink"));
                  return;
                }
                choose({ kind: "image", url, y: DEFAULT_COVER_Y });
              }}
            >
              <Input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder={t("linkPlaceholder")}
                aria-label={t("link")}
                className="h-7 flex-1 text-xs"
              />
              <Button size="sm" type="submit" disabled={!link.trim()}>
                {t("useLink")}
              </Button>
            </form>
            {error && (
              <p role="alert" className="px-0.5 text-xs text-danger">
                {error}
              </p>
            )}
            {cover && (
              <button
                type="button"
                onClick={() => choose(null)}
                className="w-full rounded px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-bg-hover"
              >
                {t("remove")}
              </button>
            )}
          </div>
        );
      }}
    </Popover>
  );
}
