/** How long ago a conversation was last written in, by the reader's calendar days. */
export type Recency = "today" | "yesterday" | "week" | "month" | "older";

/**
 * Splits items (newest first, as the chat's list comes) into runs by how recent they are: today,
 * yesterday, the 7 days before, the 30 days before, then older. Empty runs are left out; the order
 * within a run is kept.
 */
export function byRecency<T extends { updatedAt: string }>(items: T[], now: Date = new Date()): { recency: Recency; items: T[] }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const daysAgo = (date: string) => {
    const at = new Date(date);
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
    // Rounded: a day across a daylight saving change is an hour longer or shorter.
    return Math.round((today - day) / 86_400_000);
  };
  const groups: { recency: Recency; items: T[] }[] = [];
  for (const item of items) {
    const days = daysAgo(item.updatedAt);
    const recency: Recency = days <= 0 ? "today" : days === 1 ? "yesterday" : days <= 7 ? "week" : days <= 30 ? "month" : "older";
    const last = groups[groups.length - 1];
    if (last?.recency === recency) last.items.push(item);
    else groups.push({ recency, items: [item] });
  }
  return groups;
}
