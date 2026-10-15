"use client";

/**
 * "Voice note" in the page editor's slash menu: a dialog records a note, the server writes it up
 * (see voice-note-recorder.tsx), and it goes in where the slash menu was opened: the AI's title as
 * a heading, the note, and the transcript in a toggle under it. Like the AI assistant's
 * suggestions, the page is saved to its history first and the blocks are added in this editor, so
 * everyone sees them live and Undo takes them back.
 */
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import { Mic, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { snapshotBeforeAiEditAction } from "@/app/actions/ai";
import { Dialog, IconButton } from "@/components/ui";
import { demoteHeadings, transcriptBlock, type VoiceNoteDraft, type VoiceNoteLimits } from "@/lib/voice-notes";
import type { PageEditor } from "@/components/page/embed-blocks";
import { VoiceNoteRecorder } from "./voice-note-recorder";

type AnyBlock = PageEditor["document"][number];

export type VoiceNote = { open: () => void; dialog: ReactNode };

/** The blocks a written-up note becomes: its title, the note, and the transcript in a toggle. */
function noteBlocks(editor: PageEditor, draft: VoiceNoteDraft, transcriptLabel: string): AnyBlock[] {
  const body = editor.tryParseMarkdownToBlocks(demoteHeadings(draft.markdown)) as AnyBlock[];
  return [
    ...(draft.title ? [{ type: "heading", props: { level: 2 }, content: draft.title } as unknown as AnyBlock] : []),
    ...body,
    transcriptBlock(draft.transcript, transcriptLabel) as unknown as AnyBlock,
  ];
}

/** The dialog's state for one editor; `limits` null when voice notes aren't available here. */
export function useVoiceNote(editor: PageEditor, pageId: string, limits: VoiceNoteLimits | null): VoiceNote {
  const t = useTranslations("page.voiceNote");
  const [at, setAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(() => {
    if (!limits) return;
    setError(null);
    setAt(editor.getTextCursorPosition().block.id);
  }, [editor, limits]);

  const close = useCallback(() => {
    setAt(null);
    setBusy(false);
  }, []);

  const insert = useCallback(
    async (draft: VoiceNoteDraft) => {
      if (!at) return;
      const saved = await snapshotBeforeAiEditAction(pageId);
      if (!saved.ok) return setError(saved.error);
      try {
        const blocks = noteBlocks(editor, draft, t("transcriptToggle"));
        const anchor = editor.getBlock(at) as AnyBlock | undefined;
        const document = editor.document as AnyBlock[];
        if (!anchor) editor.insertBlocks(blocks as never, document[document.length - 1], "after");
        else {
          const empty = anchor.type === "paragraph" && Array.isArray(anchor.content) && anchor.content.length === 0 && !anchor.children.length;
          if (empty) editor.replaceBlocks([anchor], blocks as never);
          else editor.insertBlocks(blocks as never, anchor, "after");
        }
        close();
      } catch {
        setError(t("errors.insert"));
      }
    },
    [at, close, editor, pageId, t],
  );

  const dialog =
    limits && at ? (
      <Dialog open onClose={busy ? () => {} : close} className="max-w-md">
        <div className="flex items-start gap-2 border-b border-border px-4 py-3">
          <Mic size={16} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t("dialogTitle")}</h2>
            <p className="mt-0.5 text-xs text-fg-muted">{t("dialogDescription")}</p>
          </div>
          <IconButton label={t("close")} onClick={close}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="space-y-2 p-4">
          <VoiceNoteRecorder limits={limits} fields={{ pageId }} onDraft={(draft) => void insert(draft)} onBusyChange={setBusy} />
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    ) : null;

  return { open, dialog };
}

/** The slash menu's "Voice note" entry, in the AI group. */
export function useVoiceSlashItems(open: () => void, enabled: boolean): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.voiceNote");
  const ta = useTranslations("ai.assistant");
  return useMemo(() => {
    if (!enabled) return [];
    return [
      {
        title: t("slashTitle"),
        subtext: t("slashSubtext"),
        aliases: t("slashAliases").split(" "),
        group: ta("group"),
        icon: <Mic size={18} />,
        // After the slash menu removed "/…" and put the cursor back.
        onItemClick: () => setTimeout(open),
      },
    ];
  }, [enabled, open, t, ta]);
}
