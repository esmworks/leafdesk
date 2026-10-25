"use client";

import {
  createExtension,
  createCodeBlockSpec,
  parsePreCode,
  parsePreCodeContent,
  SyntaxHighlightingExtension,
} from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { createReactBlockSpec, useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { codeHighlighter } from "@/lib/code-highlighter";
import { CodeCopyButton, codeText } from "./code-copy";
import { codeLineBreak } from "@/lib/code-indent";
import { codeBlockConfig } from "@/lib/code-block";
import { cleanCodeCaption, MAX_CODE_CAPTION } from "@/lib/code-caption";
import { CODE_LANGUAGES, codeLanguage, highlightLanguage, PLAIN_TEXT } from "@/lib/code-languages";
import type { PageEditor } from "./embed-blocks";

/**
 * Code blocks with a language menu and colored code. The block is BlockNote's own (same type,
 * props, parsing and keys: Tab indents, Enter adds a line, keeping the line's indentation here), drawn by us so that a language the
 * menu doesn't list (an imported ```dockerfile2, say) stays as written instead of breaking the
 * block, and so the menu speaks the interface language. The server keeps BlockNote's spec
 * (server/blocknote.ts): the two only have to agree on the props.
 */

const builtIn = createCodeBlockSpec({ defaultLanguage: PLAIN_TEXT });

/**
 * Enter in a code block starts the new line at the indentation of the one before (lib/code-indent).
 * Ahead of BlockNote's keys for the block, which add a bare line break and leave the block on an
 * Enter after an empty last line: it still does where there is no indentation to keep.
 */
const KeepIndent = createExtension({
  key: "codeBlockKeepIndent",
  runsBefore: ["code-block-keyboard-shortcuts"],
  keyboardShortcuts: {
    Enter: ({ editor }) =>
      editor.transact((tr) => {
        const { $from, $to } = tr.selection;
        if ($from.parent.type.name !== "codeBlock" || $to.parent !== $from.parent) return false;
        const edit = codeLineBreak($from.parent.textContent, $from.parentOffset, $to.parentOffset);
        if (!edit) return false;
        tr.insertText(edit.insert, $from.start() + edit.from, $from.start() + edit.to);
        return true;
      }),
  },
});

/** Plain text first, then the languages by name. */
const LANGUAGE_OPTIONS = Object.entries(CODE_LANGUAGES)
  .filter(([id]) => id !== PLAIN_TEXT)
  .map(([id, { name }]) => ({ id, name }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));

export const CodeBlock = createReactBlockSpec(
  // BlockNote's props and a caption (lib/code-block), the server's too.
  codeBlockConfig,
  {
    meta: { ...builtIn.implementation.meta, highlight: (block) => highlightLanguage(block.props.language) ?? undefined },
    parse: parsePreCode,
    parseContent: (options) => parsePreCodeContent(options, "codeBlock"),
    render: function CodeBlockView({ block, editor, contentRef }) {
      const t = useTranslations("page.blocks.code");
      const stored = block.props.language;
      const known = codeLanguage(stored);
      // What the menu shows: the language the block names, or what it holds as written.
      const value = known ?? (stored.trim() ? stored : PLAIN_TEXT);
      const name = (id: string) => (id === PLAIN_TEXT ? t("plainText") : (CODE_LANGUAGES[id]?.name ?? id));
      return (
        <div className="group/code relative w-full">
          <div contentEditable={false} className="absolute right-3 top-2 select-none">
            <CodeCopyButton text={() => codeText(editor.getBlock(block.id)?.content ?? block.content)} />
          </div>
          <div contentEditable={false} className="absolute left-4 top-2 select-none">
            {editor.isEditable ? (
              <select
                aria-label={t("language")}
                data-code-language={block.id}
                value={value}
                onChange={(event) => {
                  editor.updateBlock(block.id, { props: { language: event.target.value } });
                  // Picked from the keyboard (editor-shortcuts.ts), typing goes on in the code.
                  if (event.target.matches(":focus-visible")) editor.focus();
                }}
                className="cursor-pointer appearance-none rounded bg-transparent px-1 py-0.5 text-xs text-white/50 outline-none transition-colors hover:bg-white/10 hover:text-white/80 focus-visible:bg-white/10 focus-visible:text-white/80"
              >
                <option value={PLAIN_TEXT} className="text-black">
                  {t("plainText")}
                </option>
                {!known && value !== PLAIN_TEXT && (
                  <option value={value} className="text-black">
                    {value}
                  </option>
                )}
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id} className="text-black">
                    {option.name}
                  </option>
                ))}
              </select>
            ) : (
              value !== PLAIN_TEXT && <span className="px-1 text-xs text-white/50">{name(value)}</span>
            )}
          </div>
          <pre className="m-0 w-full overflow-x-auto whitespace-pre px-6 pb-4 pt-9 [tab-size:2]">
            <code ref={contentRef} />
          </pre>
          <CodeCaption blockId={block.id} caption={block.props.caption} editor={editor as unknown as PageEditor} />
        </div>
      );
    },
    toExternalHTML: ({ block, contentRef }) => (
      <pre>
        <code ref={contentRef} className={`language-${block.props.language}`} data-language={block.props.language} />
      </pre>
    ),
  },
  [KeepIndent, ...(builtIn.extensions ?? [])],
);

/** The editor extension that colors code blocks, loading each language's grammar when first used. */
export const codeHighlighting = () => SyntaxHighlightingExtension({ createHighlighter: codeHighlighter });

/** Asks a code block's caption field to open (its block menu's "Caption"); the detail is the block's id. */
const CODE_CAPTION_EVENT = "leafdesk:code-caption";

/**
 * A code block's caption under the code: shown when it has one, a field for those who may edit
 * (opened empty from the block menu). Kept as the block's `caption` prop when the field is left.
 */
function CodeCaption({ blockId, caption, editor }: { blockId: string; caption: string; editor: PageEditor }) {
  const t = useTranslations("page.blocks.code");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(caption);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(caption), [caption]);
  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== blockId) return;
      setEditing(true);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(CODE_CAPTION_EVENT, onOpen);
    return () => window.removeEventListener(CODE_CAPTION_EVENT, onOpen);
  }, [blockId]);
  if (!caption && !editing) return null;
  const className = "block w-full bg-transparent px-6 pb-3 text-sm text-white/60 outline-none placeholder:text-white/30";
  if (!editor.isEditable) {
    return (
      <p contentEditable={false} className={className}>
        {caption}
      </p>
    );
  }
  const save = () => {
    setEditing(false);
    const next = cleanCodeCaption(draft);
    if (next !== caption && editor.getBlock(blockId)) editor.updateBlock(blockId, { props: { caption: next } });
  };
  return (
    <div contentEditable={false}>
      <input
        ref={input}
        value={draft}
        maxLength={MAX_CODE_CAPTION}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            input.current?.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(caption);
            setEditing(false);
            requestAnimationFrame(() => editor.focus());
          }
        }}
        placeholder={t("captionPlaceholder")}
        aria-label={t("caption")}
        className={className}
      />
    </div>
  );
}

/** "Caption" in a code block's block menu: opens the caption field under the code. */
export function CodeCaptionItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const t = useTranslations("page.blocks.code");
  if (!block || block.type !== "codeBlock" || !editor.isEditable) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => window.dispatchEvent(new CustomEvent(CODE_CAPTION_EVENT, { detail: block.id }))}>
      {t("caption")}
    </Components.Generic.Menu.Item>
  );
}
