"use client";

import { BlockNoteSchema, createParagraphBlockSpec, defaultInlineContentSpecs, defaultStyleSpecs } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import {
  ComponentsContext,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  createReactBlockSpec,
  SuggestionMenuController,
  useBlockNoteContext,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
  type ComponentProps,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { ImagePlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, forwardRef, useCallback, useContext, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { commentMentionCandidatesAction } from "@/app/actions/mentions";
import { CommentImageGallery } from "@/components/comment-images";
import { showToast } from "@/components/toast";
import { IconButton } from "@/components/ui";
import { COMMENT_IMAGE_TYPES, commentText, isEmojiOnly, MAX_COMMENT_IMAGES } from "@/lib/comments";
import { formatBytes } from "@/lib/files";
import { searchFold } from "@/lib/search-fold";
import { agentItem, groupItem, mentionInlineSpecs, personItem } from "./mentions";

// Comments keep the default comment editor's blocks and styles (no colors), and add mentions of
// people, groups and agents: the server notifies the people (and the groups' members), starts the
// agents (server/comments) and stores their names as text. Images attached to a comment are one
// block after its text (lib/comments CommentImages).
const { textColor: _textColor, backgroundColor: _backgroundColor, ...commentStyleSpecs } = defaultStyleSpecs;

const urlsOf = (urls: string) => urls.split("\n").filter(Boolean);

const CommentImagesBlock = createReactBlockSpec(
  { type: "images", propSchema: { urls: { default: "" } }, content: "none" } as const,
  {
    render: function CommentImagesView({ block, editor }) {
      const urls = urlsOf(block.props.urls);
      const onRemove = editor.isEditable
        ? (url: string) => {
            const rest = urls.filter((other) => other !== url);
            if (rest.length) editor.updateBlock(block, { props: { urls: rest.join("\n") } });
            else editor.removeBlocks([block]);
          }
        : undefined;
      return <CommentImageGallery urls={urls} onRemove={onRemove} />;
    },
  },
);

export const commentEditorSchema = BlockNoteSchema.create({
  blockSpecs: { paragraph: createParagraphBlockSpec(), images: CommentImagesBlock() },
  inlineContentSpecs: { ...defaultInlineContentSpecs, ...mentionInlineSpecs },
  styleSpecs: commentStyleSpecs,
});

const CommentPageContext = createContext<string | null>(null);

/**
 * The comment UI inside it (the threads panel, the floating composer and thread) writes comments
 * in an editor with an @ menu for people.
 */
export function CommentComponents({ pageId, children }: { pageId: string; children: ReactNode }) {
  const components = useComponentsContext();
  const value = useMemo(
    () => (components ? { ...components, Comments: { ...components.Comments, Editor: CommentEditorView } } : undefined),
    [components],
  );
  return (
    <CommentPageContext.Provider value={pageId}>
      <ComponentsContext.Provider value={value}>{children}</ComponentsContext.Provider>
    </CommentPageContext.Provider>
  );
}

type CommentEditor = ComponentProps["Comments"]["Editor"]["editor"];

const CommentEditorView = forwardRef<HTMLDivElement, ComponentProps["Comments"]["Editor"]>(function CommentEditorView(
  { className, autoFocus, onFocus, onBlur, editor, editable },
  ref,
) {
  const blockNoteContext = useBlockNoteContext();
  const pageId = useContext(CommentPageContext);
  // A comment of only a few emoji shows them large.
  const emojiOnly = useEditorState({
    editor,
    selector: ({ editor }) => !editable && editor.document.every((block) => block.type === "paragraph") && isEmojiOnly(commentText(editor.document)),
  });
  const attach = useCommentImages(editor, pageId);
  const files = useRef<HTMLInputElement>(null);
  const images = (list: FileList | null | undefined) => [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
  const onPaste = (event: ClipboardEvent) => {
    const found = images(event.clipboardData?.files);
    if (!found.length) return;
    event.preventDefault();
    void attach.add(found);
  };
  const onDrop = (event: DragEvent) => {
    const found = images(event.dataTransfer?.files);
    if (!found.length) return;
    event.preventDefault();
    void attach.add(found);
  };
  return (
    <BlockNoteView
      autoFocus={autoFocus}
      className={emojiOnly ? `${className ?? ""} comment-emoji` : className}
      editor={editor}
      sideMenu={false}
      slashMenu={false}
      tableHandles={false}
      filePanel={false}
      formattingToolbar={false}
      editable={editable}
      theme={blockNoteContext?.colorSchemePreference}
      ref={ref}
      onFocus={onFocus}
      onBlur={onBlur}
      onPasteCapture={editable && pageId ? onPaste : undefined}
      onDropCapture={editable && pageId ? onDrop : undefined}
    >
      <FormattingToolbarController formattingToolbar={CommentFormattingToolbar} />
      {editable && pageId && <CommentMentionMenu pageId={pageId} />}
      {editable && pageId && (
        <div className="flex px-1 pb-0.5">
          <IconButton label={attach.label} className="h-6 w-6 text-fg-muted" disabled={attach.busy} onClick={() => files.current?.click()}>
            <ImagePlus className="h-3.5 w-3.5" />
          </IconButton>
          <input
            ref={files}
            type="file"
            accept={COMMENT_IMAGE_TYPES.join(",")}
            multiple
            hidden
            onChange={(event) => {
              const found = images(event.target.files);
              event.target.value = "";
              if (found.length) void attach.add(found);
            }}
          />
        </div>
      )}
    </BlockNoteView>
  );
});

/**
 * Attaching images to the comment being written: each is uploaded to the page (people who may
 * only comment can upload images there, see server/files uploadCommentImage), then added to the
 * comment's images block, made after its text if it has none yet.
 */
function useCommentImages(editor: CommentEditor, pageId: string | null) {
  const t = useTranslations("page.comments");
  const tu = useTranslations("page.upload");
  const [busy, setBusy] = useState(false);
  const add = async (files: File[]) => {
    if (!pageId) return;
    const block = editor.document.find((b) => b.type === "images");
    const had = block ? urlsOf(String(block.props.urls ?? "")) : [];
    const room = MAX_COMMENT_IMAGES - had.length;
    if (files.length > room) showToast({ message: t("tooManyImages", { count: MAX_COMMENT_IMAGES }) });
    if (room <= 0) return;
    setBusy(true);
    const urls: string[] = [];
    try {
      for (const file of files.slice(0, room)) {
        const url = await uploadCommentImage(pageId, file).catch((error: UploadError) => {
          const name = file.name || "image";
          const limit = error.limit ? formatBytes(error.limit) : "";
          showToast({
            message:
              error.code === "tooLarge"
                ? tu("tooLarge", { name, limit })
                : error.code === "quotaExceeded"
                  ? tu("quotaExceeded", { name, limit })
                  : error.code === "storageFailed"
                    ? tu("storageFailed", { name })
                    : tu("failed", { name }),
          });
          return null;
        });
        if (url) urls.push(url);
      }
    } finally {
      setBusy(false);
    }
    if (!urls.length) return;
    // Read again: the comment may have changed while the files went up.
    const current = editor.document.find((b) => b.type === "images");
    if (current) {
      const all = [...new Set([...urlsOf(String(current.props.urls ?? "")), ...urls])].slice(0, MAX_COMMENT_IMAGES);
      editor.updateBlock(current, { props: { urls: all.join("\n") } });
    } else {
      editor.insertBlocks([{ type: "images", props: { urls: urls.join("\n") } }], editor.document.at(-1)!, "after");
    }
  };
  return { add, busy, label: t("attachImages") };
}

type UploadError = Error & { code?: string; limit?: number };

async function uploadCommentImage(pageId: string, file: File): Promise<string> {
  const res = await fetch(`/api/files?pageId=${encodeURIComponent(pageId)}&comment=1`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
  });
  const data = (await res.json().catch(() => null)) as { url?: string; code?: string; limit?: number } | null;
  if (!res.ok || !data?.url) throw Object.assign(new Error(`Upload failed (${res.status})`), { code: data?.code, limit: data?.limit });
  return data.url;
}

function CommentFormattingToolbar() {
  const items = getFormattingToolbarItems([]).filter((item) => item.key !== "nestBlockButton" && item.key !== "unnestBlockButton");
  return <FormattingToolbar blockTypeSelectItems={[]}>{items}</FormattingToolbar>;
}

/** `@` in a comment: the people who can open the page, the workspace's groups, then the agents that may answer there. */
function CommentMentionMenu({ pageId }: { pageId: string }) {
  const editor = useBlockNoteEditor<typeof commentEditorSchema.blockSchema, typeof commentEditorSchema.inlineContentSchema>();
  const t = useTranslations("page.mention");
  // The last answer, so typing doesn't flash an empty menu while the next one loads.
  const last = useRef<Awaited<ReturnType<typeof commentMentionCandidatesAction>>>({ people: [], groups: [], agents: [] });
  const getItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      let found = last.current;
      try {
        found = last.current = await commentMentionCandidatesAction(pageId, query);
      } catch {
        // Keep the last answer, but only the people and agents who still match.
        const q = searchFold(query.trim());
        const matches = (name: string) => !q || searchFold(name).includes(q);
        found = {
          people: found.people.filter((p) => matches(p.name)),
          groups: found.groups.filter((g) => matches(g.name)),
          agents: found.agents.filter((a) => matches(a.name)),
        };
      }
      return [
        ...found.people.map((p) => personItem(editor, p, t("people"))),
        ...found.groups.map((g) => groupItem(editor, g, t("groups"), (count) => t("groupMembers", { count }))),
        ...found.agents.map((a) => agentItem(editor, a, t("agents"))),
      ];
    },
    [editor, pageId, t],
  );
  return <SuggestionMenuController triggerCharacter="@" getItems={getItems} />;
}
