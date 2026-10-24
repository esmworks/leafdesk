"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { codeFormatter, syntaxErrorLine } from "@/lib/code-format";
import type { PageEditor } from "./embed-blocks";

/**
 * "Format code" in a code block's block menu, for the languages Prettier formats (lib/code-format;
 * the item isn't there for others). The formatter loads when clicked (code-format.ts). The new code
 * replaces the block's in one change, so it syncs and undoes as one step; code with a syntax
 * error stays as it is, and `onError` says where the error is.
 */

/** Code blocks being formatted, so a second click waits for the first. */
const formatting = new Set<string>();

const blockText = (content: unknown) =>
  Array.isArray(content) ? content.map((node) => (typeof node?.text === "string" ? node.text : "")).join("") : "";

export function FormatCodeItem({ onError }: { onError: (message: string) => void }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const t = useTranslations("page.blocks.code");
  if (!block || block.type !== "codeBlock" || !editor.isEditable) return null;
  const formatter = codeFormatter((block.props as { language?: unknown }).language);
  if (!formatter) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        const id = block.id;
        const code = blockText(block.content);
        if (formatting.has(id) || !code.trim()) return;
        formatting.add(id);
        void import("./code-format")
          .then(({ formatCode }) => formatCode(code, formatter))
          .then((formatted) => {
            const current = editor.getBlock(id);
            // Changed meanwhile (typed in, deleted): what was formatted isn't the block's any more.
            if (!current || blockText(current.content) !== code || formatted === code) return;
            editor.updateBlock(id, { content: formatted } as never);
          })
          .catch((error: unknown) => {
            const line = syntaxErrorLine(error);
            onError(line ? t("formatSyntaxError", { line }) : t("formatFailed"));
          })
          .finally(() => formatting.delete(id));
      }}
    >
      {t("format")}
    </Components.Generic.Menu.Item>
  );
}
