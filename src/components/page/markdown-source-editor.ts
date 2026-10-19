"use client";

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, Prec, type ChangeSpec, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, placeholder, type Command } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { SourceStart } from "@/lib/markdown-source";

/**
 * The Markdown source view's text editor (components/page/markdown-source.tsx): CodeMirror with
 * Markdown highlighting in Leafdesk's colors, formatting commands, KaTeX completion inside
 * equations and files uploaded when pasted or dropped.
 */

// ---------------------------------------------------------------------------------------------
// Look

/** Colors from the app's tokens (globals.css), so light and dark follow the app's theme. */
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)", fontSize: "14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    lineHeight: "1.6",
  },
  ".cm-content": { padding: "16px 0 40vh", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 20px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--ring)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--bg-hover) 55%, transparent)" },
  ".cm-placeholder": { color: "var(--fg-faint)" },
  ".cm-tooltip": { backgroundColor: "var(--bg)", border: "1px solid var(--border)", borderRadius: "6px", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--bg-active)", color: "var(--fg)" },
  ".cm-completionDetail": { color: "var(--fg-faint)", fontStyle: "normal", marginInlineStart: "8px" },
});

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "var(--fg)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--accent)" },
  { tag: tags.monospace, color: "var(--fg-muted)" },
  { tag: tags.quote, color: "var(--fg-muted)" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: "var(--fg-faint)" },
  { tag: [tags.comment, tags.meta], color: "var(--fg-faint)" },
  { tag: tags.list, color: "var(--fg-muted)" },
]);

/** Light or dark: CodeMirror's own defaults (selection, panels) follow it. */
export const schemeCompartment = new Compartment();
export const schemeExtension = (scheme: "light" | "dark") => EditorView.darkTheme.of(scheme === "dark");

// ---------------------------------------------------------------------------------------------
// Formatting commands

/** Wraps each selection in `mark` (`**`, `*`, `` ` ``), or unwraps it when it already is. */
export function toggleWrap(mark: string): Command {
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const before = state.sliceDoc(range.from - mark.length, range.from);
      const after = state.sliceDoc(range.to, range.to + mark.length);
      // **text** selected with its marks, or text selected between them.
      if (text.length >= mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) {
        return {
          changes: [
            { from: range.from, to: range.from + mark.length },
            { from: range.to - mark.length, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - mark.length * 2),
        };
      }
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: range.from - mark.length, to: range.from },
            { from: range.to, to: range.to + mark.length },
          ],
          range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
      };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

/** Makes each selection a link, `[text](https://)`, with the address selected to type over. */
export const insertLink: Command = (view) => {
  const { state } = view;
  const placeholderUrl = "https://";
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}](${placeholderUrl})`;
    const urlFrom = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      // No text yet: the cursor goes between the brackets.
      range: text ? EditorSelection.range(urlFrom, urlFrom + placeholderUrl.length) : EditorSelection.cursor(range.from + 1),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** The lines the selections touch, each once. */
function selectedLines(state: EditorState) {
  const seen = new Set<number>();
  const lines = [];
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines;
}

const HEADING = /^(\s{0,3})(#{1,6})\s+/;

/** Makes the selected lines headings of `level`, or plain lines when they already are. */
export function toggleHeading(level: number): Command {
  return (view) => {
    const lines = selectedLines(view.state);
    const all = lines.every((line) => HEADING.exec(line.text)?.[2].length === level);
    const changes: ChangeSpec[] = lines.map((line) => {
      const found = HEADING.exec(line.text);
      const from = line.from + (found?.[1].length ?? 0);
      const to = line.from + (found?.[0].length ?? 0);
      return { from, to: found ? to : from, insert: all ? "" : `${"#".repeat(level)} ` };
    });
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
    return true;
  };
}

export type ListKind = "bullet" | "ordered" | "task";
const LIST_MARKER = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

const kindOf = (text: string): ListKind | null => {
  const marker = LIST_MARKER.exec(text)![0].trim();
  if (!marker) return null;
  if (/\[[ xX]\]$/.test(marker)) return "task";
  return /^\d/.test(marker) ? "ordered" : "bullet";
};

/** Makes the selected lines a list of `kind`, or plain lines when they all already are one. */
export function toggleList(kind: ListKind): Command {
  return (view) => {
    const lines = selectedLines(view.state);
    const all = lines.every((line) => kindOf(line.text) === kind);
    let number = 0;
    const changes: ChangeSpec[] = lines.map((line) => {
      const found = LIST_MARKER.exec(line.text)!;
      const from = line.from + found[1].length;
      const to = line.from + found[0].length;
      if (all) return { from, to, insert: "" };
      number++;
      const insert = kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : `${number}. `;
      return { from, to, insert };
    });
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
    return true;
  };
}

/** Checks or unchecks the task list items on the selected lines. */
export const toggleTaskDone: Command = (view) => {
  const changes: ChangeSpec[] = [];
  for (const line of selectedLines(view.state)) {
    const found = /^(\s*[-*+]\s+\[)([ xX])\]/.exec(line.text);
    if (!found) continue;
    const at = line.from + found[1].length;
    changes.push({ from: at, to: at + 1, insert: found[2] === " " ? "x" : " " });
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input" });
  return true;
};

export const formatKeymap = (onSave: () => void) => [
  { key: "Mod-b", run: toggleWrap("**") },
  { key: "Mod-i", run: toggleWrap("*") },
  { key: "Mod-e", run: toggleWrap("`") },
  { key: "Mod-k", run: insertLink },
  // Mod-Alt too: some browsers keep Mod-1…9 for switching tabs.
  ...[1, 2, 3, 4, 5, 6].flatMap((level) => [
    { key: `Mod-${level}`, run: toggleHeading(level) },
    { key: `Mod-Alt-${level}`, run: toggleHeading(level) },
  ]),
  { key: "Mod-Shift-7", run: toggleList("ordered") },
  { key: "Mod-Shift-8", run: toggleList("bullet") },
  { key: "Mod-Shift-9", run: toggleList("task") },
  { key: "Mod-Enter", run: toggleTaskDone },
  {
    key: "Mod-s",
    run: () => {
      onSave();
      return true;
    },
  },
];

// ---------------------------------------------------------------------------------------------
// KaTeX completion

/**
 * Commands offered after a backslash inside an equation. KaTeX publishes no list of its own, so
 * these are the common ones (all of them render in KaTeX).
 */
const KATEX_COMMANDS = [
  // Greek letters
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda",
  "mu", "nu", "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi", "chi", "psi",
  "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
  // Structures
  "frac", "dfrac", "tfrac", "sqrt", "binom", "overline", "underline", "overbrace", "underbrace", "hat", "widehat", "bar",
  "vec", "dot", "ddot", "tilde", "widetilde", "left", "right", "big", "Big", "bigg", "Bigg", "text", "textbf", "textit",
  "mathrm", "mathbf", "mathit", "mathbb", "mathcal", "mathfrak", "mathsf", "mathtt", "operatorname", "boxed", "color",
  "begin", "end", "quad", "qquad", "cdot", "cdots", "ldots", "vdots", "ddots",
  // Big operators
  "sum", "prod", "coprod", "int", "iint", "iiint", "oint", "bigcup", "bigcap", "bigoplus", "bigotimes", "lim", "limsup",
  "liminf", "max", "min", "sup", "inf", "det", "exp", "log", "ln", "sin", "cos", "tan", "cot", "sec", "csc", "arcsin",
  "arccos", "arctan", "sinh", "cosh", "tanh", "arg", "deg", "dim", "gcd", "hom", "ker", "Pr",
  // Relations and operators
  "leq", "geq", "neq", "approx", "equiv", "sim", "simeq", "cong", "propto", "ll", "gg", "subset", "supset", "subseteq",
  "supseteq", "in", "notin", "ni", "cup", "cap", "setminus", "times", "div", "pm", "mp", "ast", "star", "circ", "bullet",
  "oplus", "otimes", "wedge", "vee", "neg", "forall", "exists", "nexists", "emptyset", "varnothing", "infty", "partial",
  "nabla", "prime", "angle", "perp", "parallel", "mid", "land", "lor", "implies", "iff",
  // Arrows
  "to", "gets", "rightarrow", "leftarrow", "leftrightarrow", "Rightarrow", "Leftarrow", "Leftrightarrow", "mapsto",
  "longrightarrow", "longleftarrow", "Longrightarrow", "uparrow", "downarrow", "hookrightarrow",
  // Delimiters and spacing
  "langle", "rangle", "lfloor", "rfloor", "lceil", "rceil", "lvert", "rvert", "lVert", "rVert", "{", "}", "|", ",", ";",
  "!", "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", "not", "mod", "pmod", "bmod",
];

/** Environments for `\begin{…}`. */
const KATEX_ENVIRONMENTS = ["matrix", "pmatrix", "bmatrix", "vmatrix", "Vmatrix", "cases", "aligned", "array", "gathered", "split"];

const COMMAND_OPTIONS = KATEX_COMMANDS.map((name) => ({ label: `\\${name}`, type: "keyword" }));
const ENVIRONMENT_OPTIONS = KATEX_ENVIRONMENTS.map((name) => ({ label: name, type: "type" }));

/** How far up an equation block's opening `$$` is looked for. */
const MATH_LOOKBACK_LINES = 60;

/**
 * Whether `pos` is inside an equation: between `$…$` on its line, or in an equation block (a `$$`
 * line after a blank line, its lines, a closing `$$` line). Looks only at the lines just above the
 * cursor, never the whole document: an equation block has no blank lines in it, so the first blank
 * line up says the cursor is outside one.
 */
export function insideMath(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from).replace(/\\\$/g, "");
  // An odd number of `$` (or of `$$`) before the cursor on its line: an equation is open.
  const dollars = before.match(/\$\$|\$/g) ?? [];
  const singles = dollars.filter((d) => d === "$").length;
  if (singles % 2 === 1 || (dollars.length - singles) % 2 === 1) return true;
  if (!line.text.trim() || line.text.trim() === "$$") return false;
  for (let n = line.number - 1; n >= Math.max(1, line.number - MATH_LOOKBACK_LINES); n--) {
    const text = state.doc.line(n).text.trim();
    if (!text) return false;
    if (text === "$$") return n === 1 || !state.doc.line(n - 1).text.trim();
  }
  return false;
}

function katexCompletions(context: CompletionContext): CompletionResult | null {
  const environment = context.matchBefore(/\\begin\{[a-zA-Z]*/);
  if (environment && insideMath(context.state, context.pos)) {
    return { from: environment.from + "\\begin{".length, options: ENVIRONMENT_OPTIONS, validFor: /^[a-zA-Z]*$/ };
  }
  const word = context.matchBefore(/\\[a-zA-Z]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  if (!insideMath(context.state, context.pos)) return null;
  return { from: word.from, options: COMMAND_OPTIONS, validFor: /^\\[a-zA-Z]*$/ };
}

// ---------------------------------------------------------------------------------------------
// Files

/** A file's Markdown as the page's Markdown writes it (images and videos as images, audio as HTML, the rest as links). */
export function fileMarkdown(file: { name: string; type: string }, url: string): string {
  const name = file.name.replace(/[[\]\\]/g, "\\$&") || "file";
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) return `![${name}](${url})`;
  if (file.type.startsWith("audio/")) return `<audio src="${url.replace(/"/g, "&quot;")}" controls></audio>`;
  return `[${name}](${url})`;
}

/** Uploads pasted and dropped files and puts their Markdown where they landed, a block of its own each. */
function fileHandlers(upload: (file: File) => Promise<string | null>): Extension {
  const insert = async (view: EditorView, files: File[], at: number) => {
    const parts: string[] = [];
    for (const file of files) {
      const url = await upload(file);
      if (url) parts.push(fileMarkdown(file, url));
    }
    if (!parts.length) return;
    // Wherever the document is by now: the position moves with edits made while uploading.
    const pos = Math.min(at, view.state.doc.length);
    const line = view.state.doc.lineAt(pos);
    const lead = line.text.trim() ? "\n\n" : "";
    const insert = `${lead}${parts.join("\n\n")}\n`;
    const end = line.text.trim() ? line.to : pos;
    view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length }, scrollIntoView: true, userEvent: "input" });
  };
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return false;
      event.preventDefault();
      void insert(view, files, view.state.selection.main.head);
      return true;
    },
    drop(event, view) {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      void insert(view, files, pos);
      return true;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The editor

export type SourceEditorOptions = {
  doc: string;
  scheme: "light" | "dark";
  placeholderText: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onScroll: () => void;
  upload: (file: File) => Promise<string | null>;
};

export function createSourceEditor(parent: HTMLElement, options: SourceEditorOptions): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        closeBrackets(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        autocompletion({ override: [katexCompletions], icons: false }),
        placeholder(options.placeholderText),
        theme,
        schemeCompartment.of(schemeExtension(options.scheme)),
        fileHandlers(options.upload),
        // Before the defaults: Mod-i and Mod-Enter have meanings there too.
        Prec.high(keymap.of(formatKeymap(options.onSave))),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
        }),
        EditorView.domEventHandlers({ scroll: () => options.onScroll() }),
        EditorView.contentAttributes.of({ spellcheck: "true", "aria-multiline": "true" }),
      ],
    }),
  });
}

/** Node types that hold blocks rather than being one. */
const CONTAINERS = new Set(["BulletList", "OrderedList"]);

/**
 * The source's top-level blocks (list items each, as the page has them), from the Markdown parse
 * tree: where each starts and its text, for lib/markdown-source lineAnchors.
 */
export function sourceStarts(state: EditorState): SourceStart[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  const starts: SourceStart[] = [];
  const add = (from: number, to: number) => {
    starts.push({ line: state.doc.lineAt(from).number - 1, text: state.sliceDoc(from, Math.min(to, from + 400)) });
  };
  const top = tree.topNode.firstChild;
  for (let node = top; node; node = node.nextSibling) {
    if (CONTAINERS.has(node.name)) {
      for (let item = node.firstChild; item; item = item.nextSibling) add(item.from, item.to);
    } else {
      add(node.from, node.to);
    }
  }
  return starts;
}
