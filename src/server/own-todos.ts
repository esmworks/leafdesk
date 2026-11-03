/**
 * A to-do the person writes in the sidebar's tasks tab: added at the end of their daily note for
 * `today`, mentioning them so My tasks lists it (lib/page-tasks.ts). A date its text names
 * ("call the supplier friday") comes out of the text as a date mention (lib/quick-add.ts).
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { user } from "@/db/schema";
import { MENTION } from "@/lib/mentions";
import { TODO_BLOCK } from "@/lib/page-tasks";
import { parseQuickAdd } from "@/lib/quick-add";
import { getCollab } from "@/server/collab/bridge";
import { getOrCreateDailyNote } from "@/server/journal";

/** The longest to-do written there. */
export const MAX_OWN_TODO = 500;

export class OwnTodoError extends Error {
  constructor(readonly code: "empty" | "tooLong") {
    super(code);
  }
}

/** `locale`: the person's, for the date words and a daily note made now (its title). */
export async function addOwnTodo(userId: string, workspaceId: string, text: string, today: string, { locale = "en" }: { locale?: string } = {}) {
  const written = text.trim();
  if (!written) throw new OwnTodoError("empty");
  if (written.length > MAX_OWN_TODO) throw new OwnTodoError("tooLong");
  const parsed = parseQuickAdd(written, { locale, today });
  // A text that is only a date ("tomorrow") stays as written.
  const title = parsed.title.trim() || written;
  const date = parsed.title.trim() ? parsed.date : null;

  const actor = { userId };
  const { pageId } = await getOrCreateDailyNote(actor, workspaceId, today, { locale });
  const [me] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const block = {
    type: TODO_BLOCK,
    props: { checked: false },
    content: [
      { type: MENTION, props: { kind: "user", id: randomUUID(), userId, name: me?.name ?? "" } },
      { type: "text", text: ` ${title}`, styles: {} },
      ...(date ? [{ type: "text", text: " ", styles: {} }, { type: MENTION, props: { kind: "date", id: randomUUID(), date } }] : []),
    ],
  };
  await getCollab().appendBlocks(pageId, [block], actor);
  return { pageId, date };
}
