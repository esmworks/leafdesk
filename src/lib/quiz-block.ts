// Client-safe and small: the Quiz block's config and its Markdown line, shared by the editor's
// schema (components/page/quiz-block.tsx), the server's (server/blocknote.ts), Markdown
// (lib/content-markdown.ts) and the export (server/export.ts). The quiz itself is lib/quizzes.ts.

/**
 * The Quiz block: questions about the page that its readers answer (server/quizzes.ts). The block
 * holds only the quiz's id. Everything else, the right answers above all, lives in the `quiz` table:
 * every reader gets the page's document, and BlockNote writes every prop into published HTML.
 */
export const QUIZ_BLOCK = "quiz";

export const quizBlockConfig = {
  type: QUIZ_BLOCK,
  propSchema: { quizId: { default: "" } },
  content: "none",
} as const;

/**
 * In Markdown (stored for search and history, read and written by MCP) the block is one line naming
 * its quiz; exported Markdown says only that a quiz is there, and how many questions it has.
 *
 *   <!-- leafdesk:quiz 5b1e… -->
 */
const QUIZ_LINE = /^ {0,3}<!--\s*leafdesk:quiz(?:\s+([\w-]{1,64}))?\s*-->\s*$/;

export const quizLine = (quizId: string) => `<!-- leafdesk:quiz${quizId ? ` ${quizId}` : ""} -->`;

/** The quiz id a Markdown line names ("" for a block not set up yet), or null for another line. */
export function parseQuizLine(line: string): string | null {
  const match = QUIZ_LINE.exec(line);
  return match ? (match[1] ?? "") : null;
}

/** Replaces each quiz line of a Markdown body, outside code fences. */
export function mapQuizLines(markdown: string, fn: (quizId: string) => string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opens = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (opens && opens[1][0] === fence[0] && opens[1].length >= fence.length && !line.trim().slice(opens[1].length).trim()) fence = null;
        return line;
      }
      if (opens) {
        fence = opens[1];
        return line;
      }
      const found = parseQuizLine(line);
      return found === null ? line : fn(found);
    })
    .join("\n");
}

/**
 * The `quiz_finished` inbox item's `message`: the score of the attempt that finished the quiz for
 * the person it was asked of, and whether it passed.
 */
export type QuizNotice = { score: number; passed: boolean };

export const quizNoticeMessage = (notice: QuizNotice) => `${notice.passed ? "passed" : "failed"}:${notice.score}`;

export function parseQuizNotice(message: string | null | undefined): QuizNotice | null {
  const match = /^(passed|failed):(\d{1,3})$/.exec(message ?? "");
  return match ? { passed: match[1] === "passed", score: Math.min(100, Number(match[2])) } : null;
}
