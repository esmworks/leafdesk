// The Meetings page's list (components/meetings/meetings-list.tsx, server/meetings.ts listMeetings).

import type { Attendee } from "./meetings";
import { searchFold } from "./search-fold";

/** A meeting as the Meetings page lists it. */
export type MeetingListItem = {
  pageId: string;
  meetingId: string;
  title: string;
  pageTitle: string;
  icon: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  seconds: number;
  attendees: Attendee[];
  status: string;
  /** The summary's first point, if it has one. */
  preview: string;
};

/** Whether a listed meeting matches what was typed: every word in its title, page, attendees or summary. */
export function matchesMeeting(item: MeetingListItem, query: string): boolean {
  const words = searchFold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [item.title, item.pageTitle, item.preview, ...item.attendees.map((a) => a.name)].map(searchFold);
  return words.every((word) => haystack.some((text) => text.includes(word)));
}

/** Upcoming: planned for later and not recorded yet. */
export const isUpcoming = (item: Pick<MeetingListItem, "scheduledAt" | "startedAt" | "status">, now = Date.now()) =>
  !item.startedAt && !item.status && item.scheduledAt !== null && Date.parse(item.scheduledAt) > now;
