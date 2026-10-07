import { and, eq, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page, pendingAssignmentEmail, user } from "@/db/schema";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { newAssignees } from "@/lib/properties";
import { resolvePageAccess } from "@/server/access";
import { agentUserIds } from "@/server/agents/users";
import { seesValue } from "@/server/property-access";
import { assignmentEmail, mailStatus, sendMail, type OutgoingMail } from "@/server/mail";
import { recipientLocale, requestLocale } from "@/server/mail/locale";
import { emailTranslator } from "@/server/mail/templates";
import { wantsEmail } from "@/server/notification-preferences";

/**
 * Emails people when someone else assigns them to a database row. Sending waits a little and then
 * checks the assignment still stands, so picking the wrong person and fixing it right away sends
 * nothing, and several quick edits to one row send one email per person. The queue lives in the
 * database, so a restart delays emails instead of losing them.
 */

export const ASSIGNMENT_EMAIL_DELAY_MS = 10_000;
/** How often the server looks for queued emails that are due. */
const SWEEP_INTERVAL_MS = 5_000;

type Change = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };
type Pending = typeof pendingAssignmentEmail.$inferSelect;

let mailer: (mail: OutgoingMail) => Promise<void> = sendMail;

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Queues an email for everyone the changes newly assign and drops the queued email of anyone they
 * unassign, so being removed and re-adding oneself before the delay sends nothing; never throws.
 */
export async function scheduleAssignmentEmails(actorId: string | null, personProps: { id: string }[], changes: Change[]) {
  try {
    const removed = changes.flatMap((c) =>
      personProps.flatMap((prop) => {
        const kept = new Set(ids(c.after[prop.id]));
        return ids(c.before[prop.id])
          .filter((userId) => !kept.has(userId))
          .map((userId) => and(eq(pendingAssignmentEmail.rowId, c.rowId), eq(pendingAssignmentEmail.propertyId, prop.id), eq(pendingAssignmentEmail.userId, userId)));
      }),
    );
    if (removed.length) await db.delete(pendingAssignmentEmail).where(or(...removed));
    const assigned = changes.flatMap((c) => newAssignees(personProps, c.before, c.after, actorId).map((a) => ({ ...a, rowId: c.rowId })));
    if (!assigned.length || mailStatus() === "disabled") return;
    // Agents' users get no email.
    const agents = await agentUserIds(assigned.map((a) => a.userId));
    const found = assigned.filter((a) => !agents.has(a.userId));
    if (!found.length) return;
    const locale = await requestLocale();
    const dueAt = new Date(Date.now() + ASSIGNMENT_EMAIL_DELAY_MS);
    await db
      .insert(pendingAssignmentEmail)
      .values(found.map((a) => ({ rowId: a.rowId, propertyId: a.propertyId, userId: a.userId, actorId, locale, dueAt })))
      .onConflictDoUpdate({
        target: [pendingAssignmentEmail.rowId, pendingAssignmentEmail.propertyId, pendingAssignmentEmail.userId],
        set: { actorId, locale, dueAt },
      });
  } catch (error) {
    console.error("could not queue assignment emails", error);
  }
}

/** Takes the due emails off the queue (all of them with `everything`) and sends them. */
async function deliverDue(everything = false) {
  // Deleting before sending means an email is sent at most once, even with two sweeps racing.
  const due = await db
    .delete(pendingAssignmentEmail)
    .where(everything ? undefined : lte(pendingAssignmentEmail.dueAt, new Date()))
    .returning();
  for (const entry of due) {
    try {
      await send(entry);
    } catch (error) {
      console.error("could not send assignment email", error);
    }
  }
}

let sweeping = false;

/** Server only: sends queued emails as they fall due, including any left from before a restart. */
export function startAssignmentEmails() {
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await deliverDue();
    } catch (error) {
      console.error("could not deliver assignment emails", error);
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Sends one queued email if the person still wants it, is still assigned and can open the row; in
 * their language, else in that of whoever assigned them.
 */
async function send({ actorId, rowId, propertyId, userId, locale: queuedLocale }: Pending) {
  const locale = await recipientLocale(userId, queuedLocale);
  const [row] = await db
    .select({
      title: page.title,
      properties: page.properties,
      parentId: page.parentId,
      workspaceId: page.workspaceId,
      archivedAt: page.archivedAt,
      createdBy: page.createdBy,
    })
    .from(page)
    .where(eq(page.id, rowId));
  if (!row?.parentId || row.archivedAt || !ids(row.properties[propertyId]).includes(userId)) return;
  if ((await resolvePageAccess(userId, rowId)).level === "none") return;
  // The property's access may have changed since: never name a value hidden from them.
  if (!(await seesValue(userId, row.parentId, propertyId, { properties: row.properties, createdBy: row.createdBy }))) return;
  if (!(await wantsEmail(userId, "assignment"))) return;
  const [[recipient], [actor], [database], [prop]] = await Promise.all([
    db.select({ email: user.email }).from(user).where(eq(user.id, userId)),
    actorId ? db.select({ name: user.name }).from(user).where(eq(user.id, actorId)) : [],
    db.select({ title: page.title }).from(page).where(eq(page.id, row.parentId)),
    db
      .select({ name: databaseProperty.name })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.id, propertyId), eq(databaseProperty.databaseId, row.parentId))),
  ]);
  if (!recipient?.email || !prop) return;
  const t = emailTranslator(locale);
  const untitled = t("assignment.untitled");
  const content = assignmentEmail(locale, {
    // No actor: an anonymous form answer, or someone whose account is gone.
    actorName: actor?.name || t("assignment.someone"),
    rowTitle: pageLabel(row.title, untitled),
    databaseTitle: pageLabel(database?.title, untitled),
    propertyName: prop.name,
    link: `${env.appUrl}/w/${row.workspaceId}/p/${rowId}`,
  });
  await mailer({ to: recipient.email, ...content });
}

/** Scripts and tests: send everything queued now instead of after the delay. */
export async function flushAssignmentEmails() {
  await deliverDue(true);
}

/** Scripts and tests: capture emails instead of sending them (null restores sending). */
export function setAssignmentMailer(send: ((mail: OutgoingMail) => Promise<void>) | null) {
  mailer = send ?? sendMail;
}
