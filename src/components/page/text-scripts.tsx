"use client";

import { formatKeyboardShortcut } from "@blocknote/core";
import { useBlockNoteEditor, useComponentsContext, useDictionary, useEditorState } from "@blocknote/react";
import { Subscript, Superscript } from "lucide-react";
import { useTranslations } from "next-intl";
import type { JSX } from "react";
import { otherScript, SUBSCRIPT, SUPERSCRIPT, TEXT_SCRIPT_SHORTCUTS, type TextScript } from "@/lib/text-scripts";
import type { PageEditor } from "./embed-blocks";

/**
 * Superscript and subscript buttons for the formatting toolbar, shown like the text style buttons
 * around them (the styles and their shortcuts are lib/text-scripts).
 */
function TextScriptButton({ script }: { script: TextScript }) {
  const t = useTranslations("page.textStyle");
  const dict = useDictionary();
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      // As BlockNote's own style buttons: not on read-only pages, nor without text selected.
      const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
      if (!editor.isEditable || !blocks.some((block) => block.content !== undefined)) return undefined;
      return { active: script in editor.getActiveStyles() };
    },
  });
  if (!state) return null;
  const label = t(script);
  const Icon = script === SUPERSCRIPT ? Superscript : Subscript;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      data-test={script}
      label={label}
      mainTooltip={label}
      secondaryTooltip={formatKeyboardShortcut(TEXT_SCRIPT_SHORTCUTS[script].replace("-", "+"), dict.generic.ctrl_shortcut)}
      isSelected={state.active}
      icon={<Icon size={16} />}
      onClick={() => {
        editor.focus();
        if (state.active) {
          editor.removeStyles({ [script]: true });
        } else {
          // The styles exclude each other, but at a caret the other one would keep this one out.
          editor.removeStyles({ [otherScript(script)]: true });
          editor.addStyles({ [script]: true });
        }
      }}
    />
  );
}

/** The formatting toolbar's items with the superscript and subscript buttons after strikethrough. */
export function withTextScriptButtons(items: JSX.Element[]): JSX.Element[] {
  const at = items.findIndex((item) => item.key === "strikeStyleButton");
  const buttons = [<TextScriptButton key="superscriptStyleButton" script={SUPERSCRIPT} />, <TextScriptButton key="subscriptStyleButton" script={SUBSCRIPT} />];
  return at < 0 ? [...items, ...buttons] : [...items.slice(0, at + 1), ...buttons, ...items.slice(at + 1)];
}
