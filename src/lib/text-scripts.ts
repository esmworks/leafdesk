import { createStyleSpecFromTipTapMark } from "@blocknote/core";
import { Mark } from "@tiptap/core";

/**
 * Superscript and subscript text: two text styles of the page body, shared by the editor's schema
 * (components/page/embed-blocks.tsx) and the server's (server/blocknote.ts). The server must know
 * them too: y-prosemirror drops the whole text of a block holding a style its schema lacks.
 *
 * Text is one or the other, never both: each mark excludes the other (and itself, as marks do by
 * default; leaving itself out would make y-prosemirror store it as an overlapping mark), so
 * setting one on text removes the other. Mod+. and Mod+, toggle them. In HTML and Markdown they
 * are `<sup>` and `<sub>` (see lib/content-markdown for the Markdown side).
 */

export const SUPERSCRIPT = "superscript";
export const SUBSCRIPT = "subscript";
export type TextScript = typeof SUPERSCRIPT | typeof SUBSCRIPT;
export const TEXT_SCRIPTS: readonly TextScript[] = [SUPERSCRIPT, SUBSCRIPT];

/** The keyboard shortcut of each style, in ProseMirror's notation. */
export const TEXT_SCRIPT_SHORTCUTS: Record<TextScript, string> = { [SUPERSCRIPT]: "Mod-.", [SUBSCRIPT]: "Mod-," };

/** The HTML tag of each style. */
export const TEXT_SCRIPT_TAGS: Record<TextScript, "sup" | "sub"> = { [SUPERSCRIPT]: "sup", [SUBSCRIPT]: "sub" };

export const otherScript = (script: TextScript): TextScript => (script === SUPERSCRIPT ? SUBSCRIPT : SUPERSCRIPT);

function scriptMark(name: TextScript) {
  const tag = TEXT_SCRIPT_TAGS[name];
  const align = name === SUPERSCRIPT ? "super" : "sub";
  return Mark.create({
    name,
    excludes: `${SUPERSCRIPT} ${SUBSCRIPT}`,
    parseHTML() {
      // Pasted text from word processors often marks it with vertical-align instead of the tag.
      return [{ tag }, { style: "vertical-align", getAttrs: (value) => (value === align ? null : false) }];
    },
    renderHTML() {
      return [tag, 0];
    },
    addKeyboardShortcuts() {
      return {
        // Taking the other style off first lets the shortcut work at a caret in it too (a stored
        // mark the other one excludes can't be added on top of it).
        [TEXT_SCRIPT_SHORTCUTS[name]]: () => this.editor.chain().unsetMark(otherScript(name)).toggleMark(name).run(),
      };
    },
  });
}

export const textScriptStyleSpecs = {
  superscript: createStyleSpecFromTipTapMark(scriptMark(SUPERSCRIPT), "boolean"),
  subscript: createStyleSpecFromTipTapMark(scriptMark(SUBSCRIPT), "boolean"),
};
