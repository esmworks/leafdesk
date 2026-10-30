import { and, eq, inArray, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { mailbox, sequenceEnrollment } from "@/db/schema";
import { isOutOfOffice, OPEN_ENROLLMENT, OUT_OF_OFFICE_DAYS, parseReturnDate, type AutoReplySignals } from "@/lib/sequences";
import { dayNumber, zonedInstant } from "@/lib/time-zone";
import { endEnrollments } from "./manage";

/**
 * Mail that came in on a row (row-mail/store.ts) and the row's follow-ups: it reached the row
 * through its thread or the row's address (row-mail/match.ts), so it is the contact's. An answer
 * sent after the enrollment began stops it; an out-of-office reply pauses it until the day the
 * reply says they are back (OUT_OF_OFFICE_DAYS when it says none), in the sender's time zone. Other
 * machine-written mail (bounces, newsletters) leaves it be.
 */

/**
 * Enrollments an out-of-office reply pauses: going, or paused by an earlier one (which it
 * extends). One paused because its email didn't pass the check stays so: its sender has to look
 * at it anyway.
 */
const pausable = () =>
  or(eq(sequenceEnrollment.status, "active"), and(eq(sequenceEnrollment.status, "paused"), eq(sequenceEnrollment.reason, "outOfOffice")));

export async function noticeIncoming(
  rowId: string,
  mail: { subject: string; text: string; sentAt: Date; automated: boolean; autoReply?: Omit<AutoReplySignals, "subject"> },
) {
  try {
    const open = and(eq(sequenceEnrollment.rowId, rowId), inArray(sequenceEnrollment.status, [...OPEN_ENROLLMENT]), lte(sequenceEnrollment.startedAt, mail.sentAt));
    if (isOutOfOffice({ ...mail.autoReply, subject: mail.subject })) {
      const going = await db
        .select({ id: sequenceEnrollment.id, timeZone: mailbox.timeZone })
        .from(sequenceEnrollment)
        .leftJoin(mailbox, and(eq(mailbox.workspaceId, sequenceEnrollment.workspaceId), eq(mailbox.userId, sequenceEnrollment.senderId), eq(mailbox.isDefault, true)))
        .where(and(open, pausable()));
      for (const e of going) {
        const timeZone = e.timeZone ?? "UTC";
        const back = parseReturnDate(mail.text, new Date(), timeZone);
        const until = back ? new Date(zonedInstant(dayNumber(back), 0, timeZone)) : new Date(Date.now() + OUT_OF_OFFICE_DAYS * 86_400_000);
        await db
          .update(sequenceEnrollment)
          .set({ status: "paused", reason: "outOfOffice", pausedUntil: until, problems: null, claimedUntil: null })
          .where(and(eq(sequenceEnrollment.id, e.id), pausable()));
      }
      return;
    }
    if (mail.automated) return;
    await endEnrollments(open, "replied", null);
  } catch (error) {
    console.error("[sequences] could not look at mail that came in on a row", error);
  }
}
