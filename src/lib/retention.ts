/**
 * How long deleted pages, page history and audit log events are kept (see server/retention.ts,
 * which applies it once a day). Shared with the client so the trash can say when each page goes
 * and the settings can describe the rules.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The choices for a workspace's `trashRetentionDays`; 0 keeps trashed pages until someone deletes
 * them. A fixed list rather than any number, so the setting can't be a typo away from emptying the
 * trash the next morning.
 */
export const TRASH_RETENTION_CHOICES = [0, 7, 14, 30, 60, 90, 180, 365] as const;

/** When a page trashed at `archivedAt` is deleted for good; null when the workspace keeps it. */
export function trashDeletionDate(archivedAt: Date, retentionDays: number): Date | null {
  if (!(retentionDays > 0)) return null;
  return new Date(archivedAt.getTime() + retentionDays * DAY_MS);
}

/**
 * Whole days until `deletesAt`, rounded up so a page trashed a moment ago under a 30-day setting
 * still shows 30. Zero once it is due: the daily cleanup takes it on its next run.
 */
export function daysUntil(deletesAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((deletesAt.getTime() - now.getTime()) / DAY_MS));
}

/**
 * Page history. Versions saved along the way (every few minutes of editing, before an app or the
 * AI assistant writes) go after `maxAgeDays`, and past the newest `maxPerPage` of them. Versions
 * someone chose to keep (`manual`) and the page as it was before a restore (`before_restore`, the
 * way back from a mistaken restore) stay for `keptAgeDays` and don't count toward the limit. Named
 * versions (lib/page-versions), of any kind, stay as long as their page. The newest version of a
 * page is always kept, so a page nobody edited for months still has one.
 */
export const HISTORY_RETENTION = {
  maxAgeDays: 90,
  maxPerPage: 200,
  keptAgeDays: 365,
  keptReasons: ["before_restore", "manual"],
} as const;

/** Versions saved before these times are due: kept kinds before `kept`, the rest before `regular`. */
export function historyCutoffs(now: Date): { regular: Date; kept: Date } {
  return {
    regular: new Date(now.getTime() - HISTORY_RETENTION.maxAgeDays * DAY_MS),
    kept: new Date(now.getTime() - HISTORY_RETENTION.keptAgeDays * DAY_MS),
  };
}

/**
 * How long the audit log (Settings > Audit log) keeps an event: a year, long enough to look back
 * over a yearly access review. Not a setting, so no owner can shorten the trail of what they did.
 */
export const AUDIT_RETENTION_DAYS = 365;

/** Events recorded before this time are due. */
export function auditCutoff(now: Date): Date {
  return new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS);
}

/**
 * Whether this server runs the daily cleanup: `RETENTION_JOB=on` or `off` decides; unset, only a
 * production server does, so a dev server never deletes data it wasn't asked to.
 */
export function retentionJobEnabled(setting: string | undefined, dev: boolean) {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return !dev;
}
