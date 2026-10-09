/**
 * When a snoozed notification comes back (see server/notifications snoozeNotification), in the
 * viewer's own time: in an hour, tomorrow at 9:00, or next Monday at 9:00. Pure; `now` is local.
 */

/** An agent's call waits only so long: snoozing it would let it run out unseen. Everything else can wait. */
export const UNSNOOZABLE_KINDS = ["agent_approval"] as const;
export const canSnooze = (kind: string) => !(UNSNOOZABLE_KINDS as readonly string[]).includes(kind);

export type SnoozeChoice = "hour" | "tomorrow" | "nextWeek";
export const SNOOZE_CHOICES: readonly SnoozeChoice[] = ["hour", "tomorrow", "nextWeek"];

export function snoozeUntil(choice: SnoozeChoice, now: Date): Date {
  if (choice === "hour") return new Date(now.getTime() + 3_600_000);
  // Monday is 1; from Monday itself, the next one is a week away.
  const days = choice === "tomorrow" ? 1 : (8 - now.getDay()) % 7 || 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9);
}
