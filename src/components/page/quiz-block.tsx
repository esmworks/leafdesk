"use client";

import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { ListChecks } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { createQuizAction } from "@/app/actions/quizzes";
import { lazyPart } from "@/components/lazy-part";
import { Button } from "@/components/ui";
import { QUIZ_BLOCK, quizBlockConfig } from "@/lib/quiz-block";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";

/**
 * The Quiz block (lib/quiz-block.ts): questions about the page that its readers answer, scored on
 * the server (server/quizzes.ts). The block holds only the quiz's id; what the reader may see of
 * it, and whether they may change it, is the server's to say. The quiz itself loads only where
 * such a block is shown.
 */
const QuizPanel = lazyPart(
  () => import("./quiz-view").then((m) => m.QuizPanel),
  <div aria-busy="true" className="my-1 h-24 w-full animate-pulse rounded-lg bg-bg-subtle" />,
);

export const QuizBlock = createReactBlockSpec(quizBlockConfig, {
  // A self-contained widget: clicks and keys inside it are its own.
  meta: { selectable: false },
  render: function QuizBlockView({ block, editor }) {
    const t = useTranslations("page.quiz");
    const host = useEmbedHost();
    const { quizId } = block.props;
    const editable = Boolean(host?.editable) && editor.isEditable;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const point = (id: string) => {
      if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { quizId: id } });
    };

    if (!host || !quizId) {
      // Outside a page (history, previews), or a block written in Markdown without a quiz yet.
      const setUp = async () => {
        if (!host) return;
        setBusy(true);
        setError(null);
        try {
          const res = await createQuizAction(host.pageId);
          if (res.ok) point(res.data.id);
          else setError(res.error);
        } finally {
          setBusy(false);
        }
      };
      return (
        <div contentEditable={false} className="my-1 flex w-full flex-wrap items-center gap-2 rounded-lg bg-bg-subtle px-3 py-3 text-sm text-fg-muted">
          <ListChecks className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{host ? t("notSetUp") : t("label")}</span>
          {host && editable && (
            <Button size="sm" disabled={busy} onClick={() => void setUp()}>
              {t("setUp")}
            </Button>
          )}
          {error && (
            <span role="alert" className="w-full text-xs text-danger">
              {error}
            </span>
          )}
        </div>
      );
    }
    return (
      <div contentEditable={false} className="w-full" data-quiz={quizId}>
        <QuizPanel quizId={quizId} pageId={host.pageId} editable={editable} onPoint={point} />
      </div>
    );
  },
  // Copied out of the app, a quiz carries nothing: its questions and answers stay in it.
  toExternalHTML: () => <div />,
});

/** The "Quiz" slash menu entry: makes the quiz on the server, then adds the block naming it. */
export function useQuizSlashItem(editor: PageEditor, onPlace: (at: string, block: { type: typeof QUIZ_BLOCK; props: { quizId: string } }) => void): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.quiz.slash");
  const host = useEmbedHost();
  return useMemo(() => {
    if (!host?.editable) return [];
    return [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.table.group,
        icon: <ListChecks size={18} />,
        onItemClick: () => {
          const at = editor.getTextCursorPosition().block.id;
          // A quiz that couldn't be made yet leaves a block that offers to set it up.
          void createQuizAction(host.pageId)
            .then((res) => onPlace(at, { type: QUIZ_BLOCK, props: { quizId: res.ok ? res.data.id : "" } }))
            .catch(() => onPlace(at, { type: QUIZ_BLOCK, props: { quizId: "" } }));
        },
      },
    ];
  }, [editor, host, t, onPlace]);
}
