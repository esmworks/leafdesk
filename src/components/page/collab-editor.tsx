"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "katex/dist/katex.min.css";
import { createExtension } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import {
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { DirectionProvider } from "@mantine/core";
import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBlockFocus } from "./block-focus";
import { commentUsersAction } from "@/app/actions/comments";
import { useDirection } from "@/components/direction";
import { EditorFiles } from "./editor-files";
import { useColorScheme } from "@/components/theme/theme-provider";
import { AskAiToolbarButton, useAiAssist, useAiSlashItems, type AiAssist } from "./ai-assist";
import { useVoiceNote, useVoiceSlashItems, type VoiceNote } from "@/components/voice/voice-note-dialog";
import type { VoiceNoteLimits } from "@/lib/voice-notes";
import { yUndoPluginKey } from "y-prosemirror";
import type * as Y from "yjs";
import type { UndoManager } from "yjs";
import { useEditorDictionary } from "@/i18n/blocknote";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { formatBytes } from "@/lib/files";
import { THREADS_MAP, type CommentAnchor } from "@/lib/comments";
import { CommentsPanel } from "./comments-panel";
import { CommentAuth, ServerThreadStore } from "./comment-store";
import { useColumnSlashItems } from "./columns";
import { FootnoteList, PageTrailProvider, useContentSlashItems, type TrailCrumb } from "./content-blocks";
import { LINKED_VIEW_BLOCK } from "@/lib/embed-blocks";
import { writePageStyle } from "@/lib/page-style";
import { PAGE_LINK_BLOCK, SYNCED_PAGE_BLOCK } from "@/lib/mentions";
import { userColor } from "@/lib/presence";
import { BlockDirection } from "./block-direction";
import { codeHighlighting } from "./code-block";
import { EmbedHostProvider, type EmbedHost } from "./database-embed";
import { FindBar } from "./find-bar";
import { FindReplace } from "./find-replace";
import { DatabasePicker, pageEditorSchema, placeEmbedBlock, useEmbedSlashItems, withEmbedItems, type PageEditor } from "./embed-blocks";
import { MentionMenu, PageLinkMenu, PagePicker, usePageLinkSlashItem, usePageRefUpdates } from "./mentions";
import type { PageDoc } from "./use-page-doc";
import { SyncedFrameProvider, useSyncedFrame, useSyncedPageSlashItem } from "./synced-page";
import { pasteSyncedBlock, useSyncedBlockSlashItem } from "./synced-block";
import { PasteLinkMenu, useWebSlashItems } from "./web-blocks";
import { useColorSlashItems } from "./slash-colors";
import { withTextScriptButtons } from "./text-scripts";
import { withSideAlignButtons } from "./align-buttons";
import { pageSideMenu } from "./table-to-database";
import { SaveAsSnippetContext, SnippetMenu, useSnippets, useSnippetSlashItems } from "./snippets";
import { readDocTitle } from "@/lib/collab-title";

/**
 * y-prosemirror's undo plugin keeps its Y.UndoManager in plugin state but destroys it whenever the
 * editor view is destroyed. BlockNote keeps that state across an unmount, so mounting the same
 * editor again (React StrictMode does it in development) left undo and redo doing nothing. Attach
 * the manager to its document again on every mount; attaching twice is a no-op.
 */
const KeepUndoAttached = createExtension(({ editor }) => ({
  key: "keepUndoAttached",
  mount() {
    const undoManager: UndoManager | undefined = yUndoPluginKey.getState(editor.prosemirrorState)?.undoManager;
    if (!undoManager) return;
    undoManager.trackedOrigins.add(undoManager);
    undoManager.doc.on("afterTransaction", undoManager.afterTransactionHandler);
    undoManager.doc.on("destroy", undoManager.destroy);
  },
}));

export default function CollabEditor({
  pageDoc,
  user,
  editable,
  level,
  workspaceId,
  pageId,
  crumbs,
  commentsOpen: commentsWanted,
  onCloseComments,
  offline = false,
  ai: aiWanted = false,
  voice: voiceWanted = null,
  nested = false,
  fragment = COLLAB_FRAGMENT,
  syncedBlock = false,
}: {
  pageDoc: PageDoc;
  user: { id: string; name: string };
  editable: boolean;
  /**
   * What the viewer may do with comments: "comment" and up write them (their editor may still be
   * read-only), full access also deletes other people's. "view" when the page is in the trash.
   */
  level: "view" | "comment" | "edit" | "full";
  /** The page being edited: new inline databases are created under it. */
  workspaceId: string;
  pageId: string;
  /** The page and the pages above it, for breadcrumb blocks (the last one is the page itself). */
  crumbs: TrailCrumb[];
  commentsOpen: boolean;
  onCloseComments: () => void;
  /** The server can't be reached: typing works, commenting (a server action) doesn't. */
  offline?: boolean;
  /** The AI writing assistant is available (the person may edit, AI is on, the server is reachable). */
  ai?: boolean;
  /** Voice notes are available, with these limits (as for `ai`, and the server can transcribe). */
  voice?: VoiceNoteLimits | null;
  /**
   * The editor of a synced page inside another page's body (see synced-page.tsx): the same editor
   * (and schema, so nothing in the page reads differently), without the page's own find bar, focus
   * on linked blocks, block handles, comments panel and AI.
   */
  nested?: boolean;
  /** The document's fragment to edit: the page body, or a synced block's blocks (see synced-block.tsx). */
  fragment?: string;
  /** The editor of a synced block's blocks: no synced block may go in it. */
  syncedBlock?: boolean;
}) {
  const locale = useLocale();
  const colorScheme = useColorScheme();
  const tc = useTranslations("common");
  const tu = useTranslations("page.upload");
  const dictionary = useEditorDictionary();
  const host = useMemo<EmbedHost>(() => ({ workspaceId, pageId, editable, doc: pageDoc.doc }), [workspaceId, pageId, editable, pageDoc]);
  const trail = useMemo(() => ({ workspaceId, crumbs }), [workspaceId, crumbs]);
  // Block id where "Linked view of database" was chosen, while its database picker is open.
  const [pickAt, setPickAt] = useState<string | null>(null);
  // A dashboard's grid needs the room: the page takes the whole width (the page menu turns it back).
  const widenForDashboard = useCallback(() => writePageStyle(pageDoc.doc, { fullWidth: true }), [pageDoc]);
  // Block id where "Link to page" or "Synced page" was chosen, while its page picker is open.
  const [linkAt, setLinkAt] = useState<{ at: string; type: typeof PAGE_LINK_BLOCK | typeof SYNCED_PAGE_BLOCK } | null>(null);
  const pickLink = useCallback((at: string) => setLinkAt({ at, type: PAGE_LINK_BLOCK }), []);
  const pickSynced = useCallback((at: string) => setLinkAt({ at, type: SYNCED_PAGE_BLOCK }), []);
  const tSynced = useTranslations("page.blocks.syncedPage");
  const tSyncedBlock = useTranslations("page.syncedBlock");
  // The pages shown around this editor, for the synced pages in it (see synced-page.tsx).
  const outer = useSyncedFrame();
  const inSyncedBlock = Boolean(outer?.inSyncedBlock) || syncedBlock;
  const frame = useMemo(
    () => ({ chain: [...(outer?.chain ?? []), pageId], user, offline, inSyncedBlock }),
    // `user` is a new object on every render of the page: its fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outer, pageId, user.id, user.name, offline, inSyncedBlock],
  );
  usePageRefUpdates(workspaceId);
  const [embedError, setEmbedError] = useState<string | null>(null);
  // The side menu's block menu, with "Turn into database" for tables (setEmbedError never changes).
  const sideMenu = useMemo(() => pageSideMenu(setEmbedError), []);
  // Comments live in the page's document; every editor has the extension, so text carrying a
  // comment mark is always understood (an editor without it would drop that text).
  const auth = useMemo(() => new CommentAuth(), []);
  auth.set(user.id, level);
  const canComment = level !== "view";
  const threadStore = useMemo(() => new ServerThreadStore(pageId, pageDoc.doc.getMap(THREADS_MAP), auth), [pageId, pageDoc, auth]);
  const comments = useMemo(
    () => CommentsExtension({ threadStore, resolveUsers: (ids: string[]) => commentUsersAction(pageId, ids) }),
    [pageId, threadStore],
  );
  // Files dropped, pasted or picked in a file block go to the server (see api/files); the block keeps
  // the URL it answers with. Read through a ref, so the editor isn't re-created when these change.
  const uploadTo = useRef({ pageId, tu, setEmbedError, inSyncedBlock, nestedMessage: tSyncedBlock("nested") });
  // After every render, on purpose: the ref always holds the latest values.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- no dependency list is the point
  useEffect(() => {
    uploadTo.current = { pageId, tu, setEmbedError, inSyncedBlock, nestedMessage: tSyncedBlock("nested") };
  });
  const uploadFile = useMemo(
    () => async (file: File) => {
      const { pageId, tu, setEmbedError } = uploadTo.current;
      const res = await fetch(`/api/files?pageId=${encodeURIComponent(pageId)}`, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      });
      const data = (await res.json().catch(() => null)) as { url?: string; code?: string; limit?: number } | null;
      if (!res.ok || !data?.url) {
        const limit = data?.limit ? formatBytes(data.limit) : "";
        const name = file.name || "file";
        setEmbedError(
          data?.code === "tooLarge"
            ? tu("tooLarge", { name, limit })
            : data?.code === "quotaExceeded"
              ? tu("quotaExceeded", { name, limit })
              : data?.code === "storageFailed"
                ? tu("storageFailed", { name })
                : tu("failed", { name }),
        );
        throw new Error(`Upload failed (${res.status})`);
      }
      return data.url;
    },
    [],
  );
  // withCollaboration spreads the remaining options into the editor options, so `dictionary`
  // reaches BlockNote as-is. A language change re-creates the editor against the same Y.Doc;
  // the provider is owned by usePageDoc and is not touched.
  const editor = useCreateBlockNote(
    withCollaboration({
      schema: pageEditorSchema,
      dictionary,
      uploadFile,
      // Selected table cells can be merged into one, and a merged cell split again.
      tables: { splitCells: true },
      extensions: [KeepUndoAttached(), FindReplace(), codeHighlighting(), BlockDirection(), comments],
      // A synced block copied with "Copy synced block" lands as a reference; none lands inside one.
      pasteHandler: ({ event, editor, defaultPasteHandler }) => {
        const { inSyncedBlock, setEmbedError, nestedMessage } = uploadTo.current;
        return pasteSyncedBlock(event, editor as unknown as PageEditor, inSyncedBlock, () => setEmbedError(nestedMessage)) ?? defaultPasteHandler();
      },
      collaboration: {
        fragment: pageDoc.doc.getXmlFragment(fragment),
        provider: { awareness: pageDoc.provider.awareness ?? undefined },
        user: { name: user.name, color: userColor(user.id) },
        showCursorLabels: "activity",
      },
    }),
    [pageDoc, fragment, dictionary, comments, uploadFile],
  );

  // BlockNoteView re-mounts its view whenever its `editable` prop changes, and while it does, a
  // caret inside a link makes the link toolbar read a view that isn't there (moving a page to the
  // trash crashed the page). So the view gets the value it started with, and changes go here.
  const [mountEditable] = useState(editable);
  useLayoutEffect(() => {
    editor.isEditable = editable;
  }, [editor, editable]);

  useEffect(() => {
    threadStore.anchor = () => selectionAnchor(editor);
  }, [threadStore, editor]);

  const ai = aiWanted && !nested;
  const voice = nested ? null : voiceWanted;
  const commentsOpen = commentsWanted && !nested;
  const assistant = useAiAssist(editor, pageId, ai && editable && !offline);
  const voiceNote = useVoiceNote(editor, pageId, voice && editable && !offline ? voice : null);
  // Links to a passage (the AI chat's citations) scroll to its block: the page's own blocks.
  useBlockFocus(!nested);

  // `;` and the slash menu insert snippets, "Save as snippet" in the block menu makes one (snippets.tsx).
  const pageTitle = () => readDocTitle(pageDoc.doc) ?? crumbs.at(-1)?.title ?? "";
  const snippets = useSnippets({ editor, workspaceId, me: user.name, pageTitle, onError: setEmbedError, editable, offline, nested });

  // The editor's menus and its block handles follow the interface language's direction: right to
  // left, the handles sit to the right of the blocks and submenus open to the left.
  const dir = useDirection();
  const sideMenuPlacement = useMemo(
    () => ({ useFloatingOptions: { placement: dir === "rtl" ? ("right-start" as const) : ("left-start" as const) } }),
    [dir],
  );

  // Keyed by language so the new editor mounts into a fresh element.
  return (
    <SyncedFrameProvider value={frame}>
      <EmbedHostProvider value={host}>
        <PageTrailProvider value={trail}>
          {/* Search works for everyone; replacing only for people who may edit. */}
          {!nested && <FindBar editor={editor} editable={editable} />}
          <DirectionProvider initialDirection={dir}>
            <BlockNoteView
              key={locale}
              editor={editor}
              theme={colorScheme}
              editable={mountEditable}
              slashMenu={false}
              sideMenu={false}
              formattingToolbar={false}
              className="leafdesk-editor"
            >
              {/*
                BlockNote shows one block handle at a time, for the editor it finds first under the
                pointer: the page's own. A synced page's blocks are added with "/" instead, and the
                page's handle moves the synced page as a whole.
              */}
              {!nested && (
                <SaveAsSnippetContext.Provider value={snippets.save}>
                  <SideMenuController sideMenu={sideMenu} floatingUIOptions={sideMenuPlacement} />
                </SaveAsSnippetContext.Provider>
              )}
              <SlashMenu
                editor={editor}
                onCreateError={setEmbedError}
                onPickDatabase={setPickAt}
                onPickPage={pickLink}
                onPickSynced={pickSynced}
                onDashboard={widenForDashboard}
                doc={pageDoc.doc}
                assistant={ai && editable && !offline ? assistant : null}
                voiceNote={voice && editable && !offline ? voiceNote : null}
                snippets={snippets.menu}
              />
              <SnippetMenu {...snippets.menu} />
              {editable && <MentionMenu editor={editor} workspaceId={workspaceId} pageId={pageId} />}
              {editable && <PageLinkMenu editor={editor} workspaceId={workspaceId} pageId={pageId} offline={offline} />}
              <PasteLinkMenu editor={editor} />
              {/* People who may only read get no toolbar; commenting shows it on read-only pages too. */}
              {(editable || canComment) && (
                <FormattingToolbarController
                  formattingToolbar={() => (
                    <FormattingToolbar>
                      {ai && editable && !offline && <AskAiToolbarButton key="askAi" onOpen={() => assistant.open()} />}
                      {withSideAlignButtons(withTextScriptButtons(getFormattingToolbarItems())).filter((item) => (canComment && !offline) || item.key !== "addCommentButton")}
                    </FormattingToolbar>
                  )}
                />
              )}
              {commentsOpen && <CommentsPanel onClose={onCloseComments} />}
              <EditorFiles editor={editor} editable={editable} />
            </BlockNoteView>
            {/* A synced page's notes are listed on its own page. */}
            {!nested && <FootnoteList editor={editor} />}
          </DirectionProvider>
          {assistant.panel}
          {voiceNote.dialog}
        </PageTrailProvider>
        {snippets.dialog}
        {embedError && (
          <div role="alert" className="mx-4 mt-2 md:mx-[54px] flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-sm">
            <span className="flex-1 text-danger">{embedError}</span>
            <button
              type="button"
              aria-label={tc("close")}
              onClick={() => setEmbedError(null)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <DatabasePicker
          open={pickAt !== null}
          workspaceId={workspaceId}
          onClose={() => setPickAt(null)}
          onPick={(databaseId) => {
            if (pickAt) placeEmbedBlock(editor, pickAt, { type: LINKED_VIEW_BLOCK, props: { databaseId, view: "" } });
            setPickAt(null);
          }}
        />
        <PagePicker
          open={linkAt !== null}
          pageId={pageId}
          title={linkAt?.type === SYNCED_PAGE_BLOCK ? tSynced("title") : undefined}
          onClose={() => setLinkAt(null)}
          onPick={(target) => {
            if (linkAt) placeEmbedBlock(editor, linkAt.at, { type: linkAt.type, props: { pageId: target } });
            setLinkAt(null);
          }}
        />
      </EmbedHostProvider>
    </SyncedFrameProvider>
  );
}

/**
 * Where a new comment goes: the selected text in the block where the selection starts (a comment
 * stays within one paragraph), as the server finds it again.
 */
function selectionAnchor(editor: PageEditor): CommentAnchor | undefined {
  const { selection, doc } = editor.prosemirrorState;
  if (selection.empty) return undefined;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return undefined;
  const quote = doc.textBetween(selection.from, Math.min(selection.to, $from.end()), undefined, "\uFFFC");
  if (!quote) return undefined;
  const block = $from.node($from.depth - 1);
  return { quote, blockId: typeof block.attrs.id === "string" ? block.attrs.id : undefined, offset: $from.parentOffset };
}

/** BlockNote's slash menu plus the database, content, column and page link blocks. */
function SlashMenu({
  editor,
  onCreateError,
  onPickDatabase,
  onPickPage,
  onPickSynced,
  onDashboard,
  doc,
  assistant,
  voiceNote,
  snippets,
}: {
  editor: PageEditor;
  onCreateError: (message: string) => void;
  onPickDatabase: (at: string) => void;
  onPickPage: (at: string) => void;
  onPickSynced: (at: string) => void;
  /** A dashboard was added from the menu. */
  onDashboard: () => void;
  /** The page's document, for new synced blocks. */
  doc: Y.Doc;
  /** The AI writing assistant, when available: its entries go at the end of the menu. */
  assistant: AiAssist | null;
  /** Voice notes, when available: "Voice note" joins the AI entries. */
  voiceNote: VoiceNote | null;
  /** Inserting snippets: their group lists every one the person can use. */
  snippets: Parameters<typeof useSnippetSlashItems>[0];
}) {
  const embedItems = useEmbedSlashItems(editor, { onCreateError, onPickDatabase, onDashboard });
  const contentItems = useContentSlashItems(editor);
  const webItems = useWebSlashItems(editor);
  const pageLinkItems = usePageLinkSlashItem(editor, onPickPage);
  const syncedPageItems = useSyncedPageSlashItem(editor, onPickSynced);
  const placeSynced = useCallback((at: string, block: Parameters<typeof placeEmbedBlock>[2]) => placeEmbedBlock(editor, at, block), [editor]);
  const syncedBlockItems = useSyncedBlockSlashItem(editor, doc, placeSynced);
  const columnItems = useColumnSlashItems(editor);
  const colorItems = useColorSlashItems(editor);
  const aiItems = useAiSlashItems(assistant?.open ?? noop, assistant !== null);
  const voiceItems = useVoiceSlashItems(voiceNote?.open ?? noop, voiceNote !== null);
  const snippetItems = useSnippetSlashItems(snippets);
  return (
    <SuggestionMenuController
      triggerCharacter="/"
      getItems={async (query) =>
        filterSuggestionItems(
          withEmbedItems(getDefaultReactSlashMenuItems(editor), [
            ...embedItems(),
            ...contentItems,
            ...columnItems(),
            ...webItems,
            ...pageLinkItems,
            ...syncedPageItems,
            ...syncedBlockItems,
            ...colorItems(),
            ...snippetItems,
            ...aiItems,
            ...voiceItems,
          ]),
          query,
        )
      }
    />
  );
}

const noop = () => {};
