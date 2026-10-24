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
import { useTranslations } from "next-intl";
import { createContext, forwardRef, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { commentMentionCandidatesAction } from "@/app/actions/mentions";
import { searchFold } from "@/lib/search-fold";
import { agentItem, groupItem, mentionInlineSpecs, personItem } from "./mentions";

// Comments keep the default comment editor's blocks and styles (no colors), and add mentions of
// people, groups and agents: the server notifies the people (and the groups' members), starts the
// agents (server/comments) and stores their names as text.
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
