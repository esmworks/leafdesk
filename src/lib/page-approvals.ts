/**
 * Asking people to approve a page (server/page-approvals.ts): the rules that need no database,
 * shared by the server, the request dialog, the banner and the badge. A request names its
 * approvers and whether everyone must approve or any one is enough; it points at the version of
 * the page saved when it was sent, so an approval is of that exact version.
 */

export const APPROVAL_RULES = ["all", "any"] as const;
export type ApprovalRule = (typeof APPROVAL_RULES)[number];

/** A round's state: waiting, or how it ended. */
export type ApprovalStatus = "open" | "approved" | "changes_requested" | "withdrawn";

/** What one approver decided. */
export const APPROVAL_DECISIONS = ["approved", "changes_requested"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const MAX_APPROVERS = 20;
/** The longest note a request carries, and the longest comment on a decision, in characters. */
export const MAX_APPROVAL_NOTE = 1000;
/** How far ahead a due date may be, in days. */
const MAX_DUE_DAYS = 5 * 366;

/** Why a request or a decision was refused; translated in the app (`page.approval.errors`). */
export const APPROVAL_ERROR_CODES = [
  "approvers",
  "rule",
  "due",
  "note",
  "commentNeeded",
  "decision",
  "template",
  "database",
  "inTrash",
  "guest",
  "closed",
  "notApprover",
  "decided",
  "notRequester",
] as const;
export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];

export const isApprovalRule = (value: unknown): value is ApprovalRule => (APPROVAL_RULES as readonly unknown[]).includes(value);
export const isApprovalDecision = (value: unknown): value is ApprovalDecision => (APPROVAL_DECISIONS as readonly unknown[]).includes(value);

/**
 * How a round stands after these decisions (null: not decided yet): anyone asking for changes ends
 * it; otherwise it is approved once everyone approved, or with `any` once one did.
 */
export function roundOutcome(rule: ApprovalRule, decisions: readonly (ApprovalDecision | null)[]): Exclude<ApprovalStatus, "withdrawn"> {
  if (decisions.includes("changes_requested")) return "changes_requested";
  const approved = decisions.filter((d) => d === "approved").length;
  if (approved > 0 && (rule === "any" || approved === decisions.length)) return "approved";
  return "open";
}

/** Whether `value` is a calendar day written YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** Text as stored: trimmed, null when empty; undefined when it isn't text or is too long. */
function noteText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return null;
  return [...text].length > MAX_APPROVAL_NOTE ? undefined : text;
}

export type ApprovalRequestInput = { approverIds: string[]; rule: ApprovalRule; dueDate: string | null; note: string | null };

/**
 * A request as sent, checked: 1 to MAX_APPROVERS distinct approvers (never `requesterId`), a rule
 * (everyone when left out), an optional due day from yesterday on (`today` in UTC, for people a
 * day behind), and an optional note of up to MAX_APPROVAL_NOTE characters. Whether the approvers
 * can open the page is the server's to check.
 */
export function checkApprovalRequest(
  raw: { approverIds?: unknown; rule?: unknown; dueDate?: unknown; note?: unknown },
  requesterId: string,
  today: string,
): { ok: true; value: ApprovalRequestInput } | { ok: false; code: ApprovalErrorCode } {
  if (!Array.isArray(raw.approverIds) || raw.approverIds.some((id) => typeof id !== "string" || !id || id.length > 200)) return { ok: false, code: "approvers" };
  const approverIds = [...new Set(raw.approverIds as string[])];
  if (!approverIds.length || approverIds.length > MAX_APPROVERS || approverIds.includes(requesterId)) return { ok: false, code: "approvers" };
  const rule = raw.rule ?? "all";
  if (!isApprovalRule(rule)) return { ok: false, code: "rule" };
  let dueDate: string | null = null;
  if (raw.dueDate !== null && raw.dueDate !== undefined && raw.dueDate !== "") {
    if (!isDay(raw.dueDate)) return { ok: false, code: "due" };
    const ahead = dayNumber(raw.dueDate) - dayNumber(today);
    if (ahead < -1 || ahead > MAX_DUE_DAYS) return { ok: false, code: "due" };
    dueDate = raw.dueDate;
  }
  const note = noteText(raw.note);
  if (note === undefined) return { ok: false, code: "note" };
  return { ok: true, value: { approverIds, rule, dueDate, note } };
}

/** A decision as sent, checked: asking for changes needs a comment saying what; approving takes one optionally. */
export function checkDecision(
  decision: unknown,
  comment: unknown,
): { ok: true; decision: ApprovalDecision; comment: string | null } | { ok: false; code: ApprovalErrorCode } {
  if (!isApprovalDecision(decision)) return { ok: false, code: "decision" };
  const text = noteText(comment);
  if (text === undefined) return { ok: false, code: "note" };
  if (decision === "changes_requested" && !text) return { ok: false, code: "commentNeeded" };
  return { ok: true, decision, comment: text };
}

/**
 * What the page header shows of a page's approvals: its latest round that wasn't withdrawn
 * (server/page-approvals `approvalHeader`). `changed`: the page's title or body is no longer the
 * version that was sent. `ask`: set while the reader has a decision to make in it.
 */
export type ApprovalHeader = {
  id: string;
  status: Exclude<ApprovalStatus, "withdrawn">;
  rule: ApprovalRule;
  changed: boolean;
  requestedById: string | null;
  requestedBy: string | null;
  requestedAt: string;
  decidedAt: string | null;
  /** Who approved, in the order they did. */
  approvedBy: string[];
  /** How many were asked. */
  total: number;
  ask: { note: string | null; dueDate: string | null; snapshotId: string | null } | null;
};

/** How the badge under the title reads (components/page/approval-badge). */
export type ApprovalBadgeState = "open" | "approved" | "changed" | "changes_requested";

export function badgeState(header: Pick<ApprovalHeader, "status" | "changed">): ApprovalBadgeState {
  if (header.status === "approved") return header.changed ? "changed" : "approved";
  return header.status;
}

/** One round in a page's approval history (server/page-approvals `approvalHistory`), newest first. */
export type ApprovalRound = {
  id: string;
  status: ApprovalStatus;
  rule: ApprovalRule;
  note: string | null;
  dueDate: string | null;
  createdAt: string;
  decidedAt: string | null;
  requestedById: string | null;
  requestedBy: string | null;
  /** The version sent; null once it is gone. */
  snapshotId: string | null;
  decisions: {
    userId: string;
    name: string | null;
    decision: ApprovalDecision | null;
    comment: string | null;
    decidedAt: string | null;
    /** Whether they can still open the page: someone who can't no longer decides. */
    canOpen: boolean;
  }[];
};

/**
 * Whether an open round can no longer end as approved: everyone must approve and someone who
 * hasn't yet can no longer open the page, or any one is enough and none who are left can. It
 * stays open until withdrawn.
 */
export function roundStuck(round: Pick<ApprovalRound, "status" | "rule" | "decisions">): boolean {
  if (round.status !== "open") return false;
  const waiting = round.decisions.filter((d) => d.decision === null);
  return round.rule === "all" ? waiting.some((d) => !d.canOpen) : waiting.length > 0 && waiting.every((d) => !d.canOpen);
}
