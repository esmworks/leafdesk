/**
 * The person's own task list: a private database of theirs (table `task_list`), made with the
 * first task they add from My tasks, with a status, a date, a priority and the people the task is
 * for. They are always among those people; the others get edit access to that row (row access on
 * the people property), so the task shows in their My tasks too. A list in the trash no longer
 * counts: the next task makes a new one.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { page, taskList } from "@/db/schema";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { loadLocaleFile, withFallback } from "@/i18n/messages";
import templateTexts from "@/i18n/messages/en/templates.json";
import { isDay } from "@/lib/journal";
import { MAX_OWN_TASK, MAX_TASK_HELPERS, TASK_PRIORITIES, type TaskPriority } from "@/lib/own-tasks";
import { pageVisibleTo, requireMembership, requirePageAccess } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { createFromPlan } from "@/server/database-plan";
import { createRows, getProperties } from "@/server/databases";
import { archivePage, deletePagePermanently } from "@/server/pages";
import { setRowAccess } from "@/server/row-access";
import { workspacePeople } from "@/server/workspaces";

export class OwnTaskError extends Error {
  constructor(readonly code: "empty" | "tooLong" | "badDate" | "notMember") {
    super(code);
    this.name = "OwnTaskError";
  }
}

type TaskListTexts = typeof templateTexts.taskList;

async function taskListTexts(locale: string | undefined): Promise<TaskListTexts> {
  if (!isLocale(locale) || locale === DEFAULT_LOCALE) return templateTexts.taskList;
  const translated = (await loadLocaleFile(locale, "templates")) as { taskList?: unknown } | undefined;
  return withFallback(templateTexts.taskList, translated?.taskList);
}

/** The person's task list when there is one in place: out of the trash, and theirs to add rows to. */
async function liveList(userId: string, pageId: string) {
  const [row] = await db
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.id, pageId), eq(page.kind, "database"), isNull(page.archivedAt), pageVisibleTo(userId)));
  if (!row) return false;
  return requirePageAccess(userId, pageId, "content").then(
    () => true,
    () => false,
  );
}

/** The id of the person's task list in the workspace, when there is one in place. */
export async function findTaskList(userId: string, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ pageId: taskList.pageId })
    .from(taskList)
    .where(and(eq(taskList.workspaceId, workspaceId), eq(taskList.userId, userId)));
  return row?.pageId && (await liveList(userId, row.pageId)) ? row.pageId : null;
}

/**
 * The person's task list, made (private, at the top level) when they have none in place. Guests
 * who may not add top-level pages can't have one (AccessError).
 */
async function ensureTaskList(actor: WriteActor, workspaceId: string, locale: string | undefined): Promise<string> {
  const { userId } = actor;
  await db.insert(taskList).values({ workspaceId, userId }).onConflictDoNothing();
  const [row] = await db
    .select({ pageId: taskList.pageId })
    .from(taskList)
    .where(and(eq(taskList.workspaceId, workspaceId), eq(taskList.userId, userId)));
  const current = row?.pageId ?? null;
  if (current && (await liveList(userId, current))) return current;

  const t = await taskListTexts(locale);
  const made = await createFromPlan(
    actor,
    workspaceId,
    {
      intro: null,
      databases: [
        {
          key: "tasks",
          title: t.title,
          icon: "icon:list-todo:blue",
          properties: [
            { name: t.status, type: "status" },
            { name: t.date, type: "date" },
            {
              name: t.priority,
              type: "select",
              options: [
                { name: t.high, color: "red" },
                { name: t.medium, color: "yellow" },
                { name: t.low, color: "blue" },
              ],
            },
            { name: t.people, type: "person" },
          ],
          views: [
            { name: "", type: "table", sorts: [{ property: t.date, direction: "asc" }] },
            { name: "", type: "board", group_by: t.status },
          ],
          rows: [],
        },
      ],
    },
    { teamspaceId: null },
  );
  const created = made.databases[0].id;
  const people = (await getProperties(created)).find((p) => p.type === "person");
  if (people) await setRowAccess(userId, created, { restricted: false, rules: [{ kind: "person", propertyId: people.id, level: "edit" }] });

  // Whoever replaced the old one first wins; a list made at the same moment goes away unseen.
  const [won] = await db
    .update(taskList)
    .set({ pageId: created })
    .where(
      and(
        eq(taskList.workspaceId, workspaceId),
        eq(taskList.userId, userId),
        current ? eq(taskList.pageId, current) : isNull(taskList.pageId),
      ),
    )
    .returning({ pageId: taskList.pageId });
  if (won) return created;
  await archivePage(userId, created)
    .then(() => deletePagePermanently(userId, created))
    .catch((error) => console.error("[own-tasks] couldn't remove a duplicate list", error));
  return ensureTaskList(actor, workspaceId, locale);
}

export type NewOwnTask = {
  title: string;
  /** YYYY-MM-DD, or null. */
  date: string | null;
  priority: TaskPriority | null;
  /** Others the task is for; the person adding it is always one. */
  people: string[];
};

/**
 * Adds a task to the person's list, making the list first when they have none. Its values go to
 * the list's first property of each kind, so a renamed or reordered property keeps working; the
 * priority is the select's option in TASK_PRIORITIES' place. `locale`: the person's, for a list
 * made now.
 */
export async function addOwnTask(userId: string, workspaceId: string, task: NewOwnTask, { locale }: { locale?: string } = {}) {
  const title = task.title.trim();
  if (!title) throw new OwnTaskError("empty");
  if (title.length > MAX_OWN_TASK) throw new OwnTaskError("tooLong");
  if (task.date !== null && !isDay(task.date)) throw new OwnTaskError("badDate");
  await requireMembership(userId, workspaceId);
  const others = [...new Set(task.people)].filter((id) => id !== userId).slice(0, MAX_TASK_HELPERS);
  if (others.length) {
    const members = new Set((await workspacePeople(workspaceId)).map((p) => p.id));
    if (others.some((id) => !members.has(id))) throw new OwnTaskError("notMember");
  }

  const databaseId = await ensureTaskList({ userId }, workspaceId, locale);
  const properties = await getProperties(databaseId);
  const first = (type: string) => properties.find((p) => p.type === type);
  const values: Record<string, unknown> = {};
  const status = first("status");
  const todo = status?.options.options?.find((o) => (o.group ?? "todo") === "todo");
  if (status && todo) values[status.id] = todo.id;
  const date = first("date");
  if (date && task.date) values[date.id] = task.date;
  const priority = first("select");
  const option = task.priority && priority?.options.options?.[TASK_PRIORITIES.indexOf(task.priority)];
  if (priority && option) values[priority.id] = option.id;
  const people = first("person");
  if (people) values[people.id] = [userId, ...others];

  const [row] = await createRows(userId, databaseId, [{ title, properties: values }]);
  return { rowId: row.id, databaseId };
}
