"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { MAX_ASSIGN, parseDueDate } from "@/lib/quizzes";
import { AccessError } from "@/server/access";
import {
  assignQuiz,
  copyQuizToPage,
  createQuiz,
  QuizError,
  quizPeople,
  quizResults,
  readQuiz,
  saveQuiz,
  submitQuiz,
  unassignQuiz,
  type QuizPerson,
  type QuizResult,
  type QuizView,
} from "@/server/quizzes";
import { requireUserId } from "@/server/session";

// Quizzes on pages (server/quizzes.ts). Every call checks access to the quiz's own page there:
// reading it to take it, editing its body to change it, see results and ask people to take it.

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;

/** What went wrong, in the person's language. */
async function failure(error: unknown): Promise<{ ok: false; error: string }> {
  const t = await getTranslations("page.quiz.errors");
  if (error instanceof AccessError) return { ok: false, error: t("notFound") };
  if (error instanceof QuizError) {
    const detail = error.detail;
    if (error.code === "settings" && detail) {
      return { ok: false, error: "question" in detail ? t("inQuestion", { number: detail.question + 1, reason: t(`settingsReasons.${detail.code}`) }) : t(`settingsReasons.${detail.code}`) };
    }
    return { ok: false, error: t(error.code) };
  }
  console.error("[quiz action]", error);
  const tc = await getTranslations("common");
  return { ok: false, error: tc("genericError") };
}

/** A new, empty quiz on the page, for a Quiz block added there. */
export async function createQuizAction(pageId: string): Promise<ActionResult<{ id: string }>> {
  const userId = await requireUserId();
  if (!isId(pageId)) return failure(new AccessError());
  try {
    return { ok: true, data: { id: await createQuiz(userId, pageId) } };
  } catch (error) {
    return failure(error);
  }
}

/** The quiz as the person may see it, for its block on `pageId`. */
export async function quizAction(quizId: string, pageId: string): Promise<ActionResult<QuizView>> {
  const userId = await requireUserId();
  if (!isId(quizId) || typeof pageId !== "string") return failure(new AccessError());
  try {
    return { ok: true, data: await readQuiz(userId, quizId, pageId) };
  } catch (error) {
    return failure(error);
  }
}

/** Saves an editor's questions, pass mark and attempts. */
export async function saveQuizAction(quizId: string, settings: unknown): Promise<ActionResult<QuizView>> {
  const userId = await requireUserId();
  if (!isId(quizId)) return failure(new AccessError());
  try {
    return { ok: true, data: await saveQuiz(userId, quizId, settings) };
  } catch (error) {
    return failure(error);
  }
}

/** Sends the person's answers: the server scores and keeps them. */
export async function submitQuizAction(quizId: string, answers: unknown): Promise<ActionResult<QuizView>> {
  const userId = await requireUserId();
  if (!isId(quizId)) return failure(new AccessError());
  try {
    return { ok: true, data: await submitQuiz(userId, quizId, answers) };
  } catch (error) {
    return failure(error);
  }
}

/** Everyone's results, for the quiz's editors. */
export async function quizResultsAction(quizId: string): Promise<ActionResult<QuizResult[]>> {
  const userId = await requireUserId();
  if (!isId(quizId)) return failure(new AccessError());
  try {
    return { ok: true, data: await quizResults(userId, quizId) };
  } catch (error) {
    return failure(error);
  }
}

/** Whom an editor may ask to take the quiz: people who can open its page. */
export async function quizPeopleAction(quizId: string): Promise<ActionResult<QuizPerson[]>> {
  const userId = await requireUserId();
  if (!isId(quizId)) return failure(new AccessError());
  try {
    return { ok: true, data: await quizPeople(userId, quizId) };
  } catch (error) {
    return failure(error);
  }
}

/** Asks people to take the quiz, by a day (YYYY-MM-DD) or whenever. */
export async function assignQuizAction(quizId: string, userIds: string[], due: string | null): Promise<ActionResult<{ added: number }>> {
  const userId = await requireUserId();
  if (!isId(quizId)) return failure(new AccessError());
  if (!Array.isArray(userIds) || userIds.length > MAX_ASSIGN || !userIds.every(isId)) return failure(new QuizError("people"));
  const day = parseDueDate(due);
  if (day === undefined) return failure(new QuizError("due"));
  try {
    return { ok: true, data: await assignQuiz(userId, quizId, userIds, day) };
  } catch (error) {
    return failure(error);
  }
}

/** No longer asks someone to take the quiz. */
export async function unassignQuizAction(quizId: string, personId: string): Promise<ActionResult<null>> {
  const userId = await requireUserId();
  if (!isId(quizId) || !isId(personId)) return failure(new AccessError());
  try {
    await unassignQuiz(userId, quizId, personId);
    return { ok: true, data: null };
  } catch (error) {
    return failure(error);
  }
}

/** Copies a quiz of another page onto this one, for a Quiz block copied here. */
export async function copyQuizAction(quizId: string, pageId: string): Promise<ActionResult<{ id: string }>> {
  const userId = await requireUserId();
  if (!isId(quizId) || !isId(pageId)) return failure(new AccessError());
  try {
    return { ok: true, data: { id: await copyQuizToPage(userId, quizId, pageId) } };
  } catch (error) {
    return failure(error);
  }
}
