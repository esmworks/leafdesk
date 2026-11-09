import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import * as Y from "yjs";
import { db } from "@/db";
import { notification, page, quiz, quizAssignment, quizAttempt, user } from "@/db/schema";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import type { DuplicatePlan } from "@/lib/duplicate";
import { mapQuizLines, QUIZ_BLOCK, quizLine, quizNoticeMessage } from "@/lib/quiz-block";
import {
  attemptsLeft,
  checkQuiz,
  cleanAnswers,
  DEFAULT_PASS_MARK,
  MAX_ASSIGN,
  passes,
  quizDone,
  scoreAnswers,
  storedQuestions,
  withoutAnswers,
  type QuizAnswers,
  type QuizQuestionView,
  type QuizSettingsError,
} from "@/lib/quizzes";
import { AccessError, getMembership, hasLevel, requirePageAccess, resolvePageAccess, type RequiredLevel } from "@/server/access";
import { signalInbox } from "@/server/notifications";
import { pushNotifications } from "@/server/push";
import { workspacePeople } from "@/server/workspaces";

/**
 * Quizzes on pages: questions about a page that its readers answer, scored here (lib/quizzes.ts).
 * A page's Quiz block (lib/quiz-block.ts) holds only the quiz's id; the questions, right answers and
 * explanations live in the `quiz` table, and the right answers and explanations reach only people
 * who may edit the page (QUIZ_EDIT_LEVEL), and a reader once they passed or have no attempts left.
 * Access is always the quiz's own page's (`quiz.page_id`), never the page a block naming it is on.
 */

/** Who changes a quiz, sees everyone's results and asks people to take it: whoever may edit the page's body. */
export const QUIZ_EDIT_LEVEL: RequiredLevel = "content";

export type QuizErrorCode = "notFound" | "archived" | "empty" | "alreadyPassed" | "noAttemptsLeft" | "settings" | "people" | "due";

export class QuizError extends Error {
  constructor(
    readonly code: QuizErrorCode,
    readonly detail?: QuizSettingsError,
  ) {
    super(code);
    this.name = "QuizError";
  }
}

const isId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,64}$/.test(value);

type QuizRow = typeof quiz.$inferSelect;

/** The quiz and its page, once the user has `needed` access to that page; AccessError otherwise, whether or not it exists. */
async function quizWithAccess(userId: string, quizId: string, needed: RequiredLevel) {
  if (!isId(quizId)) throw new AccessError();
  const [row] = await db.select().from(quiz).where(eq(quiz.id, quizId));
  if (!row) throw new AccessError();
  const found = await requirePageAccess(userId, row.pageId, needed);
  return { quiz: row, page: found };
}

/** A new quiz on the page, empty, for a Quiz block just added there. */
export async function createQuiz(userId: string, pageId: string): Promise<string> {
  if (!isId(pageId)) throw new AccessError();
  const found = await requirePageAccess(userId, pageId, QUIZ_EDIT_LEVEL);
  if (found.archivedAt) throw new QuizError("archived");
  const [created] = await db
    .insert(quiz)
    .values({ workspaceId: found.workspaceId, pageId, questions: [], passMark: DEFAULT_PASS_MARK, createdBy: userId })
    .returning({ id: quiz.id });
  return created.id;
}

/** The reader's own attempts at a quiz, as the block shows them. */
export type QuizMine = {
  attempts: number;
  /** Attempts left, or null for any number. */
  left: number | null;
  best: number | null;
  passed: boolean;
  /** When they first passed. */
  passedAt: string | null;
  /** The latest attempt: its score, whether it passed, the questions answered right and what was picked. */
  last: { score: number; passed: boolean; right: string[]; answers: QuizAnswers; at: string } | null;
  /** Asked to take it: by when, if a day was given. */
  assigned: { due: string | null } | null;
};

/**
 * A quiz as `userId` may see it. `questions` carry `correct` and `explanation` only for editors and
 * for a reader who is done with it (`revealed`). A quiz of another page (a block copied there)
 * says only that (`foreign`), with whether the user may copy it onto this page.
 */
export type QuizView =
  | {
      id: string;
      foreign: false;
      canEdit: boolean;
      passMark: number;
      maxAttempts: number | null;
      questions: QuizQuestionView[];
      revealed: boolean;
      mine: QuizMine;
    }
  | { id: string; foreign: true; canCopy: boolean; count: number };

/**
 * The quiz for the block on page `hostPageId`. Needs read access to the quiz's own page; editors of
 * it get the answers.
 */
export async function readQuiz(userId: string, quizId: string, hostPageId: string): Promise<QuizView> {
  const { quiz: row } = await quizWithAccess(userId, quizId, "view");
  const questions = storedQuestions(row.questions);
  if (row.pageId !== hostPageId) {
    const canCopy = isId(hostPageId) && (await canEdit(userId, row.pageId)) && (await canEdit(userId, hostPageId));
    return { id: row.id, foreign: true, canCopy, count: questions.length };
  }
  return quizView(userId, row);
}

async function canEdit(userId: string, pageId: string) {
  const { page: found, level } = await resolvePageAccess(userId, pageId);
  return Boolean(found) && hasLevel(level, QUIZ_EDIT_LEVEL);
}

async function quizView(userId: string, row: QuizRow): Promise<QuizView> {
  const questions = storedQuestions(row.questions);
  const [editor, mine] = await Promise.all([canEdit(userId, row.pageId), mineOf(userId, row)]);
  const revealed = quizDone(mine.passed, mine.attempts, row.maxAttempts);
  return {
    id: row.id,
    foreign: false,
    canEdit: editor,
    passMark: row.passMark,
    maxAttempts: row.maxAttempts,
    // The answers only for editors and for someone done with it.
    questions: editor || revealed ? questions : withoutAnswers(questions),
    revealed: !editor && revealed,
    mine,
  };
}

async function mineOf(userId: string, row: QuizRow): Promise<QuizMine> {
  const [attempts, [assignment]] = await Promise.all([
    db
      .select()
      .from(quizAttempt)
      .where(and(eq(quizAttempt.quizId, row.id), eq(quizAttempt.userId, userId)))
      .orderBy(asc(quizAttempt.submittedAt)),
    db
      .select({ due: quizAssignment.dueDate })
      .from(quizAssignment)
      .where(and(eq(quizAssignment.quizId, row.id), eq(quizAssignment.userId, userId))),
  ]);
  const last = attempts.at(-1);
  const firstPass = attempts.find((a) => a.passed);
  return {
    attempts: attempts.length,
    left: attemptsLeft(attempts.length, row.maxAttempts),
    best: attempts.length ? Math.max(...attempts.map((a) => a.score)) : null,
    passed: Boolean(firstPass),
    passedAt: firstPass ? firstPass.submittedAt.toISOString() : null,
    last: last ? { score: last.score, passed: last.passed, right: last.right, answers: last.answers, at: last.submittedAt.toISOString() } : null,
    assigned: assignment ? { due: assignment.due } : null,
  };
}

/** Saves an editor's questions, pass mark and attempts (checked by lib/quizzes.ts checkQuiz). Earlier attempts keep their scores. */
export async function saveQuiz(userId: string, quizId: string, input: unknown): Promise<QuizView> {
  const { quiz: row, page: found } = await quizWithAccess(userId, quizId, QUIZ_EDIT_LEVEL);
  if (found.archivedAt) throw new QuizError("archived");
  const checked = checkQuiz(input);
  if (!checked.ok) throw new QuizError("settings", checked.error);
  const [saved] = await db
    .update(quiz)
    .set({ questions: checked.quiz.questions, passMark: checked.quiz.passMark, maxAttempts: checked.quiz.maxAttempts })
    .where(eq(quiz.id, row.id))
    .returning();
  return quizView(userId, saved);
}

/**
 * Scores the reader's answers and keeps the attempt. Refused once they passed or used every
 * attempt; the quiz row is locked meanwhile, so two quick submits can't both take the last attempt.
 * Returns the quiz as they may see it now: the answers come with it once they are done. Someone who
 * was asked to take it and is now done tells whoever asked (`quiz_finished`), once.
 */
export async function submitQuiz(userId: string, quizId: string, input: unknown): Promise<QuizView> {
  const { quiz: checkedRow, page: found } = await quizWithAccess(userId, quizId, "view");
  if (found.archivedAt) throw new QuizError("archived");
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(quiz).where(eq(quiz.id, checkedRow.id)).for("update");
    if (!row) throw new AccessError();
    const questions = storedQuestions(row.questions);
    if (!questions.length) throw new QuizError("empty");
    const earlier = await tx
      .select({ passed: quizAttempt.passed })
      .from(quizAttempt)
      .where(and(eq(quizAttempt.quizId, row.id), eq(quizAttempt.userId, userId)));
    if (earlier.some((a) => a.passed)) throw new QuizError("alreadyPassed");
    if (row.maxAttempts !== null && earlier.length >= row.maxAttempts) throw new QuizError("noAttemptsLeft");
    const answers = cleanAnswers(questions, input);
    const { right, score } = scoreAnswers(questions, answers);
    const passed = passes(score, row.passMark);
    await tx.insert(quizAttempt).values({ quizId: row.id, userId, answers, right, score, passed });
    const done = quizDone(passed, earlier.length + 1, row.maxAttempts);
    const [finished] = done
      ? await tx
          .update(quizAssignment)
          .set({ finishedAt: new Date() })
          .where(and(eq(quizAssignment.quizId, row.id), eq(quizAssignment.userId, userId), isNull(quizAssignment.finishedAt)))
          .returning({ assignedBy: quizAssignment.assignedBy })
      : [];
    return { row, score, passed, finished };
  });
  const { row, score, passed, finished } = outcome;
  if (finished?.assignedBy && finished.assignedBy !== userId) {
    await notify([finished.assignedBy], { workspaceId: row.workspaceId, pageId: row.pageId, kind: "quiz_finished", actorId: userId, message: quizNoticeMessage({ score, passed }) });
  }
  return quizView(userId, row);
}

async function notify(
  userIds: string[],
  values: { workspaceId: string; pageId: string; kind: "quiz_assigned" | "quiz_finished"; actorId: string; date?: string | null; message?: string },
) {
  if (!userIds.length) return;
  try {
    const inserted = await db
      .insert(notification)
      .values(userIds.map((id) => ({ userId: id, ...values, date: values.date ?? null, message: values.message ?? null })))
      .returning({ id: notification.id });
    signalInbox(values.workspaceId);
    pushNotifications(inserted.map((n) => n.id));
  } catch (error) {
    console.error("could not record quiz notifications", error);
  }
}

/** A person's standing on a quiz, as its editors see it. */
export type QuizResult = {
  userId: string;
  name: string;
  image: string | null;
  attempts: number;
  best: number | null;
  passed: boolean;
  passedAt: string | null;
  lastAt: string | null;
  assigned: boolean;
  due: string | null;
};

/** Everyone who took the quiz or was asked to, for its editors: best score, attempts, passed, asked and by when. */
export async function quizResults(userId: string, quizId: string): Promise<QuizResult[]> {
  const { quiz: row } = await quizWithAccess(userId, quizId, QUIZ_EDIT_LEVEL);
  const [attempts, assignments] = await Promise.all([
    db
      .select({
        userId: quizAttempt.userId,
        attempts: sql<number>`count(*)::int`,
        best: sql<number>`max(${quizAttempt.score})::int`,
        passed: sql<boolean>`bool_or(${quizAttempt.passed})`,
        passedAt: sql<string | null>`min(${quizAttempt.submittedAt}) filter (where ${quizAttempt.passed})`,
        lastAt: sql<string>`max(${quizAttempt.submittedAt})`,
      })
      .from(quizAttempt)
      .where(eq(quizAttempt.quizId, row.id))
      .groupBy(quizAttempt.userId),
    db.select({ userId: quizAssignment.userId, due: quizAssignment.dueDate }).from(quizAssignment).where(eq(quizAssignment.quizId, row.id)),
  ]);
  const ids = [...new Set([...attempts.map((a) => a.userId), ...assignments.map((a) => a.userId)])];
  if (!ids.length) return [];
  const people = await db.select({ id: user.id, name: user.name, image: user.image }).from(user).where(inArray(user.id, ids));
  const byId = new Map(people.map((p) => [p.id, p]));
  const attemptOf = new Map(attempts.map((a) => [a.userId, a]));
  const assignmentOf = new Map(assignments.map((a) => [a.userId, a]));
  const iso = (value: string | Date | null) => (value === null ? null : new Date(value).toISOString());
  return ids
    .map((id): QuizResult => {
      const a = attemptOf.get(id);
      const asked = assignmentOf.get(id);
      return {
        userId: id,
        name: byId.get(id)?.name ?? "",
        image: byId.get(id)?.image ?? null,
        attempts: a?.attempts ?? 0,
        best: a ? a.best : null,
        passed: Boolean(a?.passed),
        passedAt: a ? iso(a.passedAt) : null,
        lastAt: a ? iso(a.lastAt) : null,
        assigned: Boolean(asked),
        due: asked?.due ?? null,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** Someone a quiz's editor may ask to take it. */
export type QuizPerson = { id: string; name: string; email: string; image: string | null };

/**
 * Whom `userId` may ask to take the quiz: the people of the workspace who can open its page (a
 * guest, who doesn't see the workspace's people, only themselves).
 */
export async function quizPeople(userId: string, quizId: string): Promise<QuizPerson[]> {
  const { quiz: row } = await quizWithAccess(userId, quizId, QUIZ_EDIT_LEVEL);
  return peopleWhoCanOpen(userId, row);
}

async function peopleWhoCanOpen(userId: string, row: QuizRow): Promise<QuizPerson[]> {
  const membership = await getMembership(userId, row.workspaceId);
  const everyone = await workspacePeople(row.workspaceId);
  const candidates = membership && membership.role !== "guest" ? everyone : everyone.filter((p) => p.id === userId);
  if (!candidates.length) return [];
  const open = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.id, candidates.map((p) => p.id)), sql`page_access_level(${user.id}, ${row.pageId}) > 0`));
  const opens = new Set(open.map((o) => o.id));
  return candidates.filter((p) => opens.has(p.id)).map((p) => ({ id: p.id, name: p.name, email: p.email, image: p.image }));
}

/**
 * Asks people to take the quiz, by `due` (YYYY-MM-DD) or whenever. Only people who can open its
 * page; those newly asked hear of it in their inbox (`quiz_assigned`), those asked again get the
 * new day. Returns how many were newly asked.
 */
export async function assignQuiz(userId: string, quizId: string, userIds: string[], due: string | null): Promise<{ added: number }> {
  const { quiz: row, page: found } = await quizWithAccess(userId, quizId, QUIZ_EDIT_LEVEL);
  if (found.archivedAt) throw new QuizError("archived");
  const wanted = [...new Set(userIds)].slice(0, MAX_ASSIGN);
  if (!wanted.length) throw new QuizError("people");
  const allowed = new Set((await peopleWhoCanOpen(userId, row)).map((p) => p.id));
  if (wanted.some((id) => !allowed.has(id))) throw new QuizError("people");
  const rows = await db
    .insert(quizAssignment)
    .values(wanted.map((id) => ({ quizId: row.id, userId: id, assignedBy: userId, dueDate: due })))
    .onConflictDoUpdate({ target: [quizAssignment.quizId, quizAssignment.userId], set: { dueDate: due, assignedBy: userId } })
    .returning({ userId: quizAssignment.userId, inserted: sql<boolean>`(xmax = 0)` });
  const added = rows.filter((r) => r.inserted).map((r) => r.userId);
  await notify(
    added.filter((id) => id !== userId),
    { workspaceId: row.workspaceId, pageId: row.pageId, kind: "quiz_assigned", actorId: userId, date: due },
  );
  return { added: added.length };
}

/** No longer asks someone to take the quiz; their unread notice of it goes too. Their attempts stay. */
export async function unassignQuiz(userId: string, quizId: string, personId: string): Promise<void> {
  const { quiz: row } = await quizWithAccess(userId, quizId, QUIZ_EDIT_LEVEL);
  if (!isId(personId)) return;
  const removed = await db
    .delete(quizAssignment)
    .where(and(eq(quizAssignment.quizId, row.id), eq(quizAssignment.userId, personId)))
    .returning({ userId: quizAssignment.userId });
  if (!removed.length) return;
  await db
    .delete(notification)
    .where(and(eq(notification.userId, personId), eq(notification.kind, "quiz_assigned"), eq(notification.pageId, row.pageId), isNull(notification.readAt)));
  signalInbox(row.workspaceId);
}

/**
 * A copy of a quiz of another page on page `pageId`, for a Quiz block copied there: the same
 * questions, no attempts or people asked. Needs edit access to both pages (the copy reads the
 * answers). Returns the copy's id, which the block then names.
 */
export async function copyQuizToPage(userId: string, quizId: string, pageId: string): Promise<string> {
  const { quiz: row } = await quizWithAccess(userId, quizId, QUIZ_EDIT_LEVEL);
  if (!isId(pageId)) throw new AccessError();
  const target = await requirePageAccess(userId, pageId, QUIZ_EDIT_LEVEL);
  if (target.archivedAt) throw new QuizError("archived");
  const [created] = await db
    .insert(quiz)
    .values({ workspaceId: target.workspaceId, pageId, questions: storedQuestions(row.questions), passMark: row.passMark, maxAttempts: row.maxAttempts, createdBy: userId })
    .returning({ id: quiz.id });
  return created.id;
}

/** How many questions each of the page's quizzes has, for exports ("Quiz (5 questions)"). Only quizzes of that page. */
export async function quizQuestionCounts(pageId: string, quizIds: string[]): Promise<Map<string, number>> {
  const ids = quizIds.filter(isId);
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: quiz.id, count: sql<number>`jsonb_array_length(${quiz.questions})::int` })
    .from(quiz)
    .where(and(eq(quiz.pageId, pageId), inArray(quiz.id, ids)));
  return new Map(rows.map((r) => [r.id, r.count]));
}

// ---------------------------------------------------------------------------------------------
// Copies of pages

/** The quiz ids the Quiz blocks of a page's document name. */
export function quizIdsIn(doc: Y.Doc): string[] {
  const out = new Set<string>();
  walkQuizzes(doc, (element) => {
    const id = String(element.getAttribute("quizId") ?? "");
    if (id) out.add(id);
  });
  return [...out];
}

function walkQuizzes(doc: Y.Doc, visit: (element: Y.XmlElement) => void) {
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === QUIZ_BLOCK) visit(child);
      walk(child);
    }
  };
  walk(doc.getXmlFragment(COLLAB_FRAGMENT));
}

/** Points the Quiz blocks of a document at other quizzes (`map`: old id → new id). Returns how many changed. */
export function remapQuizzes(doc: Y.Doc, map: ReadonlyMap<string, string>): number {
  let changed = 0;
  doc.transact(() =>
    walkQuizzes(doc, (element) => {
      const next = map.get(String(element.getAttribute("quizId") ?? ""));
      if (next) {
        element.setAttribute("quizId", next);
        changed++;
      }
    }),
  );
  return changed;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Copied pages get quizzes of their own (server/duplicate.ts copyPageTree): each quiz of a source
 * page that its copy's body shows is copied with the same questions, without attempts or people
 * asked, and the copy's blocks name the copy. Blocks naming a quiz of another page are left as
 * they are (they show only that it belongs elsewhere).
 */
export async function copyQuizzesForCopies(tx: Tx, plan: DuplicatePlan, userId: string) {
  const copies = plan.pages.filter((p) => p.kind === "page");
  if (!copies.length) return;
  const sourceOf = new Map(copies.map((p) => [p.id, p.sourceId]));
  const bodies = await tx
    .select({ id: page.id, ydoc: page.ydoc, markdown: page.contentMarkdown })
    .from(page)
    .where(and(inArray(page.id, [...sourceOf.keys()]), like(page.contentMarkdown, "%<!-- leafdesk:quiz %")));
  for (const body of bodies) {
    if (!body.ydoc?.byteLength) continue;
    const sourceId = sourceOf.get(body.id);
    if (!sourceId) continue;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, body.ydoc);
      const named = quizIdsIn(doc);
      if (!named.length) continue;
      const sources = await tx.select().from(quiz).where(and(inArray(quiz.id, named), eq(quiz.pageId, sourceId)));
      if (!sources.length) continue;
      const map = new Map(sources.map((s) => [s.id, crypto.randomUUID()]));
      await tx.insert(quiz).values(
        sources.map((s) => ({
          id: map.get(s.id)!,
          workspaceId: s.workspaceId,
          pageId: body.id,
          questions: storedQuestions(s.questions),
          passMark: s.passMark,
          maxAttempts: s.maxAttempts,
          createdBy: userId,
        })),
      );
      if (!remapQuizzes(doc, map)) continue;
      const markdown = mapQuizLines(body.markdown, (id) => quizLine(map.get(id) ?? id));
      await tx.update(page).set({ ydoc: Y.encodeStateAsUpdate(doc), contentMarkdown: markdown }).where(eq(page.id, body.id));
    } finally {
      doc.destroy();
    }
  }
}

/** The page's quizzes, newest first (for scripts and checks). */
export async function pageQuizzes(pageId: string) {
  return db.select().from(quiz).where(eq(quiz.pageId, pageId)).orderBy(desc(quiz.createdAt));
}

