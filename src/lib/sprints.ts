import type { PropertyOptions, SprintConfig, SprintState } from "@/db/schema/app";
import { dateDays, type DaySpan } from "./date-value";
import { dayNumber, dayString } from "./time-zone";

/**
 * Sprints: tasks planned in sprints kept in a database of their own. A relation of the task
 * database with the sprints database whose role is "sprint" (see RelationConfig) holds each task's
 * sprint; its `sprints` config names the sprints database's dates and state properties. One
 * sprint is current, one next, later ones future and past ones completed. Completing the current
 * sprint makes the next one current, plans a new next one and carries the tasks left unfinished
 * over to the new current sprint.
 *
 * Rows can reach the sprints database by paths that don't keep that order (people editing states,
 * imports), so everything here reads it defensively: of several current sprints the earliest is
 * the one completed, and a sprint without dates is followed by one starting today.
 */

export const SPRINT_STATES = ["current", "next", "future", "completed"] as const satisfies readonly SprintState[];
export const MIN_SPRINT_WEEKS = 1;
export const MAX_SPRINT_WEEKS = 4;

type Prop = { id: string; databaseId: string; type: string; options: PropertyOptions };

/** Whether `weeks` is a sprint length the app offers. */
export function isSprintWeeks(weeks: unknown): weeks is number {
  return typeof weeks === "number" && Number.isInteger(weeks) && weeks >= MIN_SPRINT_WEEKS && weeks <= MAX_SPRINT_WEEKS;
}

/** The task database's property holding each task's sprint while sprints are on, or null. */
export function sprintProperty<P extends Prop>(properties: P[]): P | null {
  return (
    properties.find(
      (p) =>
        p.type === "relation" &&
        p.options.relation?.role === "sprint" &&
        !!p.options.relation.sprints &&
        p.options.relation.databaseId !== p.databaseId,
    ) ?? null
  );
}

/**
 * Whether a database is the sprints database of another one: one of its relations is paired with
 * a sprint property, as the related databases' properties (`related`, keyed by relation id) show.
 */
export function holdsSprints(
  properties: { id: string; type: string; options: PropertyOptions }[],
  related: Record<string, { properties: { id: string; type: string; options: PropertyOptions }[] } | undefined>,
): boolean {
  return properties.some((p) => {
    const paired = p.type === "relation" ? p.options.relation?.pairedPropertyId : null;
    const other = paired ? related[p.id]?.properties.find((q) => q.id === paired) : undefined;
    return !!other && other.type === "relation" && other.options.relation?.role === "sprint" && !!other.options.relation.sprints;
  });
}

/** A sprint of `weeks` weeks starting on `start` (YYYY-MM-DD), as a date value ("start/end"). */
export function sprintDates(start: string, weeks: number): string {
  return `${start}/${dayString(dayNumber(start) + weeks * 7 - 1)}`;
}

/** The days of a sprint's dates, or null when it has none. Plain days don't depend on a zone. */
export function sprintDays(value: unknown): DaySpan | null {
  return dateDays(value, "UTC");
}

/**
 * The dates of the sprint after one covering `before`: from the day after it ends (from `today`
 * when it has no dates), `weeks` weeks long.
 */
export function sprintAfter(before: DaySpan | null, weeks: number, today: string): string {
  return sprintDates(before ? dayString(before.end + 1) : today, weeks);
}

const TITLE_NUMBER = /(\d+)(\D*)$/;

/** The number a sprint's title ends with ("Sprint 12" → 12), or null. */
export function sprintNumber(title: string): number | null {
  const match = TITLE_NUMBER.exec(title.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Titles for new sprints: the title of the highest-numbered sprint with its number swapped, so
 * sprints people renamed ("Iteration 7") go on in their words; `fallback` when none has a number.
 */
export function sprintTitles(titles: string[], fallback: (n: number) => string): (n: number) => string {
  const numbered = titles.map((t) => t.trim()).filter((t) => sprintNumber(t) !== null);
  const last = numbered.sort((a, b) => sprintNumber(b)! - sprintNumber(a)!)[0];
  return last ? (n) => last.replace(TITLE_NUMBER, (_, _n, rest: string) => `${n}${rest}`) : fallback;
}

export type SprintRow = { id: string; title: string; properties: Record<string, unknown>; position?: number };

/** Where a sprint stands, by its state option, or null for a sprint without one. */
export function sprintStateOf(row: SprintRow, config: SprintConfig): SprintState | null {
  const value = row.properties[config.statePropertyId];
  return SPRINT_STATES.find((state) => config.states[state] === value) ?? null;
}

/** Sprints in order: by their first day (those without dates last), then their place in the database. */
export function sortSprints<T extends SprintRow>(rows: T[], config: SprintConfig): T[] {
  const start = (row: T) => sprintDays(row.properties[config.datesPropertyId])?.start ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => start(a) - start(b) || (a.position ?? 0) - (b.position ?? 0));
}

/** A sprint to add: its title and dates; `id` is chosen beforehand, so tasks can link to it. */
export type NewSprint = { id: string; title: string; dates: string };

/**
 * What completing the current sprint does to the sprints: which one is completed, which becomes
 * current (the next one, else the first future one, else a new one right after the completed one)
 * and which is next after that (another next one, else the first future one, else a new one right
 * after the new current one). New sprints are numbered on from the highest number the sprints'
 * titles end with.
 */
export type SprintCompletion<T extends SprintRow = SprintRow> = {
  completed: T;
  current: { row: T } | { create: NewSprint };
  next: { row: T } | { create: NewSprint };
};

/** Plans completing the current sprint (see SprintCompletion); null when no sprint is current. */
export function planSprintCompletion<T extends SprintRow>(
  sprints: T[],
  config: SprintConfig,
  {
    today,
    newId,
    title,
  }: {
    /** YYYY-MM-DD: where a new sprint starts when the one before it has no dates. */
    today: string;
    newId: () => string;
    /** The title of the sprint numbered `n` when no sprint's title has a number (see sprintTitles). */
    title: (n: number) => string;
  },
): SprintCompletion<T> | null {
  const ordered = sortSprints(sprints, config);
  const of = (state: SprintState) => ordered.filter((row) => sprintStateOf(row, config) === state);
  const completed = of("current")[0];
  if (!completed) return null;
  let number = Math.max(0, ...sprints.map((row) => sprintNumber(row.title) ?? 0));
  const titleOf = sprintTitles(sprints.map((row) => row.title), title);
  const create = (after: DaySpan | null): NewSprint => ({ id: newId(), title: titleOf(++number), dates: sprintAfter(after, config.weeks, today) });
  const daysOf = (row: T) => sprintDays(row.properties[config.datesPropertyId]);

  const waiting = [...of("next"), ...of("future")];
  const promoted = waiting.shift();
  const current: SprintCompletion<T>["current"] = promoted ? { row: promoted } : { create: create(daysOf(completed)) };
  const following = waiting.shift();
  const currentDays = "row" in current ? daysOf(current.row) : sprintDays(current.create.dates);
  const next: SprintCompletion<T>["next"] = following ? { row: following } : { create: create(currentDays) };
  return { completed, current, next };
}

export type SprintTask = { id: string; properties: Record<string, unknown> };

/**
 * The tasks of the completed sprint that move to the new current one: those not done (`isDone`:
 * their status is in its "done" group), each with its sprints as they become (the completed sprint
 * swapped for the new current one).
 */
export function tasksToMove<T extends SprintTask>(
  tasks: T[],
  sprintPropertyId: string,
  completedId: string,
  currentId: string,
  isDone: (task: T) => boolean,
): { task: T; sprints: string[] }[] {
  return tasks.flatMap((task) => {
    const value = task.properties[sprintPropertyId];
    const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    if (!ids.includes(completedId) || isDone(task)) return [];
    return [{ task, sprints: [...new Set(ids.map((id) => (id === completedId ? currentId : id)))] }];
  });
}
