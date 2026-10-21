"use client";

import { BlockNoteSchema, createParagraphBlockSpec, defaultInlineContentSpecs, defaultStyleSpecs } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import {
  ComponentsContext,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  SuggestionMenuController,
  useBlockNoteContext,
  useBlockNoteEditor,
  useComponentsContext,
  type ComponentProps,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { CircleUser } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, forwardRef, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { commentMentionCandidatesAction } from "@/app/actions/mentions";
import { UserAvatar } from "@/components/user-avatar";
import { mentionInlineSpecs } from "./mentions";
import { newMentionId } from "@/lib/mentions";

// Comments keep the default comment editor's blocks and styles (no colors), and add mentions of
// people: the server notifies them (server/comments) and stores their names as text.
const { textColor: _textColor, backgroundColor: _backgroundColor, ...commentStyleSpecs } = defaultStyleSpecs;

export const commentEditorSchema = BlockNoteSchema.create({
  blockSpecs: { paragraph: createParagraphBlockSpec() },
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

const CommentEditorView = forwardRef<HTMLDivElement, ComponentProps["Comments"]["Editor"]>(function CommentEditorView(
  { className, autoFocus, onFocus, onBlur, editor, editable },
  ref,
) {
  const blockNoteContext = useBlockNoteContext();
  const pageId = useContext(CommentPageContext);
  return (
    <BlockNoteView
      autoFocus={autoFocus}
      className={className}
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
    >
      <FormattingToolbarController formattingToolbar={CommentFormattingToolbar} />
      {editable && pageId && <CommentMentionMenu pageId={pageId} />}
    </BlockNoteView>
  );
});

function CommentFormattingToolbar() {
  const items = getFormattingToolbarItems([]).filter((item) => item.key !== "nestBlockButton" && item.key !== "unnestBlockButton");
  return <FormattingToolbar blockTypeSelectItems={[]}>{items}</FormattingToolbar>;
}

/** `@` in a comment: the people who can open the page. */
function CommentMentionMenu({ pageId }: { pageId: string }) {
  const editor = useBlockNoteEditor<typeof commentEditorSchema.blockSchema, typeof commentEditorSchema.inlineContentSchema>();
  const t = useTranslations("page.mention");
  // The last answer, so typing doesn't flash an empty menu while the next one loads.
  const last = useRef<Awaited<ReturnType<typeof commentMentionCandidatesAction>>>([]);
  const getItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      try {
        last.current = await commentMentionCandidatesAction(pageId, query);
      } catch {
        // Keep the last answer.
      }
      return last.current.map((p) => ({
        title: p.name,
        group: t("people"),
        icon: p.image ? <UserAvatar name={p.name} image={p.image} size="xs" /> : <CircleUser size={18} />,
        onItemClick: () =>
          editor.insertInlineContent([{ type: "mention", props: { kind: "user", id: newMentionId(), userId: p.id, name: p.name } }, " "] as never, {
            updateSelection: true,
          }),
      }));
    },
    [editor, pageId, t],
  );
  return <SuggestionMenuController triggerCharacter="@" getItems={getItems} />;
}
