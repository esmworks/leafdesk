"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { createPageAction } from "@/app/actions/pages";
import { pageFromBlocks } from "@/lib/blocks-to-page";
import { editorBlocksToMarkdown } from "@/lib/editor-markdown";
import { PAGE_LINK_BLOCK } from "@/lib/mentions";
import type { PageEditor } from "./embed-blocks";
import { PagePicker } from "./mentions";

type AnyBlock = PageEditor["document"][number];

/**
 * Where the blocks go: inside this page, under another page, or into a database as a row. The new
 * page takes the first block's text as its title and the rest as its body (lib/blocks-to-page),
 * and a link to it takes the blocks' place. The blocks are read again when the page is made, so
 * typing meanwhile goes along.
 */
export default function TurnIntoPageDialog({
  editor,
  workspaceId,
  pageId,
  blockIds,
  onClose,
}: {
  editor: PageEditor;
  workspaceId: string;
  pageId: string;
  blockIds: string[] | null;
  onClose: () => void;
}) {
  const t = useTranslations("page.turnIntoPage");
  const [failed, setFailed] = useState(false);

  async function move(parentId: string) {
    const blocks = (blockIds ?? []).map((id) => editor.getBlock(id)).filter((b): b is AnyBlock => Boolean(b));
    if (!blocks.length) return onClose();
    const { title, body } = pageFromBlocks(blocks);
    try {
      const markdown = body.length ? await editorBlocksToMarkdown(editor, body) : "";
      const { id } = await createPageAction({ workspaceId, parentId, title, ...(markdown.trim() ? { markdown } : {}) });
      const still = blocks.filter((b) => editor.getBlock(b.id));
      if (still.length) editor.replaceBlocks(still, [{ type: PAGE_LINK_BLOCK, props: { pageId: id } } as never]);
      setFailed(false);
      onClose();
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      <PagePicker
        open={blockIds !== null}
        pageId={pageId}
        title={t("title")}
        here={{ label: t("here"), onPick: () => void move(pageId) }}
        onClose={() => {
          setFailed(false);
          onClose();
        }}
        onPick={(target) => void move(target)}
      />
      {failed && blockIds && (
        <p role="alert" className="fixed inset-x-0 bottom-4 z-[70] mx-auto w-fit rounded-md bg-danger px-3 py-1.5 text-sm text-white shadow">
          {t("failed")}
        </p>
      )}
    </>
  );
}
