import * as z from "zod";
import { pageLabel } from "@/lib/labels";
import { MAX_BULK_ENROLL, type EnrollmentView, type SequenceView } from "@/lib/sequences";
import { SequenceError, type EnrollOutcome } from "@/server/sequences/manage";
import { pageUrl, ToolInputError } from "./format";

/**
 * Follow-up sequences over MCP and the REST API (server/sequences): the tools' inputs, a sequence
 * and an enrollment as they show them (snake_case, with app links), and the errors.
 */

const enrollmentId = z.string().min(1).max(100).describe("The enrollment's id, from list_enrollments or enroll_in_sequence.");

export const sequenceInputs = {
  list: z.object({ database_id: z.string().min(1).describe("The mail database's id (one email lands on, see Settings > General > Email).") }),
  enroll: z.object({
    sequence_id: z.string().min(1).describe("The sequence's id, from list_sequences."),
    row_ids: z.array(z.string().min(1)).min(1).max(MAX_BULK_ENROLL).describe(`The rows to start it on (at most ${MAX_BULK_ENROLL}), rows of the sequence's database.`),
  }),
  stop: z.object({ enrollment_id: enrollmentId }),
  resume: z.object({ enrollment_id: enrollmentId }),
  enrollments: z.object({
    row_id: z.string().min(1).optional().describe("Only this row's."),
    database_id: z.string().min(1).optional().describe("Only this database's."),
    sequence_id: z.string().min(1).optional().describe("Only this sequence's."),
    workspace_id: z.string().min(1).optional().describe("Only this workspace's (one of row_id, database_id, sequence_id or workspace_id is needed)."),
    status: z.enum(["open", "all"]).default("open").describe("open (default): going, waiting for review or paused; all: ended ones still kept too (90 days)."),
    limit: z.number().int().min(1).max(500).default(100).describe("Maximum results (1-500, default 100)."),
  }),
};

export function describeSequence(s: SequenceView) {
  return {
    id: s.id,
    name: s.name,
    database_id: s.databaseId,
    steps: s.steps.map((step, i) => ({
      step: i + 1,
      wait_days: step.days,
      mode: step.mode === "review" ? "ask_first" : "send",
      ...(i === 0 ? { subject: step.subject } : { subject: "Re: (the previous email's subject)" }),
      text: step.text,
    })),
    send_window: { days: s.window.days, start_minute: s.window.start, end_minute: s.window.end },
    open_enrollments: s.open,
    updated_at: s.updatedAt,
    url: pageUrl(s.workspaceId, s.databaseId),
  };
}

export function describeEnrollment(e: EnrollmentView) {
  return {
    id: e.id,
    sequence: e.sequence,
    row: { id: e.row.id, title: pageLabel(e.row.title), url: pageUrl(e.workspaceId, e.row.id) },
    sender: e.sender,
    status: e.status,
    step: e.step,
    steps: e.steps,
    sent: e.sent,
    ...(e.nextAt ? { next_at: e.nextAt } : {}),
    ...(e.pausedUntil ? { paused_until: e.pausedUntil } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.problems?.length ? { problems: e.problems } : {}),
    ...(e.reviewChangeId ? { pending_change_id: e.reviewChangeId } : {}),
    source: e.source,
    started_at: e.startedAt,
    ...(e.endedAt ? { ended_at: e.endedAt } : {}),
    can_stop: e.canStop,
    can_resume: e.canResume,
  };
}

export function describeOutcomes(outcomes: EnrollOutcome[]) {
  return {
    started: outcomes.filter((o) => o.ok).length,
    rows: outcomes.map((o) => (o.ok ? { row_id: o.rowId, enrollment: describeEnrollment(o.enrollment) } : { row_id: o.rowId, skipped: o.code, reason: o.error })),
  };
}

/** The sequences' errors as tool errors, with what to do next. */
export async function withSequenceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SequenceError) throw new ToolInputError(error.message);
    throw error;
  }
}
