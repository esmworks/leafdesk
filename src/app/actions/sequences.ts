"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { EnrollmentView, SequenceView } from "@/lib/sequences";
import { AccessError, getMembership, pageAccessOf } from "@/server/access";
import { getProperties } from "@/server/databases";
import {
  createSequence,
  deleteSequence,
  enrollRows,
  listEnrollments,
  listSequences,
  resumeEnrollment,
  SequenceError,
  stopEnrollment,
  updateSequence,
  type EnrollOutcome,
  type SequenceInput,
} from "@/server/sequences/manage";
import { rowMailAccess } from "@/server/row-mail/access";
import { requireUserId } from "@/server/session";

// Follow-up sequences (server/sequences): owners write them where the workspace's email settings
// are; whoever may write email on a row starts one on it, from their own mailbox. Expected
// failures come back translated: Next.js hides thrown messages in production.

const PROBLEMS = ["emptyText", "subjectLineBreak", "placeholder", "markdown", "html", "internal"] as const;

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("database.followUps");
    if (error instanceof SequenceError) {
      const params = { step: 0, name: "", problems: "", ...error.params };
      if (error.code === "draftCheck") {
        params.problems = String(params.problems)
          .split(", ")
          .map((p) => ((PROBLEMS as readonly string[]).includes(p) ? t(`problems.${p as (typeof PROBLEMS)[number]}`) : p))
          .join(", ");
      }
      const text = t(`errors.${error.code}`, params);
      return { ok: false, error: params.step ? t("errors.inStep", { step: params.step, problem: text }) : text, code: error.code };
    }
    if (error instanceof AccessError) return { ok: false, error: t("errors.noAccess"), code: "accessDenied" };
    console.error("[sequence action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

export type DatabaseSequences = { sequences: SequenceView[]; variables: string[] };

/** A database's sequences, and the names its steps' variables may use (its properties'). */
export async function listSequencesAction(databaseId: string): Promise<ActionResult<DatabaseSequences>> {
  return run(async (userId) => {
    const sequences = await listSequences(userId, databaseId);
    // Only owners write sequences: others needn't learn the names of properties hidden from them.
    const { page: database } = await pageAccessOf(userId, databaseId);
    const owner = database ? (await getMembership(userId, database.workspaceId))?.role === "owner" : false;
    return { sequences, variables: owner ? (await getProperties(databaseId)).map((p) => p.name) : [] };
  });
}

export async function createSequenceAction(databaseId: string, input: SequenceInput): Promise<ActionResult<SequenceView>> {
  return run((userId) => createSequence(userId, databaseId, input));
}

export async function updateSequenceAction(sequenceId: string, input: SequenceInput): Promise<ActionResult<SequenceView>> {
  return run((userId) => updateSequence(userId, sequenceId, input));
}

export async function deleteSequenceAction(sequenceId: string): Promise<ActionResult<undefined>> {
  return run(async (userId) => {
    await deleteSequence(userId, sequenceId);
    return undefined;
  });
}

/** Starts a sequence on rows, from the viewer's own mailbox: from the row's page, or a table's selection. */
export async function enrollRowsAction(sequenceId: string, rowIds: string[], source: "row" | "bulk"): Promise<ActionResult<EnrollOutcome[]>> {
  return run(async (userId) => {
    const outcomes = await enrollRows(userId, sequenceId, Array.isArray(rowIds) ? rowIds : [], source === "bulk" ? "bulk" : "row");
    if (!outcomes.length) return outcomes;
    // The reasons rows were skipped, in the viewer's language.
    const t = await getTranslations("database.followUps");
    return outcomes.map((o) => (o.ok ? o : { ...o, error: t(`errors.${o.code}`, { step: 0, name: "", problems: "" }) }));
  });
}

export type RowFollowUps = {
  /** The row's follow-ups, newest first: going on or ended (kept ENROLLMENT_HISTORY_DAYS). */
  enrollments: EnrollmentView[];
  /** The sequences of its database the viewer may start on it (none when they may not write email on it). */
  sequences: { id: string; name: string; steps: number }[];
};

/** The row's follow-ups, and the sequences the viewer may start on it; null when they may not read its email. */
export async function rowFollowUpsAction(rowId: string): Promise<ActionResult<RowFollowUps | null>> {
  return run(async (userId) => {
    const access = await rowMailAccess(userId, rowId);
    if (!access) return null;
    const writes = access.level === "edit" || access.level === "full";
    const [enrollments, sequences] = await Promise.all([
      listEnrollments(userId, { rowId }, { open: false, limit: 20 }),
      writes ? listSequences(userId, access.databaseId) : [],
    ]);
    return { enrollments, sequences: sequences.map((s) => ({ id: s.id, name: s.name, steps: s.steps.length })) };
  });
}

export async function stopEnrollmentAction(enrollmentId: string): Promise<ActionResult<EnrollmentView>> {
  return run((userId) => stopEnrollment(userId, enrollmentId));
}

export async function resumeEnrollmentAction(enrollmentId: string): Promise<ActionResult<EnrollmentView>> {
  return run((userId) => resumeEnrollment(userId, enrollmentId));
}
