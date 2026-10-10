"use client";

import {
  createCodeBlockConfig,
  createCodeBlockSpec,
  parsePreCode,
  parsePreCodeContent,
  SyntaxHighlightingExtension,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { codeHighlighter } from "@/lib/code-highlighter";
import { CODE_LANGUAGES, codeLanguage, highlightLanguage, PLAIN_TEXT } from "@/lib/code-languages";

/**
 * Code blocks with a language menu and colored code. The block is BlockNote's own (same type,
 * props, parsing and keys: Tab indents, Enter adds a line), drawn by us so that a language the
 * menu doesn't list (an imported ```dockerfile2, say) stays as written instead of breaking the
 * block, and so the menu speaks the interface language. The server keeps BlockNote's spec
 * (server/blocknote.ts): the two only have to agree on the props.
 */

const builtIn = createCodeBlockSpec({ defaultLanguage: PLAIN_TEXT });

/** Plain text first, then the languages by name. */
const LANGUAGE_OPTIONS = Object.entries(CODE_LANGUAGES)
  .filter(([id]) => id !== PLAIN_TEXT)
  .map(([id, { name }]) => ({ id, name }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));

export const CodeBlock = createReactBlockSpec(
  createCodeBlockConfig({ defaultLanguage: PLAIN_TEXT }),
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
        <div className="relative w-full">
          <div contentEditable={false} className="absolute left-4 top-2 select-none">
            {editor.isEditable ? (
              <select
                aria-label={t("language")}
                value={value}
                onChange={(event) => editor.updateBlock(block.id, { props: { language: event.target.value } })}
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
        </div>
      );
    },
    toExternalHTML: ({ block, contentRef }) => (
      <pre>
        <code ref={contentRef} className={`language-${block.props.language}`} data-language={block.props.language} />
      </pre>
    ),
  },
  builtIn.extensions,
);

/** The editor extension that colors code blocks, loading each language's grammar when first used. */
export const codeHighlighting = () => SyntaxHighlightingExtension({ createHighlighter: codeHighlighter });
