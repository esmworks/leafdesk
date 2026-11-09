/**
 * Time a person plans for their own tasks on the Calendar (server/work-blocks.ts): how long a
 * block may be, the steps it snaps to, and the time planned for each task. Pure and client-safe.
 */

/** The shortest block, and the step its start and length snap to. */
export const WORK_BLOCK_STEP_MINUTES = 15;
export const WORK_BLOCK_MIN_MINUTES = 15;
/** The longest block: half a day. */
export const WORK_BLOCK_MAX_MINUTES = 12 * 60;
/** How long a block is that is made by dropping a task on the week. */
export const WORK_BLOCK_DEFAULT_MINUTES = 60;
/** How many blocks one task may have for one person. */
export const MAX_BLOCKS_PER_TASK = 100;
/** The lengths the Plan time dialog offers, in minutes. */
export const WORK_BLOCK_LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720];

/**
 * The task a block is for: a database row, or a to-do in a page. The same shape as the actions'
 * `AssignedItemRef`, so marking the task done goes through My tasks' own action.
 */
export type WorkTaskRef = { type: "row"; rowId: string } | { type: "pageTask"; pageId: string; blockId: string };

/** A task's key, as My tasks' items name it: a row's id, or `<pageId>:<blockId>` for a to-do. */
export const workTaskKey = (pageId: string, blockId: string | null) => (blockId ? `${pageId}:${blockId}` : pageId);

/** The ref of the task a block (its page and to-do block) is for. */
export const workTaskRef = (pageId: string, blockId: string | null): WorkTaskRef =>
  blockId ? { type: "pageTask", pageId, blockId } : { type: "row", rowId: pageId };

/** Why a block's times can't be: shorter than the least, longer than the most, or not times at all. */
export type WorkBlockLengthError = "tooShort" | "tooLong" | "invalid";

/** Whether a block from `start` to `end` (milliseconds) may be, or why not. */
export function workBlockLengthError(start: number, end: number): WorkBlockLengthError | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  const minutes = (end - start) / 60_000;
  if (minutes < WORK_BLOCK_MIN_MINUTES) return "tooShort";
  if (minutes > WORK_BLOCK_MAX_MINUTES) return "tooLong";
  return null;
}

/** `minutes` rounded to the nearest step. */
export const snapMinutes = (minutes: number, step = WORK_BLOCK_STEP_MINUTES) => Math.round(minutes / step) * step;

/**
 * The end (minutes past its day's midnight) a block starting at `startMinutes` gets when its
 * bottom edge is pulled to `endMinutes`: snapped, at least the shortest block, at most the longest
 * and never past the day's end (a block is pulled on one day's hours).
 */
export function resizedEnd(startMinutes: number, endMinutes: number, dayMinutes = 24 * 60): number {
  const snapped = snapMinutes(endMinutes);
  return Math.min(Math.max(snapped, startMinutes + WORK_BLOCK_MIN_MINUTES), startMinutes + WORK_BLOCK_MAX_MINUTES, dayMinutes);
}

/** The minutes planned for each task (by workTaskKey), all its blocks added up. */
export function plannedMinutes(blocks: { pageId: string; blockId: string | null; startsAt: Date; endsAt: Date }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const b of blocks) {
    const minutes = Math.max(0, Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000));
    const key = workTaskKey(b.pageId, b.blockId);
    totals.set(key, (totals.get(key) ?? 0) + minutes);
  }
  return totals;
}

/** Minutes as whole hours and the minutes left, for "2 h 30 min planned". */
export function hoursAndMinutes(total: number): { hours: number; minutes: number } {
  const whole = Math.max(0, Math.round(total));
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}

/** A task the To plan list offers (server/work-blocks.ts tasksToPlan). */
export type TaskToPlan = {
  /** workTaskKey of the task. */
  key: string;
  ref: WorkTaskRef;
  title: string;
  icon: string | null;
  /** Where it is: the database's or the page's title (null when the database is hidden from them). */
  detail: string | null;
  /** The first day of its date (YYYY-MM-DD), or null without one. */
  date: string | null;
  href: string;
  /** All the time planned for it so far. */
  plannedMinutes: number;
};

/** Tasks by due date (those without one last), then by title. */
export function sortTasksToPlan<T extends Pick<TaskToPlan, "date" | "title">>(tasks: T[], collator: Intl.Collator = new Intl.Collator()): T[] {
  return [...tasks].sort((a, b) => {
    if (a.date !== b.date) {
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date < b.date ? -1 : 1;
    }
    return collator.compare(a.title, b.title);
  });
}

/** Whether a task matches what is typed in the list's filter box: every word in its title or where it is. */
export function matchesTaskFilter(task: Pick<TaskToPlan, "title" | "detail">, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${task.title} ${task.detail ?? ""}`.toLocaleLowerCase();
  return words.every((w) => text.includes(w));
}
