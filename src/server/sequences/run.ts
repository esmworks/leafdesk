import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailSequence, mailbox, notification, page, pendingChange, rowEmail, sequenceEnrollment, sequenceSend, user } from "@/db/schema";
import { textOf } from "@/lib/automation-templates";
import { checkEmailDraft, type EmailDraftProblem } from "@/lib/email-draft-check";
import { replySubject } from "@/lib/mail";
import { nextSendSlot, renderTemplate, spreadMs, stepDue, type SequenceStep } from "@/lib/sequences";
import { localDay, zonedInstant } from "@/lib/time-zone";
import { AccessError } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getRow } from "@/server/databases";
import { displayProperties, type PropertyDef } from "@/server/mcp/query";
import { signalInbox } from "@/server/notifications";
import { proposeChange } from "@/server/pending-changes";
import { pushNotifications } from "@/server/push";
import { rowMailAccess } from "@/server/row-mail/access";
import { queueRowEmail, sendSoon } from "@/server/row-mail/send";
import { RowMailError } from "@/server/row-mail/settings";
import { startSweep } from "@/server/sweep";
import { workspaceSettings } from "@/server/workspaces";
import { endEnrollments, rowAddresses } from "./manage";

/**
 * The job that sends follow-ups (lib/sequences.ts), every 30 seconds in the app server. Each round:
 * enrollments whose row went to the trash or whose sender's mailbox is gone stop; drafts their
 * senders answered under For review move them on (approved: the email went out and the next step
 * is due) or stop them (dismissed, expired); out-of-office pauses that are over end; then due
 * steps go out, each claimed for a while so two servers never take the same one.
 *
 * A step that is due waits for its sender's send window, for the next day once their mailbox sent
 * its daily limit, and for a few minutes after the mailbox's last one (so a batch isn't sent at
 * once). Its email is written from the row as the sender sees it and checked like an agent's draft
 * (lib/email-draft-check): one that doesn't pass pauses the enrollment and tells the sender. An
 * "ask me first" step puts its draft in the sender's review queue instead of sending it. The email
 * is queued in the same transaction that records the step as sent (sequence_send), so a step never
 * goes out twice, whatever crashes or runs twice.
 */

const SWEEP_MS = 30_000;
const BATCH = 20;
/** How long a claimed enrollment is held before another round may take it again (a crash midway). */
const LEASE_MINUTES = 5;
/** How long to wait after the mailbox's hourly sending limit refused a step. */
const RATE_LIMITED_MS = 10 * 60_000;

type Enrollment = typeof sequenceEnrollment.$inferSelect;
type Box = typeof mailbox.$inferSelect;

class AlreadySent extends Error {}

/** The start of today in `timeZone`, as an instant. */
const startOfToday = (now: number, timeZone: string) => zonedInstant(localDay(now, timeZone), 0, timeZone);

/** Sequence emails the mailbox sent today, in its owner's time zone (what its daily limit counts). */
export async function sentToday(box: Pick<Box, "id" | "timeZone">, now = Date.now()) {
  const [row] = await db
    .select({ n: count() })
    .from(sequenceSend)
    .where(and(eq(sequenceSend.mailboxId, box.id), gte(sequenceSend.sentAt, new Date(startOfToday(now, box.timeZone)))));
  return row?.n ?? 0;
}

/** What the enrollment's step is due next, and the update that moves it past `step`. */
function advance(e: Enrollment, steps: SequenceStep[], emailId: string, now: number) {
  const next = e.step + 1;
  const done = next >= steps.length;
  return {
    step: next,
    sent: sql`${sequenceEnrollment.sent} + 1`,
    lastEmailId: emailId,
    status: done ? ("finished" as const) : ("active" as const),
    nextAt: done ? null : new Date(stepDue(now, steps[next].days)),
    endedAt: done ? new Date(now) : null,
    reason: null,
    problems: null,
    pendingChangeId: null,
    claimedUntil: null,
  };
}

// ------------------------------------------------------------------------------- one round

/** Stops enrollments whose row is in the trash or whose sender has no mailbox in the workspace any more. */
async function stopGone() {
  await endEnrollments(sql`exists (select 1 from ${page} where ${page.id} = ${sequenceEnrollment.rowId} and ${page.archivedAt} is not null)`, "rowTrashed", null);
  await endEnrollments(
    sql`not exists (select 1 from ${mailbox} where ${mailbox.workspaceId} = ${sequenceEnrollment.workspaceId} and ${mailbox.userId} = ${sequenceEnrollment.senderId})`,
    "mailboxDisconnected",
    null,
  );
}

/** Moves on the enrollments whose step's draft its sender answered under For review. */
async function settleReviews(now: number) {
  const waiting = await db
    .select({ e: sequenceEnrollment, status: pendingChange.status, resultId: pendingChange.resultId, steps: emailSequence.steps, name: emailSequence.name })
    .from(sequenceEnrollment)
    .innerJoin(emailSequence, eq(emailSequence.id, sequenceEnrollment.sequenceId))
    .leftJoin(pendingChange, eq(pendingChange.id, sequenceEnrollment.pendingChangeId))
    .where(eq(sequenceEnrollment.status, "waiting"));
  for (const w of waiting) {
    if (w.status === "approved" && w.resultId) {
      const emailId = w.resultId;
      const [box] = await db
        .select({ id: mailbox.id })
        .from(mailbox)
        .where(and(eq(mailbox.workspaceId, w.e.workspaceId), eq(mailbox.userId, w.e.senderId)));
      const moved = await db.transaction(async (tx) => {
        await tx.insert(sequenceSend).values({ enrollmentId: w.e.id, step: w.e.step, rowEmailId: emailId, mailboxId: box?.id ?? null, sentAt: new Date(now) }).onConflictDoNothing();
        return tx
          .update(sequenceEnrollment)
          .set(advance(w.e, w.steps, emailId, now))
          .where(and(eq(sequenceEnrollment.id, w.e.id), eq(sequenceEnrollment.status, "waiting"), eq(sequenceEnrollment.step, w.e.step)))
          .returning({ id: sequenceEnrollment.id });
      });
      if (moved.length) await auditSent(w.e, w.name, w.e.step);
    } else if (w.status === "dismissed") {
      await endEnrollments(and(eq(sequenceEnrollment.id, w.e.id), eq(sequenceEnrollment.status, "waiting")), "dismissed", w.e.senderId);
    } else if (w.status === "expired" || w.status === null) {
      await endEnrollments(and(eq(sequenceEnrollment.id, w.e.id), eq(sequenceEnrollment.status, "waiting")), "draftExpired", null);
    }
  }
}

/** Ends the out-of-office pauses that are over. */
async function wakeUp(now: number) {
  const at = new Date(now);
  await db
    .update(sequenceEnrollment)
    .set({ status: "active", reason: null, pausedUntil: null, nextAt: sql`greatest(${sequenceEnrollment.nextAt}, ${at.toISOString()}::timestamptz)` })
    .where(and(eq(sequenceEnrollment.status, "paused"), eq(sequenceEnrollment.reason, "outOfOffice"), lte(sequenceEnrollment.pausedUntil, at)));
}

/**
 * Takes due enrollments for LEASE_MINUTES. Times are the round's own (`now`), not the database's,
 * so a round can be run as of any moment (scripts/follow-ups-e2e.ts).
 */
async function claim(now: number): Promise<Enrollment[]> {
  const at = new Date(now).toISOString();
  const taken = await db.execute<{ id: string }>(sql`
    update ${sequenceEnrollment} set claimed_until = ${at}::timestamptz + make_interval(mins => ${LEASE_MINUTES})
    where id in (
      select id from ${sequenceEnrollment}
      where status = 'active' and next_at <= ${at}::timestamptz and (claimed_until is null or claimed_until < ${at}::timestamptz)
      order by next_at
      limit ${BATCH}
      for update skip locked
    )
    returning id
  `);
  const ids = [...taken].map((r) => r.id);
  if (!ids.length) return [];
  return db.select().from(sequenceEnrollment).where(inArray(sequenceEnrollment.id, ids)).orderBy(sequenceEnrollment.nextAt);
}

/** Puts an enrollment back to wait until `at` (it isn't due yet after all). */
const later = (id: string, at: number) =>
  db.update(sequenceEnrollment).set({ nextAt: new Date(at), claimedUntil: null }).where(eq(sequenceEnrollment.id, id));

/** The row's values as the sender sees them, by property name, for the step's variables. */
async function rowValues(senderId: string, rowId: string, senderName: string): Promise<Record<string, string>> {
  const { properties, row, relations, people } = await getRow(senderId, rowId);
  const shown = displayProperties(properties as PropertyDef[], row.properties as Record<string, unknown>, { relations, people });
  const values: Record<string, string> = Object.fromEntries(Object.entries(shown).map(([name, value]) => [name, textOf(value)]));
  for (const name of ["Name", "Title"]) if (!Object.keys(values).some((k) => k.toLowerCase() === name.toLowerCase())) values[name] = row.title;
  values.Sender = senderName;
  return values;
}

/** Writes the step's email: to whom, in which thread, with what subject and text. Null when there is no one to write to. */
async function compose(e: Enrollment, steps: SequenceStep[], values: Record<string, string>) {
  const step = steps[e.step];
  const text = renderTemplate(step.text, values).text.trim();
  const [earlier] = e.lastEmailId
    ? await db.select({ id: rowEmail.id, to: rowEmail.to, subject: rowEmail.subject, status: rowEmail.status }).from(rowEmail).where(eq(rowEmail.id, e.lastEmailId))
    : [];
  if (earlier && earlier.status !== "hidden" && earlier.to.length) {
    return { to: earlier.to, subject: replySubject(earlier.subject), text, replyTo: earlier.id };
  }
  const to = await rowAddresses(e.rowId, e.databaseId);
  if (!to.length) return null;
  const subject = renderTemplate(steps[0].subject, values).text.trim();
  return { to, subject: e.step === 0 ? subject : replySubject(subject), text, replyTo: null };
}

/** Pauses an enrollment whose email didn't pass the check, and tells its sender. */
async function pauseForCheck(e: Enrollment, problems: EmailDraftProblem[]) {
  const [paused] = await db
    .update(sequenceEnrollment)
    .set({ status: "paused", reason: "checkFailed", problems, claimedUntil: null })
    .where(and(eq(sequenceEnrollment.id, e.id), eq(sequenceEnrollment.status, "active")))
    .returning({ id: sequenceEnrollment.id });
  if (!paused) return;
  try {
    const [made] = await db
      .insert(notification)
      .values({ userId: e.senderId, workspaceId: e.workspaceId, kind: "follow_up", pageId: e.rowId, sequenceEnrollmentId: e.id })
      .returning({ id: notification.id });
    signalInbox(e.workspaceId);
    pushNotifications([made.id]);
  } catch (error) {
    console.error("[sequences] could not tell the sender about a paused follow-up", error);
  }
}

async function auditSent(e: Enrollment, name: string, step: number) {
  const [row] = await db.select({ title: page.title }).from(page).where(eq(page.id, e.rowId));
  await recordAudit({
    workspaceId: e.workspaceId,
    actorId: e.senderId,
    action: "sequence.sent",
    target: { type: "page", id: e.rowId, label: row?.title ?? "" },
    details: { name, step: step + 1 },
  });
}

/** Does an enrollment's due step: sends it (or proposes it for review), or puts it off until it may go. */
async function processEnrollment(e: Enrollment, now = Date.now()) {
  const [sequence] = await db.select().from(emailSequence).where(eq(emailSequence.id, e.sequenceId));
  if (!sequence) return;
  const steps = sequence.steps;
  if (e.step >= steps.length) {
    // Its sequence lost steps since.
    await db.update(sequenceEnrollment).set({ status: "finished", nextAt: null, endedAt: new Date(now), claimedUntil: null }).where(eq(sequenceEnrollment.id, e.id));
    return;
  }
  const step = steps[e.step];
  const one = eq(sequenceEnrollment.id, e.id);
  const [box] = await db
    .select({ box: mailbox, name: user.name })
    .from(mailbox)
    .innerJoin(user, eq(user.id, mailbox.userId))
    .where(and(eq(mailbox.workspaceId, e.workspaceId), eq(mailbox.userId, e.senderId)));
  if (!box) return void (await endEnrollments(one, "mailboxDisconnected", null));
  if (!(await workspaceSettings(e.workspaceId)).email) return void (await endEnrollments(one, "emailOff", null));
  const access = await rowMailAccess(e.senderId, e.rowId);
  if (!access || (access.level !== "edit" && access.level !== "full")) return void (await endEnrollments(one, "noAccess", null));

  if (step.mode === "auto") {
    const slot = nextSendSlot({
      due: e.nextAt?.getTime() ?? now,
      now,
      notBefore: box.box.followUpAfter?.getTime() ?? 0,
      window: sequence.window,
      timeZone: box.box.timeZone,
      sentToday: await sentToday(box.box, now),
      dailyLimit: box.box.followUpDailyLimit,
    });
    if (slot === null) return void (await later(e.id, now + 86_400_000));
    if (slot > now) return void (await later(e.id, slot));
  }

  const email = await compose(e, steps, await rowValues(e.senderId, e.rowId, box.box.displayName || box.name));
  if (!email) return void (await endEnrollments(one, "noAddress", null));
  const check = checkEmailDraft({ subject: email.subject, text: email.text });
  if (!check.ok) return void (await pauseForCheck(e, check.problems.map((p) => p.problem)));

  if (step.mode === "review") {
    const { id } = await proposeChange({
      workspaceId: e.workspaceId,
      kind: "email_draft",
      databaseId: e.databaseId,
      rowId: e.rowId,
      payload: { ...email, cc: [] },
      before: null,
      // Which step of which sequence it is comes with `source`, shown in the reviewer's language.
      reason: "",
      source: { kind: "sequence", sequenceId: sequence.id, name: sequence.name, enrollmentId: e.id, step: e.step + 1, steps: steps.length },
      agent: null,
      runId: null,
      senderId: e.senderId,
      for: [],
    });
    await db.update(sequenceEnrollment).set({ status: "waiting", pendingChangeId: id, nextAt: null, claimedUntil: null }).where(and(one, eq(sequenceEnrollment.status, "active")));
    return;
  }

  try {
    await queueRowEmail(
      e.senderId,
      e.rowId,
      { ...email, cc: [] },
      {
        within: async (tx, emailId) => {
          // The step's record, in the email's own transaction: taken already, it went out before.
          const [taken] = await tx.insert(sequenceSend).values({ enrollmentId: e.id, step: e.step, rowEmailId: emailId, mailboxId: box.box.id, sentAt: new Date(now) }).onConflictDoNothing().returning();
          if (!taken) throw new AlreadySent();
          await tx.update(sequenceEnrollment).set(advance(e, steps, emailId, now)).where(and(one, eq(sequenceEnrollment.step, e.step)));
          await tx.update(mailbox).set({ followUpAfter: new Date(now + spreadMs()) }).where(eq(mailbox.id, box.box.id));
        },
      },
    );
  } catch (error) {
    if (error instanceof AlreadySent) {
      // Sent by an earlier round that stopped before moving on (it can't, as both are one transaction, but a step is never sent twice).
      const [sent] = await db.select().from(sequenceSend).where(and(eq(sequenceSend.enrollmentId, e.id), eq(sequenceSend.step, e.step)));
      await db.update(sequenceEnrollment).set(advance(e, steps, sent?.rowEmailId ?? e.lastEmailId ?? "", now)).where(and(one, eq(sequenceEnrollment.step, e.step)));
      return;
    }
    if (error instanceof RowMailError) {
      if (error.code === "rateLimited") return void (await later(e.id, now + RATE_LIMITED_MS));
      if (error.code === "gone") {
        // The email it answers was hidden or deleted: the next round starts a new thread.
        await db.update(sequenceEnrollment).set({ lastEmailId: null, claimedUntil: null }).where(one);
        return;
      }
      return void (await endEnrollments(one, error.code === "noMailbox" ? "mailboxDisconnected" : error.code === "disabled" ? "emailOff" : "noAddress", null));
    }
    if (error instanceof AccessError) return void (await endEnrollments(one, "noAccess", null));
    throw error;
  }
  sendSoon();
  await auditSent(e, sequence.name, e.step);
}

/** One round of the job (see the note at the top); returns how many due enrollments it took. */
export async function runSequences(now = Date.now()) {
  await stopGone();
  await settleReviews(now);
  await wakeUp(now);
  let taken = 0;
  // A few batches a round: the rest wait for the next one.
  for (let i = 0; i < 10; i++) {
    const batch = await claim(now);
    if (!batch.length) break;
    for (const e of batch) {
      taken += 1;
      try {
        await processEnrollment(e, now);
      } catch (error) {
        console.error("[sequences] a follow-up step failed", error);
        // Tried again at the next round but one.
        await later(e.id, now + 60_000).catch(() => {});
      }
    }
  }
  return taken;
}

let stop: (() => void) | null = null;
let kick: Promise<unknown> | null = null;

/** Runs a round now rather than at the next one (an enrollment, a resume). */
function runSoon() {
  kick ??= runSequences()
    .catch((error) => console.error("[sequences] round failed", error))
    .finally(() => (kick = null));
}

/** Sends follow-ups every 30 seconds (server.ts). */
export function startSequences() {
  (globalThis as { __leafdeskSequenceKick?: () => void }).__leafdeskSequenceKick = runSoon;
  stop ??= startSweep(SWEEP_MS, () => runSequences(), "[sequences] round failed");
  return stop;
}
