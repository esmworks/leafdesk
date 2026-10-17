import { and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { page, user } from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import type { ActivityLookups, ActivityPerson } from "@/lib/row-activity";
import { pageVisibleTo } from "@/server/access";
import { agentMarks } from "@/server/agents/users";

/**
 * What the ids stored values hold read as for `viewerId` (lib/row-activity `resolveValue`): people
 * by name, linked rows by title when they can open them. For a row's activity and for the changes
 * the inbox shows of rows people follow.
 */
export async function loadLookups(viewerId: string, userIds: string[], pageIds: string[]): Promise<ActivityLookups> {
  const people = [...new Set(userIds)];
  const pages = [...new Set(pageIds)];
  const [users, marks, linked] = await Promise.all([
    people.length
      ? db.select({ id: user.id, name: user.name, image: user.image }).from(user).where(inArray(user.id, people))
      : Promise.resolve([]),
    agentMarks(people),
    // Linked rows the viewer can't open read as "no access", never by title.
    pages.length
      ? db
          .select({ id: page.id, title: page.title, icon: page.icon })
          .from(page)
          .where(and(inArray(page.id, pages), pageVisibleTo(viewerId)))
      : Promise.resolve([]),
  ]);
  return {
    people: new Map(
      users.map((u) => {
        const mark = marks.get(u.id);
        const person: ActivityPerson = { id: u.id, name: u.name, image: avatarSrc(u.image) };
        return [u.id, mark ? { ...person, isAgent: true as const, agentIcon: mark.agentIcon } : person];
      }),
    ),
    pages: new Map(linked.map((p) => [p.id, { title: p.title, icon: p.icon }])),
  };
}
