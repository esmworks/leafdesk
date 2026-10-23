"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { createReactBlockSpec, useBlockNoteEditor, useComponentsContext, useExtensionState, type DefaultReactSuggestionItem } from "@blocknote/react";
import { NotebookPen } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { MEETING_BLOCK, meetingBlockConfig, meetingProps, newMeetingId } from "@/lib/meetings";
import { useEmbedHost } from "./database-embed";
import { placeEmbedBlock, type PageEditor } from "./embed-blocks";

/**
 * The "Meeting notes" block (lib/meetings.ts): title, when, attendees, recording, and the AI's
 * summary with links into the transcript. Everything it shows is in its props; the view itself is
 * loaded only where such a block is shown.
 */
const MeetingView = dynamic(() => import("./meeting-view").then((m) => m.MeetingView), {
  ssr: false,
  loading: () => <div aria-busy="true" className="my-1 h-32 w-full animate-pulse rounded-lg bg-bg-subtle" />,
});

export const MeetingBlock = createReactBlockSpec(meetingBlockConfig, {
  // A self-contained widget: clicks and keys inside it are its own.
  meta: { selectable: false },
  render: function MeetingBlockView({ block, editor }) {
    const host = useEmbedHost();
    const editable = Boolean(host?.editable) && editor.isEditable;
    const props = useMemo(() => meetingProps(block.props as Record<string, unknown>), [block.props]);
    return (
      <div contentEditable={false} className="w-full" data-meeting={props.meetingId}>
        <MeetingView
          props={props}
          editable={editable}
          pageId={host?.pageId ?? null}
          onChange={(change) => {
            if (editable && editor.getBlock(block.id)) editor.updateBlock(block.id, { props: change });
          }}
        />
      </div>
    );
  },
  // Copied out of the app, a meeting carries its title.
  toExternalHTML: ({ block }) => <p>{String(block.props.title ?? "")}</p>,
});

/** A new meeting block's props: its own id, planned for now. */
const newMeeting = () => ({ type: MEETING_BLOCK, props: { meetingId: newMeetingId(), scheduledAt: new Date().toISOString() } }) as const;

/** The "Meeting notes" slash menu entry (/meeting). */
export function useMeetingSlashItem(editor: PageEditor): DefaultReactSuggestionItem[] {
  const t = useTranslations("meetings.slash");
  const host = useEmbedHost();
  return useMemo(() => {
    if (!host?.editable) return [];
    return [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.table.group,
        icon: <NotebookPen size={18} />,
        onItemClick: () => placeEmbedBlock(editor, editor.getTextCursorPosition().block.id, newMeeting()),
      },
    ];
  }, [editor, host, t]);
}

/** "Add meeting notes below" in the block menu. */
export function AddMeetingItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const host = useEmbedHost();
  const t = useTranslations("meetings");
  if (!block || !host?.editable) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => placeEmbedBlock(editor, block.id, newMeeting())}>
      {t("menuItem")}
    </Components.Generic.Menu.Item>
  );
}
