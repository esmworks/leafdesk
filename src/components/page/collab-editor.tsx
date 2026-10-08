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
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBlockFocus } from "./block-focus";
import { commentUsersAction } from "@/app/actions/comments";
import { useColorScheme } from "@/components/theme/theme-provider";
import { AskAiToolbarButton, useAiAssist, useAiSlashItems, type AiAssist } from "./ai-assist";
import { yUndoPluginKey } from "y-prosemirror";
import type { UndoManager } from "yjs";
import { useEditorDictionary } from "@/i18n/blocknote";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { formatBytes } from "@/lib/files";
import { THREADS_MAP, type CommentAnchor } from "@/lib/comments";
import { CommentsPanel } from "./comments-panel";
import { CommentAuth, ServerThreadStore } from "./comment-store";
import { useColumnSlashItems } from "./columns";
import { PageTrailProvider, useContentSlashItems, type TrailCrumb } from "./content-blocks";
import { LINKED_VIEW_BLOCK } from "@/lib/embed-blocks";
import { PAGE_LINK_BLOCK } from "@/lib/mentions";
import { userColor } from "@/lib/presence";
import { EmbedHostProvider, type EmbedHost } from "./database-embed";
import { FindBar } from "./find-bar";
import { FindReplace } from "./find-replace";
import { DatabasePicker, pageEditorSchema, placeEmbedBlock, useEmbedSlashItems, withEmbedItems, type PageEditor } from "./embed-blocks";
import { MentionMenu, PagePicker, usePageLinkSlashItem, usePageRefUpdates } from "./mentions";
import type { PageDoc } from "./use-page-doc";
import { PasteLinkMenu, useWebSlashItems } from "./web-blocks";

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
  commentsOpen,
  onCloseComments,
  offline = false,
  ai = false,
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
}) {
  const locale = useLocale();
  const colorScheme = useColorScheme();
  const tc = useTranslations("common");
  const tu = useTranslations("page.upload");
  const dictionary = useEditorDictionary();
  const host = useMemo<EmbedHost>(() => ({ workspaceId, pageId, editable }), [workspaceId, pageId, editable]);
  const trail = useMemo(() => ({ workspaceId, crumbs }), [workspaceId, crumbs]);
  // Block id where "Linked view of database" was chosen, while its database picker is open.
  const [pickAt, setPickAt] = useState<string | null>(null);
  // Block id where "Link to page" was chosen, while its page picker is open.
  const [linkAt, setLinkAt] = useState<string | null>(null);
  usePageRefUpdates(workspaceId);
  const [embedError, setEmbedError] = useState<string | null>(null);
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
  const uploadTo = useRef({ pageId, tu, setEmbedError });
  // After every render, on purpose: the ref always holds the latest values.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- no dependency list is the point
  useEffect(() => {
    uploadTo.current = { pageId, tu, setEmbedError };
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
      extensions: [KeepUndoAttached(), FindReplace(), comments],
      collaboration: {
        fragment: pageDoc.doc.getXmlFragment(COLLAB_FRAGMENT),
        provider: { awareness: pageDoc.provider.awareness ?? undefined },
        user: { name: user.name, color: userColor(user.id) },
        showCursorLabels: "activity",
      },
    }),
    [pageDoc, dictionary, comments, uploadFile],
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

  const assistant = useAiAssist(editor, pageId, ai && editable && !offline);
  // Links to a passage (the AI chat's citations) scroll to its block.
  useBlockFocus();

  // Keyed by language so the new editor mounts into a fresh element.
  return (
    <EmbedHostProvider value={host}>
      <PageTrailProvider value={trail}>
        {/* Search works for everyone; replacing only for people who may edit. */}
        <FindBar editor={editor} editable={editable} />
        <BlockNoteView
          key={locale}
          editor={editor}
          theme={colorScheme}
          editable={mountEditable}
          slashMenu={false}
          formattingToolbar={false}
          className="leafdesk-editor"
        >
          <SlashMenu
            editor={editor}
            onCreateError={setEmbedError}
            onPickDatabase={setPickAt}
            onPickPage={setLinkAt}
            assistant={ai && editable && !offline ? assistant : null}
          />
          {editable && <MentionMenu editor={editor} workspaceId={workspaceId} pageId={pageId} />}
          <PasteLinkMenu editor={editor} />
          {/* People who may only read get no toolbar; commenting shows it on read-only pages too. */}
          {(editable || canComment) && (
            <FormattingToolbarController
              formattingToolbar={() => (
                <FormattingToolbar>
                  {ai && editable && !offline && <AskAiToolbarButton key="askAi" onOpen={() => assistant.open()} />}
                  {getFormattingToolbarItems().filter((item) => (canComment && !offline) || item.key !== "addCommentButton")}
                </FormattingToolbar>
              )}
            />
          )}
          {commentsOpen && <CommentsPanel onClose={onCloseComments} />}
        </BlockNoteView>
        {assistant.panel}
      </PageTrailProvider>
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
        onClose={() => setLinkAt(null)}
        onPick={(target) => {
          if (linkAt) placeEmbedBlock(editor, linkAt, { type: PAGE_LINK_BLOCK, props: { pageId: target } });
          setLinkAt(null);
        }}
      />
    </EmbedHostProvider>
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
  assistant,
}: {
  editor: PageEditor;
  onCreateError: (message: string) => void;
  onPickDatabase: (at: string) => void;
  onPickPage: (at: string) => void;
  /** The AI writing assistant, when available: its entries go at the end of the menu. */
  assistant: AiAssist | null;
}) {
  const embedItems = useEmbedSlashItems(editor, { onCreateError, onPickDatabase });
  const contentItems = useContentSlashItems(editor);
  const webItems = useWebSlashItems(editor);
  const pageLinkItems = usePageLinkSlashItem(editor, onPickPage);
  const columnItems = useColumnSlashItems(editor);
  const aiItems = useAiSlashItems(assistant?.open ?? noop, assistant !== null);
  return (
    <SuggestionMenuController
      triggerCharacter="/"
      getItems={async (query) =>
        filterSuggestionItems(
          withEmbedItems(getDefaultReactSlashMenuItems(editor), [...embedItems(), ...contentItems, ...columnItems(), ...webItems, ...pageLinkItems, ...aiItems]),
          query,
        )
      }
    />
  );
}

const noop = () => {};
