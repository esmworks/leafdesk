"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { downloadUrl } from "@/lib/downloads";
import { ALIGNABLE_MEDIA, mediaAlignment } from "@/lib/media-placement";
import { runsRtl, valueFor, type Side } from "./align-buttons";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";

/**
 * The block menu's entries for media: aligning an image, video, audio, file, bookmark or embed as
 * a whole (the formatting toolbar's align buttons do it too where the block can be selected, but
 * bookmarks and embeds can't be), and downloading what an image, video, audio or file block shows
 * (lib/downloads: an uploaded file, or one on another site through the server).
 */

const SIDES: Side[] = ["left", "center", "right"];

/** "Align left", "Align center", "Align right", the current one checked. */
export function AlignMediaItems() {
  const Components = useComponentsContext()!;
  const t = useTranslations("page.blockMenu");
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const host = useEmbedHost();
  if (!block || !ALIGNABLE_MEDIA.has(block.type) || !editor.isEditable || !host?.editable) return null;
  const current = mediaAlignment((block.props as { textAlignment?: unknown }).textAlignment);
  const rtl = runsRtl(editor, block.id);
  return (
    <>
      {SIDES.map((side) => {
        const value = valueFor(side, rtl);
        return (
          <Components.Generic.Menu.Item
            key={side}
            className="bn-menu-item"
            checked={current === value}
            onClick={() => {
              if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { textAlignment: value } } as never);
            }}
          >
            {t(side === "left" ? "alignLeft" : side === "center" ? "alignCenter" : "alignRight")}
          </Components.Generic.Menu.Item>
        );
      })}
    </>
  );
}

const DOWNLOADABLE = new Set(["image", "video", "audio", "file"]);

/** Saves a URL's file the way a download link does. */
export function startDownload(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** "Download" for an image, video, audio or file block that shows something. */
export function DownloadMediaItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const host = useEmbedHost();
  const t = useTranslations("page.blockMenu");
  if (!block || !DOWNLOADABLE.has(block.type) || !host) return null;
  const props = block.props as { url?: unknown; name?: unknown };
  const href = downloadUrl(props.url, { pageId: host.pageId, name: typeof props.name === "string" ? props.name : undefined });
  if (!href) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => startDownload(href)}>
      {t("download")}
    </Components.Generic.Menu.Item>
  );
}
