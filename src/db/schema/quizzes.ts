import { boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { QuizAnswers, QuizQuestion } from "../../lib/quizzes";
import { page, workspace } from "./app";
import { user } from "./auth";

/**
 * A quiz on a page (server/quizzes.ts): the page's Quiz block holds only its id, so the right
 * answers and explanations never reach the page's document, its published HTML or its exports.
 * Deleting the page for good deletes its quizzes, their attempts and assignments.
 */
export const quiz = pgTable(
  "quiz",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The page whose block shows it; a block on another page that names it shows only that. */
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** Up to MAX_QUESTIONS (lib/quizzes.ts checkQuiz). */
    questions: jsonb("questions").$type<QuizQuestion[]>().notNull().default([]),
    /** Percent of the questions answered right that passes. */
    passMark: integer("pass_mark").notNull().default(80),
    /** Attempts each person has; null for any number. */
    maxAttempts: integer("max_attempts"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("quiz_page_idx").on(t.pageId)],
);

/**
 * One person's attempt at a quiz, as scored when it was sent: `right` holds the ids of the
 * questions answered right, so it reads the same after the questions change.
 */
export const quizAttempt = pgTable(
  "quiz_attempt",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    quizId: text("quiz_id")
      .notNull()
      .references(() => quiz.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    answers: jsonb("answers").$type<QuizAnswers>().notNull(),
    right: jsonb("right").$type<string[]>().notNull().default([]),
    /** Percent, 0 to 100. */
    score: integer("score").notNull(),
    passed: boolean("passed").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quiz_attempt_quiz_user_idx").on(t.quizId, t.userId, t.submittedAt)],
);

/**
 * Someone asked to take a quiz, by whom and by when. `finishedAt` is set once they passed or ran
 * out of attempts, when whoever asked hears of it (inbox kind `quiz_finished`), once.
 */
export const quizAssignment = pgTable(
  "quiz_assignment",
  {
    quizId: text("quiz_id")
      .notNull()
      .references(() => quiz.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    assignedBy: text("assigned_by").references(() => user.id, { onDelete: "set null" }),
    /** The day it is due (YYYY-MM-DD), or null. */
    dueDate: date("due_date", { mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.quizId, t.userId] }), index("quiz_assignment_user_idx").on(t.userId)],
);
