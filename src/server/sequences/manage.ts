import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { emailSequence, mailbox, mailDatabase, page, pendingChange, sequenceEnrollment, user } from "@/db/schema";
import { normalizeAddress } from "@/lib/mail";
import {
  checkWindow,
  DEFAULT_SEND_WINDOW,
  isOpenEnrollment,
  MAX_BULK_ENROLL,
  MAX_SEQUENCE_NAME,
  MAX_SEQUENCE_STEPS,
  MAX_SEQUENCES,
  MAX_STEP_DAYS,
  MAX_STEP_SUBJECT,
  MAX_STEP_TEXT,
  OPEN_ENROLLMENT,
  SEQUENCE_STEP_MODES,
  stepDraftProblems,
  stepDue,
  templateProblems,
  type EnrollmentSource,
  type EnrollmentView,
  type SendWindow,
  type SequenceStep,
  type SequenceStepMode,
  type SequenceView,
  type StopReason,
} from "@/lib/sequences";
import { AccessError, pageAccessOf, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getProperties } from "@/server/databases";
import { signalInbox } from "@/server/notifications";
import { rowMailAccess } from "@/server/row-mail/access";
import { workspaceSettings } from "@/server/workspaces";

/**
 * Follow-up sequences (lib/sequences.ts): owners of the workspace write them for its mail
 * databases, where its email settings are; whoever may write email on a row enrolls it, the
 * emails then going out from their own mailbox (server/sequences/run.ts sends them). Whoever may
 * edit the row stops an enrollment; its sender resumes a paused one.
 */

export type SequenceErrorCode =
  | "notFound"
  | "notMailDatabase"
  | "tooMany"
  | "invalid"
  | "name"
  | "noSteps"
  | "tooManySteps"
  | "days"
  | "subject"
  | "text"
  | "noFallback"
  | "emptyVariable"
  | "unknownVariable"
  | "draftCheck"
  | "window"
  | "emailOff"
  | "noMailbox"
  | "noAccess"
  | "noAddress"
  | "alreadyEnrolled"
  | "notOpen"
  | "notSender"
  | "tooManyRows";

/** A sequence or enrollment request that can't be done as asked; `params` fill in its message (`step` is 1-based). */
export class SequenceError extends Error {
  constructor(
    readonly code: SequenceErrorCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(sequenceErrorMessage(code, params));
  }
}

/** The message for MCP, the REST API and logs (the app translates the code). */
function sequenceErrorMessage(code: SequenceErrorCode, p: Record<string, string | number>): string {
  const step = p.step ? `Step ${p.step}: ` : "";
  switch (code) {
    case "notFound":
      return "No follow-up sequence or enrollment has this id, or you may not see it.";
    case "notMailDatabase":
      return "Follow-ups are for databases email lands on (Settings > General > Email).";
    case "tooMany":
      return `A database has at most ${MAX_SEQUENCES} sequences.`;
    case "name":
      return `A sequence needs a name of at most ${MAX_SEQUENCE_NAME} characters.`;
    case "noSteps":
      return "A sequence needs at least one step.";
    case "tooManySteps":
      return `A sequence has at most ${MAX_SEQUENCE_STEPS} steps.`;
    case "days":
      return `${step}waits a whole number of days from 0 to ${MAX_STEP_DAYS}.`;
    case "subject":
      return `${step}the first email needs a subject, on one line, of at most ${MAX_STEP_SUBJECT} characters.`;
    case "text":
      return `${step}the email needs a text of at most ${MAX_STEP_TEXT} characters.`;
    case "noFallback":
      return `${step}{{${p.name}}} needs a fallback for rows where it is empty: write {{${p.name} | something}}.`;
    case "emptyVariable":
      return `${step}${p.name} names no property.`;
    case "unknownVariable":
      return `${step}the database has no property "${p.name}".`;
    case "draftCheck":
      return `${step}the email isn't plain finished text (${p.problems}): write it without Markdown, HTML, gaps in brackets or links into the app.`;
    case "window":
      return "The send window needs at least one weekday and an end after its start.";
    case "emailOff":
      return "Email on rows is off in this workspace.";
    case "noMailbox":
      return "Connect your mailbox in this workspace first (My account > Email and calendar).";
    case "noAccess":
      return "You may not write email on this row.";
    case "noAddress":
      return "The row has no email address to write to.";
    case "alreadyEnrolled":
      return "The row is in this sequence already.";
    case "notOpen":
      return "This follow-up isn't going on any more, or isn't paused.";
    case "notSender":
      return "Only the person whose mailbox it sends from may resume it.";
    case "tooManyRows":
      return `A follow-up starts on at most ${MAX_BULK_ENROLL} rows at once.`;
    default:
      return "This can't be done.";
  }
}

type Sequence = typeof emailSequence.$inferSelect;
type Enrollment = typeof sequenceEnrollment.$inferSelect;

// ---------------------------------------------------------------------------------- sequences

function sequenceView(s: Sequence, open: number): SequenceView {
  return { id: s.id, workspaceId: s.workspaceId, databaseId: s.databaseId, name: s.name, steps: s.steps, window: s.window, open, updatedAt: s.updatedAt.toISOString() };
}

async function openCounts(sequenceIds: string[]) {
  if (!sequenceIds.length) return new Map<string, number>();
  const rows = await db
    .select({ id: sequenceEnrollment.sequenceId, n: count() })
    .from(sequenceEnrollment)
    .where(and(inArray(sequenceEnrollment.sequenceId, sequenceIds), inArray(sequenceEnrollment.status, [...OPEN_ENROLLMENT])))
    .groupBy(sequenceEnrollment.sequenceId);
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** The sequences of a database, for whoever may open it. */
export async function listSequences(userId: string, databaseId: string): Promise<SequenceView[]> {
  const { page: database, level } = await pageAccessOf(userId, databaseId);
  if (!database || level === "none" || database.kind !== "database") throw new SequenceError("notFound");
  const rows = await db.select().from(emailSequence).where(eq(emailSequence.databaseId, databaseId)).orderBy(asc(emailSequence.name), asc(emailSequence.createdAt));
  const open = await openCounts(rows.map((r) => r.id));
  return rows.map((r) => sequenceView(r, open.get(r.id) ?? 0));
}

/** The sequences of every mail database of a workspace, by database, for its settings (owners). */
export async function listWorkspaceSequences(userId: string, workspaceId: string): Promise<SequenceView[]> {
  await requireMembership(userId, workspaceId, "owner");
  const rows = await db.select().from(emailSequence).where(eq(emailSequence.workspaceId, workspaceId)).orderBy(asc(emailSequence.name), asc(emailSequence.createdAt));
  const open = await openCounts(rows.map((r) => r.id));
  return rows.map((r) => sequenceView(r, open.get(r.id) ?? 0));
}

/** A sequence, for whoever may open its database. */
export async function getSequence(userId: string, sequenceId: string): Promise<SequenceView> {
  const [row] = await db.select().from(emailSequence).where(eq(emailSequence.id, sequenceId));
  if (!row) throw new SequenceError("notFound");
  const { level } = await pageAccessOf(userId, row.databaseId);
  if (level === "none") throw new SequenceError("notFound");
  return sequenceView(row, (await openCounts([row.id])).get(row.id) ?? 0);
}

export type SequenceInput = {
  name: string;
  steps: { id?: string | null; days: number; subject?: string | null; text: string; mode: SequenceStepMode }[];
  window?: SendWindow | null;
};

/** A sequence as typed, checked against the database's properties (see the errors above). */
export async function checkSequence(databaseId: string, input: SequenceInput): Promise<{ name: string; steps: SequenceStep[]; window: SendWindow }> {
  const name = typeof input?.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_SEQUENCE_NAME) throw new SequenceError("name");
  if (!Array.isArray(input.steps) || !input.steps.length) throw new SequenceError("noSteps");
  if (input.steps.length > MAX_SEQUENCE_STEPS) throw new SequenceError("tooManySteps");
  const names = (await getProperties(databaseId)).map((p) => p.name);
  const ids = new Set<string>();
  const steps = input.steps.map((s, i): SequenceStep => {
    const step = i + 1;
    if (!s || typeof s !== "object") throw new SequenceError("invalid", { step });
    if (!Number.isInteger(s.days) || s.days < 0 || s.days > MAX_STEP_DAYS) throw new SequenceError("days", { step });
    const mode = (SEQUENCE_STEP_MODES as readonly string[]).includes(s.mode) ? s.mode : null;
    if (!mode) throw new SequenceError("invalid", { step });
    // Later steps answer in the first one's thread: theirs would be "Re: …" anyway.
    const subject = i === 0 ? (typeof s.subject === "string" ? s.subject.trim() : "") : "";
    if (i === 0 && (!subject || subject.length > MAX_STEP_SUBJECT || /[\r\n]/.test(subject))) throw new SequenceError("subject", { step });
    const text = typeof s.text === "string" ? s.text.replace(/\r\n/g, "\n").trim() : "";
    if (!text || text.length > MAX_STEP_TEXT) throw new SequenceError("text", { step });
    for (const problem of templateProblems(`${subject}\n${text}`, names)) {
      const code = problem.problem === "noFallback" ? "noFallback" : problem.problem === "empty" ? "emptyVariable" : "unknownVariable";
      throw new SequenceError(code, { step, name: problem.name });
    }
    const problems = stepDraftProblems({ subject, text }, i === 0);
    if (problems.length) throw new SequenceError("draftCheck", { step, problems: problems.join(", ") });
    let id = typeof s.id === "string" && /^[\w-]{1,40}$/.test(s.id) ? s.id : crypto.randomUUID().slice(0, 8);
    while (ids.has(id)) id = crypto.randomUUID().slice(0, 8);
    ids.add(id);
    return { id, days: s.days, subject, text, mode };
  });
  const window = input.window === undefined || input.window === null ? DEFAULT_SEND_WINDOW : checkWindow(input.window);
  if (!window) throw new SequenceError("window");
  return { name, steps, window };
}

/** The database, for an owner of its workspace, when mail lands on it. */
async function mailDatabaseFor(userId: string, databaseId: string) {
  const [database] = await db
    .select({ id: page.id, workspaceId: page.workspaceId, title: page.title, matched: mailDatabase.databaseId })
    .from(page)
    .leftJoin(mailDatabase, eq(mailDatabase.databaseId, page.id))
    .where(and(eq(page.id, databaseId), eq(page.kind, "database")));
  if (!database) throw new SequenceError("notFound");
  await requireMembership(userId, database.workspaceId, "owner");
  if (!database.matched) throw new SequenceError("notMailDatabase");
  return database;
}

/** Adds a sequence to a mail database (owners). */
export async function createSequence(userId: string, databaseId: string, input: SequenceInput): Promise<SequenceView> {
  const database = await mailDatabaseFor(userId, databaseId);
  const [{ n }] = await db.select({ n: count() }).from(emailSequence).where(eq(emailSequence.databaseId, databaseId));
  if (n >= MAX_SEQUENCES) throw new SequenceError("tooMany");
  const checked = await checkSequence(databaseId, input);
  const [made] = await db
    .insert(emailSequence)
    .values({ workspaceId: database.workspaceId, databaseId, ...checked, createdBy: userId })
    .returning();
  await recordAudit({
    workspaceId: database.workspaceId,
    actorId: userId,
    action: "sequence.created",
    target: { type: "page", id: databaseId, label: database.title },
    details: { name: made.name, steps: made.steps.length },
  });
  return sequenceView(made, 0);
}

/**
 * Changes a sequence (owners). Enrollments under way go on with the new steps from the one they
 * are on: one past the last step finishes.
 */
export async function updateSequence(userId: string, sequenceId: string, input: SequenceInput): Promise<SequenceView> {
  const [current] = await db.select().from(emailSequence).where(eq(emailSequence.id, sequenceId));
  if (!current) throw new SequenceError("notFound");
  const database = await mailDatabaseFor(userId, current.databaseId);
  const checked = await checkSequence(current.databaseId, input);
  const [saved] = await db.update(emailSequence).set(checked).where(eq(emailSequence.id, sequenceId)).returning();
  await recordAudit({
    workspaceId: database.workspaceId,
    actorId: userId,
    action: "sequence.updated",
    target: { type: "page", id: current.databaseId, label: database.title },
    details: { name: saved.name, steps: saved.steps.length },
  });
  return sequenceView(saved, (await openCounts([saved.id])).get(saved.id) ?? 0);
}

/** Deletes a sequence (owners): its enrollments under way stop first, then go with it. */
export async function deleteSequence(userId: string, sequenceId: string) {
  const [current] = await db.select().from(emailSequence).where(eq(emailSequence.id, sequenceId));
  if (!current) throw new SequenceError("notFound");
  const database = await mailDatabaseFor(userId, current.databaseId);
  await endEnrollments(and(eq(sequenceEnrollment.sequenceId, sequenceId), inArray(sequenceEnrollment.status, [...OPEN_ENROLLMENT])), "manual", userId);
  await db.delete(emailSequence).where(eq(emailSequence.id, sequenceId));
  await recordAudit({
    workspaceId: database.workspaceId,
    actorId: userId,
    action: "sequence.deleted",
    target: { type: "page", id: current.databaseId, label: database.title },
    details: { name: current.name },
  });
}

// -------------------------------------------------------------------------------- enrollments

/** The row's own addresses: the values of the email properties mail is matched on. */
export async function rowAddresses(rowId: string, databaseId: string): Promise<string[]> {
  const [[matched], [row]] = await Promise.all([
    db.select({ propertyIds: mailDatabase.propertyIds }).from(mailDatabase).where(eq(mailDatabase.databaseId, databaseId)),
    db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)),
  ]);
  const values = (row?.properties ?? {}) as Record<string, unknown>;
  return [...new Set((matched?.propertyIds ?? []).map((id) => normalizeAddress(values[id])).filter((a): a is string => !!a))];
}

export type EnrollOutcome = { rowId: string; ok: true; enrollment: EnrollmentView } | { rowId: string; ok: false; code: SequenceErrorCode; error: string };

/**
 * Enrolls rows in a sequence, sending from the user's own mailbox: each row on its own (one the
 * user may not write email on, without an address, or in the sequence already is skipped with
 * why). The first step is due its days from now.
 */
export async function enrollRows(userId: string, sequenceId: string, rowIds: string[], source: EnrollmentSource): Promise<EnrollOutcome[]> {
  const [sequence] = await db.select().from(emailSequence).where(eq(emailSequence.id, sequenceId));
  if (!sequence || (await pageAccessOf(userId, sequence.databaseId)).level === "none") throw new SequenceError("notFound");
  if (new Set(rowIds).size > MAX_BULK_ENROLL) throw new SequenceError("tooManyRows");
  if (!(await workspaceSettings(sequence.workspaceId)).email) throw new SequenceError("emailOff");
  const [box] = await db
    .select({ id: mailbox.id })
    .from(mailbox)
    .where(and(eq(mailbox.workspaceId, sequence.workspaceId), eq(mailbox.userId, userId)));
  if (!box) throw new SequenceError("noMailbox");
  const out: EnrollOutcome[] = [];
  const audits: Parameters<typeof recordAudit>[0] = [];
  const skip = (rowId: string, code: SequenceErrorCode) => out.push({ rowId, ok: false, code, error: sequenceErrorMessage(code, {}) });
  for (const rowId of new Set(rowIds)) {
    const access = typeof rowId === "string" ? await rowMailAccess(userId, rowId) : null;
    if (!access || access.databaseId !== sequence.databaseId) {
      skip(rowId, access ? "notFound" : "noAccess");
      continue;
    }
    if (access.level !== "edit" && access.level !== "full") {
      skip(rowId, "noAccess");
      continue;
    }
    if (!(await rowAddresses(rowId, sequence.databaseId)).length) {
      skip(rowId, "noAddress");
      continue;
    }
    const now = Date.now();
    const [made] = await db
      .insert(sequenceEnrollment)
      .values({
        workspaceId: sequence.workspaceId,
        sequenceId,
        databaseId: sequence.databaseId,
        rowId,
        senderId: userId,
        status: "active",
        step: 0,
        nextAt: new Date(stepDue(now, sequence.steps[0]?.days ?? 0)),
        source,
        enrolledBy: userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!made) {
      skip(rowId, "alreadyEnrolled");
      continue;
    }
    const [row] = await db.select({ title: page.title }).from(page).where(eq(page.id, rowId));
    audits.push({
      workspaceId: sequence.workspaceId,
      actorId: userId,
      action: "sequence.enrolled",
      target: { type: "page", id: rowId, label: row?.title ?? "" },
      details: { name: sequence.name, source },
    });
    out.push({ rowId, ok: true, enrollment: (await viewsOf(userId, eq(sequenceEnrollment.id, made.id)))[0] });
  }
  await recordAudit(audits);
  kickSequences();
  return out;
}

/** The enrollment, for someone who sees its row's email. */
async function enrollmentFor(userId: string, enrollmentId: string) {
  const [found] = await db.select().from(sequenceEnrollment).where(eq(sequenceEnrollment.id, enrollmentId));
  const access = found ? await rowMailAccess(userId, found.rowId) : null;
  if (!found || !access) throw new SequenceError("notFound");
  return { enrollment: found, access };
}

/** Stops an enrollment by hand: its sender, or whoever may edit the row. A draft of it waiting for review goes too. */
export async function stopEnrollment(userId: string, enrollmentId: string): Promise<EnrollmentView> {
  const { enrollment, access } = await enrollmentFor(userId, enrollmentId);
  if (enrollment.senderId !== userId && access.level !== "edit" && access.level !== "full") throw new AccessError();
  if (!isOpenEnrollment(enrollment.status)) throw new SequenceError("notOpen");
  await endEnrollments(eq(sequenceEnrollment.id, enrollmentId), "manual", userId);
  return (await viewsOf(userId, eq(sequenceEnrollment.id, enrollmentId)))[0];
}

/** Resumes a paused enrollment (its sender): the step it is on goes out as soon as the send window allows. */
export async function resumeEnrollment(userId: string, enrollmentId: string): Promise<EnrollmentView> {
  const { enrollment } = await enrollmentFor(userId, enrollmentId);
  if (enrollment.senderId !== userId) throw new SequenceError("notSender");
  const [resumed] = await db
    .update(sequenceEnrollment)
    .set({ status: "active", reason: null, problems: null, pausedUntil: null, nextAt: sql`greatest(${sequenceEnrollment.nextAt}, now())`, claimedUntil: null })
    .where(and(eq(sequenceEnrollment.id, enrollmentId), eq(sequenceEnrollment.status, "paused")))
    .returning({ id: sequenceEnrollment.id });
  if (!resumed) throw new SequenceError("notOpen");
  kickSequences();
  return (await viewsOf(userId, eq(sequenceEnrollment.id, enrollmentId)))[0];
}

/**
 * Ends the enrollments `where` picks that still go on, with `reason` (by `actorId`, or the server
 * itself), withdrawing their drafts still waiting for review, and records each in the audit log.
 * Returns the ones it ended.
 */
export async function endEnrollments(where: SQL | undefined, reason: StopReason, actorId: string | null) {
  const ended = await db
    .update(sequenceEnrollment)
    .set({ status: "stopped", reason, nextAt: null, claimedUntil: null, endedAt: new Date(), stoppedBy: actorId })
    .where(and(where, inArray(sequenceEnrollment.status, [...OPEN_ENROLLMENT])))
    .returning();
  if (!ended.length) return ended;
  const drafts = ended.flatMap((e) => (e.pendingChangeId ? [e.pendingChangeId] : []));
  if (drafts.length) {
    const withdrawn = await db
      .update(pendingChange)
      .set({ status: "dismissed", decidedBy: actorId, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(inArray(pendingChange.id, drafts), inArray(pendingChange.status, ["pending", "failed"])))
      .returning({ workspaceId: pendingChange.workspaceId });
    for (const ws of new Set(withdrawn.map((w) => w.workspaceId))) signalInbox(ws);
  }
  const [names, titles] = await Promise.all([
    db.select({ id: emailSequence.id, name: emailSequence.name }).from(emailSequence).where(inArray(emailSequence.id, [...new Set(ended.map((e) => e.sequenceId))])),
    db.select({ id: page.id, title: page.title }).from(page).where(inArray(page.id, [...new Set(ended.map((e) => e.rowId))])),
  ]);
  await recordAudit(
    ended.map((e) => ({
      workspaceId: e.workspaceId,
      actorId,
      action: "sequence.stopped" as const,
      target: { type: "page" as const, id: e.rowId, label: titles.find((t) => t.id === e.rowId)?.title ?? "" },
      details: { name: names.find((n) => n.id === e.sequenceId)?.name ?? "", reason, step: e.step + 1 },
    })),
  );
  return ended;
}

export type EnrollmentScope = { rowId?: string | null; databaseId?: string | null; sequenceId?: string | null; workspaceId?: string | null };

/**
 * Enrollments the user may see (they read the row's email), newest first: those still going
 * (`open`, the default) or all kept ones, narrowed by `scope` (one of its fields at least).
 */
export async function listEnrollments(userId: string, scope: EnrollmentScope, { open = true, limit = 100 }: { open?: boolean; limit?: number } = {}): Promise<EnrollmentView[]> {
  const where = and(
    scope.rowId ? eq(sequenceEnrollment.rowId, scope.rowId) : undefined,
    scope.databaseId ? eq(sequenceEnrollment.databaseId, scope.databaseId) : undefined,
    scope.sequenceId ? eq(sequenceEnrollment.sequenceId, scope.sequenceId) : undefined,
    scope.workspaceId ? eq(sequenceEnrollment.workspaceId, scope.workspaceId) : undefined,
    open ? inArray(sequenceEnrollment.status, [...OPEN_ENROLLMENT]) : undefined,
  );
  if (!scope.rowId && !scope.databaseId && !scope.sequenceId && !scope.workspaceId) return [];
  return viewsOf(userId, where, Math.min(Math.max(1, limit), 500));
}

/** One enrollment as the user sees it. */
export async function getEnrollment(userId: string, enrollmentId: string): Promise<EnrollmentView> {
  await enrollmentFor(userId, enrollmentId);
  return (await viewsOf(userId, eq(sequenceEnrollment.id, enrollmentId)))[0];
}

async function viewsOf(viewer: string, where: SQL | undefined, limit = 1): Promise<EnrollmentView[]> {
  const rows = await db
    .select({ e: sequenceEnrollment, name: emailSequence.name, steps: emailSequence.steps, rowTitle: page.title, senderName: user.name })
    .from(sequenceEnrollment)
    .innerJoin(emailSequence, eq(emailSequence.id, sequenceEnrollment.sequenceId))
    .innerJoin(page, eq(page.id, sequenceEnrollment.rowId))
    .innerJoin(user, eq(user.id, sequenceEnrollment.senderId))
    .where(where)
    .orderBy(desc(sequenceEnrollment.startedAt), desc(sequenceEnrollment.id))
    .limit(limit);
  const access = new Map<string, Promise<Awaited<ReturnType<typeof rowMailAccess>>>>();
  const accessOf = (rowId: string) => {
    if (!access.has(rowId)) access.set(rowId, rowMailAccess(viewer, rowId));
    return access.get(rowId)!;
  };
  const out: EnrollmentView[] = [];
  for (const r of rows) {
    const seen = await accessOf(r.e.rowId);
    if (!seen) continue;
    out.push(enrollmentView(r.e, { name: r.name, steps: r.steps.length, rowTitle: r.rowTitle, senderName: r.senderName }, viewer, seen.level));
  }
  return out;
}

function enrollmentView(e: Enrollment, info: { name: string; steps: number; rowTitle: string; senderName: string }, viewer: string, level: string): EnrollmentView {
  const open = isOpenEnrollment(e.status);
  return {
    id: e.id,
    workspaceId: e.workspaceId,
    sequence: { id: e.sequenceId, name: info.name },
    row: { id: e.rowId, title: info.rowTitle },
    databaseId: e.databaseId,
    sender: { id: e.senderId, name: info.senderName },
    status: e.status,
    step: Math.min(e.step + 1, Math.max(info.steps, 1)),
    steps: info.steps,
    sent: e.sent,
    nextAt: e.status === "active" || e.status === "paused" ? (e.nextAt?.toISOString() ?? null) : null,
    pausedUntil: e.status === "paused" ? (e.pausedUntil?.toISOString() ?? null) : null,
    reason: e.reason,
    problems: e.status === "paused" ? e.problems : null,
    reviewChangeId: e.status === "waiting" ? e.pendingChangeId : null,
    source: e.source,
    startedAt: e.startedAt.toISOString(),
    endedAt: e.endedAt?.toISOString() ?? null,
    canStop: open && (e.senderId === viewer || level === "edit" || level === "full"),
    canResume: e.status === "paused" && e.senderId === viewer,
  };
}

/** Deletes finished and stopped enrollments that ended before `cutoff` (the daily cleanup, retention.ts). */
export async function pruneEnrollments(cutoff: Date, workspaceIds?: string[]) {
  if (workspaceIds?.length === 0) return 0;
  const gone = await db
    .delete(sequenceEnrollment)
    .where(
      and(
        workspaceIds ? inArray(sequenceEnrollment.workspaceId, workspaceIds) : undefined,
        inArray(sequenceEnrollment.status, ["finished", "stopped"]),
        sql`${sequenceEnrollment.endedAt} <= ${cutoff.toISOString()}`,
      ),
    )
    .returning({ id: sequenceEnrollment.id });
  return gone.length;
}

/** Asks the sending job to look now rather than at its next round (set by run.ts in the server process). */
export function kickSequences() {
  (globalThis as { __leafdeskSequenceKick?: () => void }).__leafdeskSequenceKick?.();
}
