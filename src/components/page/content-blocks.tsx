"use client";

import {
  SourceBlockWithPreviewExtension,
  SourceInlineContentWithPreviewExtension,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core/extensions";
import {
  createReactBlockSpec,
  createReactInlineContentSpec,
  PreviewPlaceholder,
  SourceBlockWithPreview,
  SourceInlineContentWithPreview,
  useEditorChange,
  useEditorState,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import katex from "katex";
import { Info, ListTree, PrinterX, Radical, Route, Sigma, SmilePlus, Superscript, TableOfContents, Workflow } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { listSubpagesAction } from "@/app/actions/pages";
import { useChannel } from "@/components/collab/use-channel";
import {
  breadcrumbBlockConfig,
  calloutBlockConfig,
  DEFAULT_CALLOUT_ICON,
  FOOTNOTE,
  footnoteConfig,
  inlineMathConfig,
  KATEX_OPTIONS,
  mathBlockConfig,
  mermaidBlockConfig,
  subpagesBlockConfig,
  tocBlockConfig,
} from "@/lib/content-blocks";
import { plainText } from "@/lib/content-markdown";
import { noteParts } from "@/lib/footnotes";
import type { PageEditor } from "./embed-blocks";
import { IconPicker } from "./icon-picker";
import { MermaidImageView, useMermaid } from "./mermaid-diagram";
import { HeadingList, SubpageList, Trail, type TrailCrumb } from "./page-outline";

export type { TrailCrumb };

/**
 * The editor's side of the content blocks (configs shared with the server in lib/content-blocks):
 * callouts, equations, Mermaid diagrams, a table of contents, a breadcrumb and a list of subpages.
 */

// ---------------------------------------------------------------------------------------------
// The page around the editor, for the breadcrumb

/** The page being edited and the pages above it (the last crumb is the page itself). */
const PageTrailContext = createContext<{ workspaceId: string; crumbs: TrailCrumb[] } | null>(null);
export const PageTrailProvider = PageTrailContext.Provider;

// ---------------------------------------------------------------------------------------------
// Equations

type Rendered = { node: HTMLElement | null; error: string | null };

/**
 * An equation built by KaTeX as DOM nodes (no HTML string), with `trust: false`. While a source
 * doesn't parse, the last equation that did stays up and the error says why.
 */
function useKatex(source: string, displayMode: boolean): Rendered {
  const current = useMemo<Rendered>(() => {
    if (!source.trim()) return { node: null, error: null };
    const node = document.createElement(displayMode ? "div" : "span");
    try {
      katex.render(source, node, { ...KATEX_OPTIONS, displayMode, throwOnError: true });
      return { node, error: null };
    } catch (error) {
      return { node: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [source, displayMode]);
  const [lastGood, setLastGood] = useState<{ source: string; node: HTMLElement | null }>({ source, node: current.node });
  if (current.node && lastGood.node !== current.node) setLastGood({ source, node: current.node });
  return { node: current.node ?? (source.trim() ? lastGood.node : null), error: current.error };
}

/**
 * The error under the source while editing: a translated summary, then the parser's own message
 * (in English, as KaTeX and Mermaid write it) so people can see what to fix.
 */
function SourceError({ summary, detail }: { summary: string; detail: string }) {
  const text = detail.replace(/^KaTeX parse error:\s*/, "").trim();
  return (
    <>
      <span className="block">{summary}</span>
      {text && text !== "Syntax error" && <span className="mt-0.5 block text-xs opacity-80 [overflow-wrap:anywhere]">{text}</span>}
    </>
  );
}

function KatexView({ node, inline }: { node: HTMLElement; inline?: boolean }) {
  const Tag = inline ? "span" : "div";
  return (
    <Tag
      className={inline ? undefined : "w-full"}
      ref={(element: HTMLElement | null) => {
        if (element && element.firstChild !== node) element.replaceChildren(node);
      }}
    />
  );
}

/** MathML only, for copying out of the editor: other apps read it, and so does BlockNote's Markdown. */
function MathMarkup({ source, displayMode }: { source: string; displayMode: boolean }) {
  const Tag = displayMode ? "div" : "span";
  return (
    <Tag
      ref={(element: HTMLElement | null) => {
        if (!element || !source.trim()) return;
        katex.render(source, element, { ...KATEX_OPTIONS, displayMode, throwOnError: false, output: "mathml" });
      }}
    />
  );
}

const MathBlock = createReactBlockSpec(mathBlockConfig, {
  meta: { code: true, hasPreview: true },
  render: function MathBlockView({ block, editor, contentRef }) {
    const t = useTranslations("page.blocks.math");
    const source = plainText(block.content);
    const { node, error } = useKatex(source, true);
    return (
      <SourceBlockWithPreview
        block={block}
        editor={editor}
        contentRef={contentRef}
        source={source}
        preview={node ? <KatexView node={node} /> : undefined}
        error={error ? <SourceError summary={t("error")} detail={error} /> : undefined}
        emptySourcePlaceholder={<PreviewPlaceholder text={t("placeholder")} icon={<Sigma size={18} />} />}
        errorPreview={t("error")}
        sourcePlaceholder={t("sourcePlaceholder")}
      />
    );
  },
  toExternalHTML: ({ block }) => <MathMarkup source={plainText(block.content)} displayMode />,
});

const InlineMath = createReactInlineContentSpec(inlineMathConfig, {
  meta: { code: true, hasPreview: true },
  render: function InlineMathView({ inlineContent, editor, node, getPos, contentRef }) {
    const t = useTranslations("page.blocks.inlineMath");
    const source = plainText(inlineContent.content);
    const rendered = useKatex(source, false);
    return (
      <SourceInlineContentWithPreview
        editor={editor}
        node={node}
        getPos={getPos}
        contentRef={contentRef}
        source={source}
        preview={rendered.node ? <KatexView node={rendered.node} inline /> : undefined}
        error={rendered.error ? <SourceError summary={t("error")} detail={rendered.error} /> : undefined}
        emptySourcePlaceholder={t("placeholder")}
        errorPreview={t("error")}
        sourcePlaceholder={t("sourcePlaceholder")}
      />
    );
  },
  toExternalHTML: ({ inlineContent }) => <MathMarkup source={plainText(inlineContent.content)} displayMode={false} />,
});

// ---------------------------------------------------------------------------------------------
// Footnotes

/**
 * A footnote: its number in the text, the note in a popup while it's edited, like an equation's
 * source. The number is a CSS counter (globals.css): footnotes count in the order the editor shows
 * them, which is the order the list under the page has them (FootnoteList).
 */
const Footnote = createReactInlineContentSpec(footnoteConfig, {
  meta: { code: true, hasPreview: true },
  render: function FootnoteView({ inlineContent, editor, node, getPos, contentRef }) {
    const t = useTranslations("page.blocks.footnote");
    const note = plainText(inlineContent.content);
    return (
      <SourceInlineContentWithPreview
        editor={editor}
        node={node}
        getPos={getPos}
        contentRef={contentRef}
        source={note}
        preview={<sup className="leafdesk-footnote-ref" title={note} />}
        emptySourcePlaceholder={t("placeholder")}
        sourcePlaceholder={t("sourcePlaceholder")}
      />
    );
  },
  // Elsewhere (copied out of the editor) the note follows its sentence in brackets.
  toExternalHTML: ({ inlineContent }) => <sup>[{plainText(inlineContent.content)}]</sup>,
});

type Note = { pos: number; size: number; text: string };

function notesOf(editor: PageEditor): Note[] {
  const notes: Note[] = [];
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.type.name !== FOOTNOTE) return true;
    if (node.textContent.trim()) notes.push({ pos, size: node.nodeSize, text: node.textContent });
    return false;
  });
  return notes;
}

const sameNotes = (a: Note[], b: Note[]) => a.length === b.length && a.every((n, i) => n.pos === b[i].pos && n.text === b[i].text);

/**
 * The page's footnotes under its body, numbered as the text numbers them. A note's number moves to
 * its place in the text; for people who may edit, that opens the note too. Empty footnotes have no
 * number and aren't listed.
 */
export function FootnoteList({ editor }: { editor: PageEditor }) {
  const t = useTranslations("page.blocks.footnote");
  // Every transaction, the collaborative document's first load included (a change event misses it).
  const notes = useEditorState({ editor, selector: () => notesOf(editor), equalityFn: (a, b) => !!b && sameNotes(a, b) });
  const go = useCallback(
    (note: Note) => {
      const view = editor.prosemirrorView;
      if (!view) return;
      const dom = view.nodeDOM(note.pos);
      if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center" });
      if (!editor.isEditable) return;
      // Inside the note's text: the selection being there is what opens its popup.
      editor.getExtension(SourceInlineContentWithPreviewExtension)?.store.setState({ selected: note.pos });
      const { selection } = view.state;
      const TextSelection = selection.constructor as unknown as {
        create: (doc: typeof view.state.doc, pos: number) => typeof selection;
      };
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, note.pos + note.size - 1)));
      view.focus();
    },
    [editor],
  );
  if (!notes.length) return null;
  return (
    <section aria-label={t("list")} className="mx-4 mt-6 border-t border-border pt-3 text-sm text-fg-muted md:mx-[54px]">
      <ol className="space-y-1">
        {notes.map((note, i) => (
          <li key={note.pos} className="flex gap-2">
            <button
              type="button"
              onClick={() => go(note)}
              title={t("goTo")}
              className="min-w-5 shrink-0 rounded text-start tabular-nums text-fg hover:text-accent"
            >
              {i + 1}.
            </button>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {noteParts(note.text).map((part, j) =>
                "url" in part ? (
                  <a key={j} href={part.url} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">
                    {part.url}
                  </a>
                ) : (
                  part.text
                ),
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Mermaid

const MermaidBlock = createReactBlockSpec(mermaidBlockConfig, {
  // Diagrams span lines: Enter adds a line in the source, the "OK" button closes it.
  meta: { code: true, hasPreview: true, hardBreakShortcut: "enter" },
  render: function MermaidBlockView({ block, editor, contentRef }) {
    const t = useTranslations("page.blocks.mermaid");
    const source = plainText(block.content);
    const { image, error, pending } = useMermaid(source);
    const preview = image ? (
      <MermaidImageView image={image} label={t("label")} />
    ) : pending && !error ? (
      <p className="w-full py-6 text-center text-sm text-fg-muted">{t("loading")}</p>
    ) : undefined;
    return (
      <SourceBlockWithPreview
        block={block}
        editor={editor}
        contentRef={contentRef}
        source={source}
        preview={preview}
        error={error ? <SourceError summary={t("error")} detail={error} /> : undefined}
        emptySourcePlaceholder={<PreviewPlaceholder text={t("placeholder")} icon={<Workflow size={18} />} />}
        errorPreview={t("error")}
        sourcePlaceholder={t("sourcePlaceholder")}
      />
    );
  },
  toExternalHTML: ({ block }) => (
    <pre>
      <code className="language-mermaid">{plainText(block.content)}</code>
    </pre>
  ),
});

// ---------------------------------------------------------------------------------------------
// Callout

const CalloutBlock = createReactBlockSpec(calloutBlockConfig, {
  render: function CalloutView({ block, editor, contentRef }) {
    const t = useTranslations("page.blocks.callout");
    const icon = block.props.icon;
    const setIcon = (next: string | null) => {
      if (editor.isEditable && editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { icon: next ?? "" } });
    };
    return (
      <div className="leafdesk-callout">
        {(icon || editor.isEditable) && (
          <div contentEditable={false} className="leafdesk-callout-icon">
            <IconPicker icon={icon || null} onChange={setIcon} disabled={!editor.isEditable}>
              {(toggle) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-label={t("icon")}
                  title={editor.isEditable ? t("icon") : undefined}
                  className={
                    editor.isEditable
                      ? "flex h-7 w-7 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10"
                      : "flex h-7 w-7 cursor-default items-center justify-center"
                  }
                >
                  {icon || <SmilePlus className="h-4 w-4 text-fg-faint" />}
                </button>
              )}
            </IconPicker>
          </div>
        )}
        <div ref={contentRef} className="leafdesk-callout-text" />
        {block.props.hideInPrint && (
          <span contentEditable={false} className="leafdesk-callout-print" title={t("hiddenInPrint")} aria-label={t("hiddenInPrint")}>
            <PrinterX className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    );
  },
  toExternalHTML: ({ block, contentRef }) => (
    <blockquote>
      <p>
        {block.props.icon ? `${block.props.icon} ` : null}
        <span ref={contentRef} />
      </p>
    </blockquote>
  ),
});

// ---------------------------------------------------------------------------------------------
// Table of contents

type Heading = { id: string; level: number; text: string };

function headingsOf(editor: PageEditor): Heading[] {
  const out: Heading[] = [];
  const walk = (blocks: PageEditor["document"]) => {
    for (const block of blocks) {
      if (block.type === "heading") out.push({ id: block.id, level: Number(block.props.level) || 1, text: plainText(block.content) });
      if (block.children.length) walk(block.children);
    }
  };
  walk(editor.document);
  return out;
}

const sameHeadings = (a: Heading[], b: Heading[]) =>
  a.length === b.length && a.every((h, i) => h.id === b[i].id && h.level === b[i].level && h.text === b[i].text);

const TocBlock = createReactBlockSpec(tocBlockConfig, {
  render: function TocView({ editor }) {
    const t = useTranslations("page.blocks.toc");
    const tc = useTranslations("common");
    const typed = editor as unknown as PageEditor;
    const [headings, setHeadings] = useState(() => headingsOf(typed));
    useEditorChange(() => {
      const next = headingsOf(typed);
      setHeadings((current) => (sameHeadings(current, next) ? current : next));
    }, editor);
    return (
      <div contentEditable={false} className="w-full">
        <HeadingList
          headings={headings.map((h) => ({ key: h.id, level: h.level, text: h.text }))}
          label={t("label")}
          empty={t("empty")}
          untitled={tc("untitled")}
          link={(id) => ({
            href: `#${id}`,
            onClick: (event) => {
              event.preventDefault();
              const target = editor.domElement?.querySelector(`[data-node-type="blockOuter"][data-id="${CSS.escape(id)}"]`);
              target?.scrollIntoView({ behavior: "smooth", block: "start" });
            },
          })}
        />
      </div>
    );
  },
  toExternalHTML: () => <div />,
});

// ---------------------------------------------------------------------------------------------
// Breadcrumb

const BreadcrumbBlock = createReactBlockSpec(breadcrumbBlockConfig, {
  render: function BreadcrumbView() {
    const t = useTranslations("page.blocks.breadcrumb");
    const tc = useTranslations("common");
    const trail = useContext(PageTrailContext);
    if (!trail) return null;
    return (
      <div contentEditable={false} className="w-full">
        <Trail crumbs={trail.crumbs} href={(id) => `/w/${trail.workspaceId}/p/${id}`} label={t("label")} untitled={tc("untitled")} />
      </div>
    );
  },
  toExternalHTML: () => <div />,
});

// ---------------------------------------------------------------------------------------------
// Subpages

/** The databases the page shows as database blocks: the subpages list leaves them out, as published pages do. */
function shownDatabases(editor: PageEditor): string {
  const ids: string[] = [];
  const walk = (blocks: PageEditor["document"]) => {
    for (const block of blocks) {
      if (block.type === "database" && block.props.databaseId) ids.push(block.props.databaseId);
      if (block.children.length) walk(block.children);
    }
  };
  walk(editor.document);
  return ids.sort().join(" ");
}

const SubpagesBlock = createReactBlockSpec(subpagesBlockConfig, {
  render: function SubpagesView({ editor }) {
    const t = useTranslations("page.blocks.subpages");
    const tc = useTranslations("common");
    const trail = useContext(PageTrailContext);
    const workspaceId = trail?.workspaceId;
    const pageId = trail?.crumbs.at(-1)?.id;
    const typed = editor as unknown as PageEditor;
    const [subpages, setSubpages] = useState<TrailCrumb[] | null>(null);
    const [shown, setShown] = useState(() => shownDatabases(typed));
    useEditorChange(() => setShown(shownDatabases(typed)), editor);
    // Offline or refused, the list stays as last loaded.
    const load = useCallback(() => {
      if (workspaceId && pageId) listSubpagesAction(workspaceId, pageId).then(setSubpages, () => {});
    }, [workspaceId, pageId]);
    useEffect(load, [load]);
    // Pages added, moved, renamed or trashed anywhere in the workspace, as the sidebar hears them.
    useChannel(workspaceId ? `ws:${workspaceId}` : null, (event) => event !== "inbox" && load());
    if (!trail) return null;
    const hidden = new Set(shown.split(" "));
    return (
      <div contentEditable={false} className="w-full">
        {subpages === null ? (
          <div className="h-8" aria-busy />
        ) : (
          <SubpageList
            pages={subpages.filter((p) => !hidden.has(p.id))}
            href={(id) => `/w/${trail.workspaceId}/p/${id}`}
            label={t("label")}
            empty={t("empty")}
            untitled={tc("untitled")}
          />
        )}
      </div>
    );
  },
  toExternalHTML: () => <div />,
});

// ---------------------------------------------------------------------------------------------
// Schema parts and slash menu

export const contentBlockSpecs = {
  callout: CalloutBlock(),
  math: MathBlock(),
  mermaid: MermaidBlock(),
  tableOfContents: TocBlock(),
  breadcrumb: BreadcrumbBlock(),
  subpages: SubpagesBlock(),
};

export const contentInlineSpecs = { inlineMath: InlineMath, footnote: Footnote };

/**
 * Opens the source popup of a new equation or diagram, so its source can be typed right away. A
 * paragraph follows it, as after a database block: arrowing out of the closed popup needs a block
 * to land in, and a collaborative editor keeps no empty line at the end of the page.
 */
function openSource(editor: PageEditor, blockId: string) {
  if (!editor.getNextBlock(blockId)) editor.insertBlocks([{ type: "paragraph" }], blockId, "after");
  editor.setTextCursorPosition(blockId, "end");
  editor.getExtension(SourceBlockWithPreviewExtension)?.store.setState((state) => ({ ...state, popupOpen: blockId }));
}

/**
 * Steps into the source of the inline node just inserted before the cursor (an equation, a
 * footnote), which opens its popup. After the Enter that picked the slash menu item: inside the
 * node, Enter steps back out of it.
 */
function stepIntoInline(editor: PageEditor, type: string) {
  setTimeout(() => {
    const view = editor.prosemirrorView;
    const { selection } = view.state;
    if (selection.$from.nodeBefore?.type.name !== type) return;
    // Inserting leaves a text selection; its class makes the one inside the node (the app doesn't
    // depend on prosemirror-state itself).
    const TextSelection = selection.constructor as unknown as {
      create: (doc: typeof view.state.doc, pos: number) => typeof selection;
    };
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, selection.from - 1)));
    view.focus();
  });
}

/** Slash menu entries for the content blocks: the callout with the basic blocks, the rest with "Advanced". */
export function useContentSlashItems(editor: PageEditor): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.blocks");
  return useMemo(() => {
    const basic = editor.dictionary.slash_menu.quote.group;
    const advanced = editor.dictionary.slash_menu.table.group;
    const item = (
      key: "callout" | "math" | "inlineMath" | "footnote" | "mermaid" | "toc" | "breadcrumb" | "subpages",
      group: string,
      icon: React.JSX.Element,
      onItemClick: () => void,
    ): DefaultReactSuggestionItem => ({
      title: t(`${key}.title`),
      subtext: t(`${key}.subtext`),
      aliases: t(`${key}.aliases`).split(" "),
      group,
      icon,
      onItemClick,
    });
    return [
      item("callout", basic, <Info size={18} />, () => {
        insertOrUpdateBlockForSlashMenu(editor, { type: "callout", props: { icon: DEFAULT_CALLOUT_ICON, backgroundColor: "gray" } });
      }),
      item("math", advanced, <Sigma size={18} />, () => openSource(editor, insertOrUpdateBlockForSlashMenu(editor, { type: "math" }).id)),
      item("inlineMath", advanced, <Radical size={18} />, () => {
        editor.insertInlineContent([{ type: "inlineMath", props: {}, content: "" }], { updateSelection: true });
        stepIntoInline(editor, "inlineMath");
      }),
      item("footnote", advanced, <Superscript size={18} />, () => {
        // A footnote's number sits right after the word it marks: the space typed before the "/"
        // (which only opens the menu after one) goes.
        const view = editor.prosemirrorView;
        const { $from, empty } = view.state.selection;
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 2), $from.parentOffset, undefined, "￼");
        if (empty && /^\S $/.test(before)) view.dispatch(view.state.tr.delete($from.pos - 1, $from.pos));
        editor.insertInlineContent([{ type: FOOTNOTE, props: {}, content: "" }], { updateSelection: true });
        stepIntoInline(editor, FOOTNOTE);
      }),
      item("mermaid", advanced, <Workflow size={18} />, () =>
        openSource(editor, insertOrUpdateBlockForSlashMenu(editor, { type: "mermaid" }).id),
      ),
      item("toc", advanced, <TableOfContents size={18} />, () => {
        insertOrUpdateBlockForSlashMenu(editor, { type: "tableOfContents" });
      }),
      item("breadcrumb", advanced, <Route size={18} />, () => {
        insertOrUpdateBlockForSlashMenu(editor, { type: "breadcrumb" });
      }),
      item("subpages", advanced, <ListTree size={18} />, () => {
        insertOrUpdateBlockForSlashMenu(editor, { type: "subpages" });
      }),
    ];
  }, [editor, t]);
}
