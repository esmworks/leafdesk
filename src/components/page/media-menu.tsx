"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { copyText } from "@/components/settings/copy-button";
import { downloadUrl } from "@/lib/downloads";
import { ALIGNABLE_MEDIA, mediaAlignment } from "@/lib/media-placement";
import { blockPath, PAGE_LINK_BLOCK, pagePath } from "@/lib/mentions";
import { isWebBlockType } from "@/lib/web-blocks";
import { runsRtl, valueFor, type Side } from "./align-buttons";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";
import { BLOCK_LINK_COPIED_EVENT } from "./editor-shortcuts";

/**
 * The block menu's entries for media: aligning an image, video, audio, file, bookmark or embed as
 * a whole (the formatting toolbar's align buttons do it too where the block can be selected, but
 * bookmarks and embeds can't be), and downloading what an image, video, audio or file block shows
 * (lib/downloads: an uploaded file, or one on another site through the server). A bookmark or embed
 * also copies the address it shows ("Copy link to original", beside "Copy link to block"), and a
 * link to a page opens that page in a new tab.
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

/** "Copy link to original" for a bookmark or an embed: the address of what it shows. */
export function CopyOriginalLinkItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const t = useTranslations("page.blockMenu");
  const url = block && isWebBlockType(block.type) ? (block.props as { url?: unknown }).url : undefined;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={async () => {
        if (await copyText(url, editor.domElement ?? document.body)) window.dispatchEvent(new Event(BLOCK_LINK_COPIED_EVENT));
      }}
    >
      {t("copyOriginalLink")}
    </Components.Generic.Menu.Item>
  );
}

/** "Open in new tab" for a link to a page (at its block, when it links to one). */
export function OpenLinkedPageItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const host = useEmbedHost();
  const t = useTranslations("page.blockMenu");
  if (!block || block.type !== PAGE_LINK_BLOCK || !host) return null;
  const { pageId, blockId } = block.props as { pageId?: string; blockId?: string };
  if (!pageId) return null;
  const href = blockId ? blockPath(host.workspaceId, pageId, blockId) : pagePath(host.workspaceId, pageId);
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => window.open(href, "_blank", "noopener")}>
      {t("openInNewTab")}
    </Components.Generic.Menu.Item>
  );
}
