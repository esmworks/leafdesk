"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState } from "react";
import { Button, Dialog, Input } from "@/components/ui";
import { IMAGE_BLOCK, MAX_IMAGE_LINK, parseImageLink } from "@/lib/image-links";
import { pagePath } from "@/lib/mentions";
import type { PageEditor } from "./embed-blocks";
import { loadedPageTitle, PagePicker } from "./mentions";

/**
 * "Link…" in an image's block menu: a web address or a page of the workspace for the image to
 * link to (lib/image-links). The editor opens the form (ImageLinkContext); the link is a prop of
 * the block, so it syncs, undoes and versions with the page.
 */

export const ImageLinkContext = createContext<((blockId: string) => void) | null>(null);

export function ImageLinkItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const open = useContext(ImageLinkContext);
  const t = useTranslations("page.imageLink");
  if (!block || block.type !== IMAGE_BLOCK || !open || !editor.isEditable) return null;
  const linked = Boolean((block.props as { link?: unknown }).link);
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => open(block.id)}>
      {t(linked ? "editMenuItem" : "menuItem")}
    </Components.Generic.Menu.Item>
  );
}

export function ImageLinkDialog({
  editor,
  blockId,
  workspaceId,
  pageId,
  onClose,
}: {
  editor: PageEditor;
  blockId: string | null;
  workspaceId: string;
  pageId: string;
  onClose: () => void;
}) {
  const t = useTranslations("page.imageLink");
  const tc = useTranslations("common");
  const [value, setValue] = useState("");
  const [current, setCurrent] = useState("");
  const [picking, setPicking] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!blockId) return;
    const block = editor.getBlock(blockId);
    const link = String((block?.props as { link?: unknown } | undefined)?.link ?? "");
    setValue(link);
    setCurrent(link);
    setInvalid(false);
  }, [blockId, editor]);

  const write = (link: string) => {
    if (blockId && editor.getBlock(blockId)) editor.updateBlock(blockId, { props: { link } } as never);
    onClose();
  };
  const save = () => {
    if (!value.trim()) return write("");
    const parsed = parseImageLink(value, window.location.origin);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    write(parsed.href);
  };
  const page = parseImageLink(value)?.kind === "page" ? parseImageLink(value) : null;

  return (
    <>
      <Dialog open={blockId !== null && !picking} onClose={onClose} className="max-w-md">
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <label className="block">
            <span className="mb-1 block text-xs text-fg-muted">{t("urlLabel")}</span>
            <Input
              autoFocus
              value={value}
              maxLength={MAX_IMAGE_LINK}
              placeholder="https://"
              dir="ltr"
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setInvalid(false);
              }}
            />
          </label>
          {page?.kind === "page" && (
            <p className="flex items-center gap-1.5 text-xs text-fg-muted">
              <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("toPage", { title: loadedPageTitle(page.pageId) ?? tc("untitled") })}
            </p>
          )}
          {invalid && (
            <p role="alert" className="text-xs text-danger">
              {t("invalid")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => setPicking(true)}>
              {t("pickPage")}
            </Button>
            <span className="flex-1" />
            {current && (
              <Button type="button" onClick={() => write("")}>
                {t("remove")}
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary">
              {tc("save")}
            </Button>
          </div>
        </form>
      </Dialog>
      <PagePicker
        open={blockId !== null && picking}
        pageId={pageId}
        title={t("pickPage")}
        onClose={() => setPicking(false)}
        onPick={(target) => {
          setPicking(false);
          setValue(pagePath(workspaceId, target));
          setInvalid(false);
        }}
      />
    </>
  );
}
