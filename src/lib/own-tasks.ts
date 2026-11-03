/** The person's own task list (server/own-tasks.ts): what My tasks' New task row and the server share. */

/** The longest task title written there. */
export const MAX_OWN_TASK = 500;
/** People a task may be for besides the person adding it. */
export const MAX_TASK_HELPERS = 20;

/** The priorities, in the order of the list's priority options. */
export const TASK_PRIORITIES = ["high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const isTaskPriority = (value: unknown): value is TaskPriority => (TASK_PRIORITIES as readonly unknown[]).includes(value);
