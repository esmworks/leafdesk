"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { createContext, useContext } from "react";
import { IMAGE_BLOCK } from "@/lib/image-links";
import type { PageEditor } from "./embed-blocks";

/**
 * "Crop…" in an image's block menu. The editor opens the crop dialog (image-crop-dialog.tsx,
 * loaded when first opened) through ImageCropContext; the crop is a prop of the block
 * (lib/image-crop), so it syncs, undoes and versions with the page.
 */

export const ImageCropContext = createContext<((blockId: string) => void) | null>(null);

export function ImageCropItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const open = useContext(ImageCropContext);
  const t = useTranslations("page.imageCrop");
  if (!block || block.type !== IMAGE_BLOCK || !open || !editor.isEditable) return null;
  const props = block.props as { url?: unknown; showPreview?: unknown };
  if (!props.url || props.showPreview === false) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => open(block.id)}>
      {t("menuItem")}
    </Components.Generic.Menu.Item>
  );
}
