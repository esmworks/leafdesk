/**
 * Tasks the Mail tab's AI finds in a thread (server/mail-client/ai.ts, kind `tasks`): what the
 * person is asked to do or promised, offered to them to tick and add as their to-dos
 * (server/mail-client/tasks.ts). Import-free: the thread's task list loads it, and the server
 * checks what comes back with it again.
 */

/** At most this many tasks are offered, and added at once. */
export const MAX_MAIL_TASKS = 10;
export const MAIL_TASK_TEXT_MAX = 300;

/** A task as offered: its text, and the day it is due (YYYY-MM-DD) when the mail gives one. */
export type MailTask = { text: string; date: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `value` when it is a real day written YYYY-MM-DD, else null. */
export function mailTaskDay(value: unknown): string | null {
  if (typeof value !== "string" || !DAY.test(value)) return null;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value ? value : null;
}

/** One task checked: trimmed to one line, its day kept only when it is a real one. */
export function cleanMailTask(value: unknown): MailTask | null {
  if (!value || typeof value !== "object") return null;
  const { text, date } = value as { text?: unknown; date?: unknown };
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, MAIL_TASK_TEXT_MAX).trim() : "";
  return line ? { text: line, date: mailTaskDay(date) } : null;
}

/**
 * The tasks of the model's answer, `{"tasks": [{"text": …, "date": …}]}` (code fences and words
 * around it allowed). An answer that isn't that reads as no tasks found: null.
 */
export function readMailTasks(answer: string): MailTask[] | null {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) return null;
  return list
    .map(cleanMailTask)
    .filter((task): task is MailTask => !!task)
    .slice(0, MAX_MAIL_TASKS);
}
