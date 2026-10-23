/**
 * The `meeting_note` rows the Meetings page lists: one per meeting block of a page body (lib/meetings),
 * written from the body on every save (collab/service.ts persistPage), so they follow edits, copies,
 * restores and deletes of the block. The block stays the source of truth; the rows only list it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { meetingNote } from "@/db/schema";
import { meetingBlocksIn, meetingProps, parseAttendees, parseTakeaways } from "@/lib/meetings";

type Row = typeof meetingNote.$inferInsert;

const when = (iso: string) => {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time) : null;
};

/** A meeting block's row, as the Meetings page lists it. */
export function meetingRow(pageId: string, raw: Record<string, unknown> | undefined): Row {
  const props = meetingProps(raw);
  return {
    pageId,
    meetingId: props.meetingId,
    title: props.title.trim().slice(0, 200),
    scheduledAt: when(props.scheduledAt),
    startedAt: when(props.startedAt),
    endedAt: when(props.endedAt),
    seconds: Math.round(props.seconds),
    attendees: parseAttendees(props.attendees),
    status: props.status,
    preview: (parseTakeaways(props.summary)[0]?.text ?? "").slice(0, 300),
  };
}

const same = (a: Row, b: Row) =>
  a.title === b.title &&
  (a.scheduledAt?.getTime() ?? null) === (b.scheduledAt?.getTime() ?? null) &&
  (a.startedAt?.getTime() ?? null) === (b.startedAt?.getTime() ?? null) &&
  (a.endedAt?.getTime() ?? null) === (b.endedAt?.getTime() ?? null) &&
  a.seconds === b.seconds &&
  JSON.stringify(a.attendees) === JSON.stringify(b.attendees) &&
  a.status === b.status &&
  a.preview === b.preview;

/** Brings the page's rows in line with its body's meeting blocks. Never throws: a save goes on. */
export async function syncMeetingNotes(pageId: string, blocks: unknown[]) {
  try {
    const wanted = new Map<string, Row>();
    for (const block of meetingBlocksIn(blocks as { type: string; props?: Record<string, unknown> }[])) {
      const row = meetingRow(pageId, block.props);
      // A block copied within the page keeps its id: the first one counts.
      if (row.meetingId && !wanted.has(row.meetingId)) wanted.set(row.meetingId, row);
    }
    const existing = await db.select().from(meetingNote).where(eq(meetingNote.pageId, pageId));
    if (!existing.length && !wanted.size) return;
    const gone = existing.filter((r) => !wanted.has(r.meetingId)).map((r) => r.meetingId);
    if (gone.length) await db.delete(meetingNote).where(and(eq(meetingNote.pageId, pageId), inArray(meetingNote.meetingId, gone)));
    const had = new Map(existing.map((r) => [r.meetingId, r]));
    for (const row of wanted.values()) {
      const before = had.get(row.meetingId);
      if (before && same(before, row)) continue;
      const { pageId: _page, meetingId: _meeting, ...values } = row;
      await db
        .insert(meetingNote)
        .values(row)
        .onConflictDoUpdate({ target: [meetingNote.pageId, meetingNote.meetingId], set: values });
    }
  } catch (error) {
    console.error(`could not update the meetings of page ${pageId}`, error);
  }
}
