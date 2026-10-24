/**
 * Who a group mention on a page reaches (server/mentions syncMentions): each member of the group,
 * as if they were mentioned themselves. Pure, so it can be tested without a database.
 */

/**
 * The key a group mention's member is remembered by (`page_mention` holds one person per key): the
 * mention's key, then the person.
 */
export const groupMemberKey = (groupKey: string, userId: string) => `${groupKey}>${userId}`;

/**
 * The people group mentions reach, each as its own mention (groupMemberKey). A group mention already
 * notified about (any of its keys remembered) keeps the people it reached then: someone who joins
 * the group later isn't told about mentions made before. Groups of other workspaces reach nobody.
 */
export function groupMentionTargets(
  groups: { key: string; groupId: string }[],
  members: Map<string, string[]>,
  seenKeys: string[],
): { key: string; userId: string; group: true }[] {
  const out: { key: string; userId: string; group: true }[] = [];
  for (const g of groups) {
    const prefix = groupMemberKey(g.key, "");
    const seen = seenKeys.filter((k) => k.startsWith(prefix));
    const people = seen.length ? seen.map((k) => k.slice(prefix.length)) : (members.get(g.groupId) ?? []);
    for (const userId of new Set(people)) out.push({ key: groupMemberKey(g.key, userId), userId, group: true });
  }
  return out;
}
