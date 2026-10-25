/**
 * Reports visitors make about a published page (server/page-reports.ts): why, from this list, and
 * what they add. Pure, shared by the report form on published pages and the owners' list.
 */

export const REPORT_REASONS = ["spam", "harmful", "illegal", "privacy", "copyright", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const isReportReason = (value: unknown): value is ReportReason => (REPORT_REASONS as readonly unknown[]).includes(value);

/** Longest details and email address a report keeps. */
export const MAX_REPORT_DETAILS = 2000;
export const MAX_REPORT_EMAIL = 254;

export const REPORT_STATUSES = ["open", "dismissed", "unpublished"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
