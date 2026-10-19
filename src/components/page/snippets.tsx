"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  SuggestionMenuController,
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { TextQuote } from "lucide-react";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { TextSelection, type Transaction } from "prosemirror-state";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getSnippetAction } from "@/app/actions/snippets";
import { announceSnippetsChanged, useSnippetLibrary } from "@/components/snippets/library";
import { SnippetDialog } from "@/components/snippets/snippet-dialog";
import { editorBlocksToMarkdown, editorMarkdownToBlocks } from "@/lib/editor-markdown";
import {
  fillPlaceholders,
  matchSnippets,
  preparePlaceholders,
  SNIPPET_TRIGGER_CHARACTER,
  type PlaceholderContext,
  type SnippetSummary,
} from "@/lib/snippets";
import { browserTimeZone } from "@/lib/time-zone";
import type { PageEditor } from "./embed-blocks";

type AnyBlock = PageEditor["document"][number];

/** Bodies already fetched, by id and version: inserting the same snippet again needs no request. */
const bodies = new Map<string, string>();

async function snippetBody(summary: SnippetSummary): Promise<string> {
  const key = `${summary.id}@${summary.updatedAt}`;
  const known = bodies.get(key);
  if (known !== undefined) return known;
  const res = await getSnippetAction(summary.id);
  if (!res.ok) throw new Error(res.error);
  bodies.set(key, res.data.body);
  return res.data.body;
}

const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The text position of `token` in the document, or null. */
function findText(editor: PageEditor, token: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isText && node.text) {
      const at = node.text.indexOf(token);
      if (at >= 0) found = { from: pos + at, to: pos + at + token.length };
    }
    return !found;
  });
  return found;
}

const isEmptyParagraph = (block: AnyBlock) =>
  block.type === "paragraph" && Array.isArray(block.content) && block.content.length === 0 && !block.children.length;

/**
 * Puts the snippet in at the caret (where its menu was opened): a snippet of one paragraph joins
 * the line's text, anything bigger takes the place of an empty line or goes after the line. Its
 * placeholders are filled in for `ctx`; the caret ends where `{{cursor}}` was, else after it.
 */
export async function insertSnippet(editor: PageEditor, summary: SnippetSummary, ctx: PlaceholderContext) {
  const at = editor.getTextCursorPosition().block as AnyBlock;
  const body = await snippetBody(summary);
  const prepared = preparePlaceholders(body, ctx, nonce());
  const blocks = fillPlaceholders(
    (await editorMarkdownToBlocks(editor, prepared.markdown, { appUrl: window.location.origin })) as AnyBlock[],
    prepared.tokens,
  );
  if (!blocks.length) return;
  const anchor = editor.getBlock(at.id) as AnyBlock | undefined;
  const sameLine = anchor && editor.getTextCursorPosition().block.id === anchor.id;
  let last: AnyBlock | undefined;
  if (anchor && sameLine && !isEmptyParagraph(anchor) && blocks.length === 1 && blocks[0].type === "paragraph" && Array.isArray(anchor.content)) {
    editor.insertInlineContent(blocks[0].content as never, { updateSelection: true });
  } else if (!anchor) {
    const document = editor.document as AnyBlock[];
    last = editor.insertBlocks(blocks as never, document[document.length - 1], "after").at(-1) as AnyBlock | undefined;
  } else if (isEmptyParagraph(anchor)) {
    last = editor.replaceBlocks([anchor], blocks as never).insertedBlocks.at(-1) as AnyBlock | undefined;
  } else {
    last = editor.insertBlocks(blocks as never, anchor, "after").at(-1) as AnyBlock | undefined;
  }
  const caret = prepared.cursor ? findText(editor, prepared.cursor) : null;
  const view = editor.prosemirrorView;
  if (caret && view) {
    const tr = view.state.tr.delete(caret.from, caret.to);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret.from)));
  } else if (last) {
    try {
      editor.setTextCursorPosition(last.id, "end");
    } catch {
      // A block without text (a divider, an image): the caret stays where it is.
    }
  }
  editor.focus();
}

/** What the placeholders stand for in this editor, read when a snippet goes in. */
export function usePlaceholderContext(me: string, pageTitle: () => string) {
  const locale = useLocale();
  const timeZone = useTimeZone() ?? browserTimeZone();
  const title = useRef(pageTitle);
  useEffect(() => {
    title.current = pageTitle;
  });
  return useCallback(
    (): PlaceholderContext => ({ now: new Date(), locale, timeZone, me, page: title.current() }),
    [locale, timeZone, me],
  );
}

/** Opens only at the start of a line or after a space: a semicolon after a word is just a semicolon. */
function opensAfterSpace(tr: Transaction) {
  const { $from } = tr.selection;
  if ($from.parentOffset === 0) return true;
  const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, undefined, "￼");
  return /\s/.test(before);
}

type InsertOptions = {
  editor: PageEditor;
  workspaceId: string;
  context: () => PlaceholderContext;
  onError: (message: string) => void;
};

function useSnippetItem({ editor, context, onError }: InsertOptions) {
  const t = useTranslations("snippets.menu");
  return useCallback(
    (s: SnippetSummary, group: string): DefaultReactSuggestionItem => ({
      title: s.title,
      subtext: `${SNIPPET_TRIGGER_CHARACTER}${s.trigger}`,
      aliases: [s.trigger],
      group,
      icon: <TextQuote size={18} />,
      onItemClick: () => {
        void insertSnippet(editor, s, context()).catch((error: Error) => onError(t("insertFailed", { error: error.message })));
      },
    }),
    [editor, context, onError, t],
  );
}

/** `;` in the editor: the person's snippets and the workspace's, matched by trigger and title. */
export function SnippetMenu(props: InsertOptions & { enabled: boolean }) {
  const t = useTranslations("snippets.menu");
  const { refresh } = useSnippetLibrary(props.workspaceId, props.enabled);
  const item = useSnippetItem(props);
  const getItems = useCallback(
    async (query: string) => {
      const { snippets } = await refresh().catch(() => ({ snippets: [] as SnippetSummary[] }));
      return matchSnippets(query, snippets).map((s) => item(s, s.scope === "workspace" ? t("workspace") : t("personal")));
    },
    [refresh, item, t],
  );
  if (!props.enabled) return null;
  return <SuggestionMenuController triggerCharacter={SNIPPET_TRIGGER_CHARACTER} shouldOpen={opensAfterSpace} minQueryLength={0} getItems={getItems} />;
}

/** The slash menu's Snippets group: every snippet, found by its title or trigger. */
export function useSnippetSlashItems(options: InsertOptions & { enabled: boolean }) {
  const t = useTranslations("snippets.menu");
  const { library } = useSnippetLibrary(options.workspaceId, options.enabled);
  const item = useSnippetItem(options);
  return useMemo(() => (options.enabled ? library.snippets.map((s) => item(s, t("group"))) : []), [options.enabled, library, item, t]);
}

// ---------------------------------------------------------------------------- saving as a snippet

/** Opens the "Save as snippet" form with this Markdown (see collab-editor and the block menu). */
export type SaveAsSnippet = (markdown: string) => void;

export const SaveAsSnippetContext = createContext<SaveAsSnippet | null>(null);

export const useSaveAsSnippet = () => useContext(SaveAsSnippetContext);

/**
 * "Save as snippet" in the block menu: the block (or the selected blocks, when it is among them)
 * as Markdown, in the snippet form. Saving makes a copy; the blocks stay as they are.
 */
export function SaveAsSnippetItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const save = useSaveAsSnippet();
  const t = useTranslations("snippets.save");
  if (!block || !save) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        const selected = (editor.getSelection()?.blocks ?? []) as AnyBlock[];
        const blocks = selected.some((b) => b.id === block.id) ? selected : [block as AnyBlock];
        void editorBlocksToMarkdown(editor, blocks).then((markdown) => save(markdown.trim()));
      }}
    >
      {t("menuItem")}
    </Components.Generic.Menu.Item>
  );
}

/**
 * Everything an editor needs for snippets: the options of its `;` menu and slash group (on while
 * the person may edit and the server is reachable), what "Save as snippet" calls (not in a synced
 * page's editor, whose blocks have the page's own handles) and the form it opens, with a line saying
 * it was saved.
 */
export function useSnippets({
  editor,
  workspaceId,
  me,
  pageTitle,
  onError,
  editable,
  offline,
  nested,
}: {
  editor: PageEditor;
  workspaceId: string;
  me: string;
  pageTitle: () => string;
  onError: (message: string) => void;
  editable: boolean;
  offline: boolean;
  nested: boolean;
}): { menu: InsertOptions & { enabled: boolean }; save: SaveAsSnippet | null; dialog: ReactNode } {
  const t = useTranslations("snippets.save");
  const context = usePlaceholderContext(me, pageTitle);
  const enabled = editable && !offline;
  const menu = useMemo(() => ({ editor, workspaceId, context, onError, enabled }), [editor, workspaceId, context, onError, enabled]);
  const { library } = useSnippetLibrary(workspaceId, !nested && !offline);
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 5000);
    return () => clearTimeout(timer);
  }, [saved]);
  const dialog = (
    <>
      {draft !== null && (
        <SnippetDialog
          body={draft}
          targets={{ personal: true, workspace: library.manages }}
          me={me}
          onClose={() => setDraft(null)}
          onSaved={(snippet) => {
            setDraft(null);
            announceSnippetsChanged();
            setSaved(t("saved", { trigger: snippet.trigger }));
          }}
        />
      )}
      {saved && (
        <div role="status" className="mx-4 mt-2 md:mx-[54px] rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-sm text-fg-muted">
          {saved}
        </div>
      )}
    </>
  );
  return { menu, save: nested || offline ? null : setDraft, dialog };
}
