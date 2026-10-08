"use client";

import { ImageUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { uploadToPage, useUploadErrorMessage } from "@/components/database/files-cell";
import { Button, cn, Input, Popover } from "@/components/ui";
import { BACKGROUND_COLORS, backgroundImageUrl, type PageBackground } from "@/lib/page-background";

/** Choose a page's background: a color, an image uploaded to the page, or a link to one. */
export function BackgroundPicker({
  pageId,
  background,
  onChange,
  children,
}: {
  pageId: string;
  background: PageBackground | null;
  onChange: (background: PageBackground | null) => void;
  children: (toggle: () => void) => React.ReactNode;
}) {
  const t = useTranslations("page.background");
  const uploadMessage = useUploadErrorMessage();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <Popover trigger={({ toggle }) => <>{children(toggle)}</>} className="w-72 p-2">
      {(close) => {
        const choose = (next: PageBackground | null) => {
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
            choose({ kind: "image", url: stored.url });
          } catch (e) {
            setError(uploadMessage(e));
          } finally {
            setUploading(false);
          }
        }
        return (
          <div className="space-y-3 font-sans">
            <div>
              <p className="mb-1.5 px-0.5 text-xs font-medium text-fg-muted">{t("colors")}</p>
              <div className="grid grid-cols-7 gap-1.5">
                {BACKGROUND_COLORS.map((color) => {
                  const active = background?.kind === "color" && background.color === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      aria-label={t(`colorNames.${color}`)}
                      aria-pressed={active}
                      title={t(`colorNames.${color}`)}
                      onClick={() => choose({ kind: "color", color })}
                      // The swatch shows the stronger option color so the light tints tell apart.
                      className={cn(
                        `opt-${color}`,
                        "h-7 rounded-md border border-border ring-offset-2 ring-offset-bg hover:opacity-85",
                        active && "ring-2 ring-accent",
                      )}
                    />
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-1.5 px-0.5 text-xs font-medium text-fg-muted">{t("image")}</p>
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
              <form
                className="mt-1.5 flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const url = backgroundImageUrl(link);
                  if (!url) {
                    setError(t("invalidLink"));
                    return;
                  }
                  choose({ kind: "image", url });
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
            </div>
            {error && (
              <p role="alert" className="px-0.5 text-xs text-danger">
                {error}
              </p>
            )}
            {background && (
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
