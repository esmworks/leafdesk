/**
 * What the dialogs of Zendesk and Salesforce syncs (lib/zendesk-sync, lib/salesforce-sync) have in
 * common.
 */

/** What a sync's dialog on the database shows (never its token). */
export type CrmSyncView = {
  source: "zendesk" | "salesforce";
  siteUrl: string;
  /** Salesforce: the object synced; null for Zendesk. */
  object: string | null;
  /** The sign-in as it can be shown: Zendesk's email address, Salesforce's consumer key; empty for people who can't manage the sync. */
  account: string;
  intervalMinutes: number;
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastCount: number | null;
  lastError: string | null;
  lastErrorDetail: string | null;
  /** Full access to the database: may change it, sync it or stop it. */
  canManage: boolean;
};
