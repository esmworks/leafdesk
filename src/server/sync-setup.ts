import { sharedLimiter, takeAll } from "@/lib/rate-limit";

/**
 * Setting a synced database up, or checking its sign-in, makes this server reach out to another
 * (Jira, GitHub, a calendar's address, a PostgreSQL server) on someone's behalf: each person gets a
 * budget, enough to set syncs up and fix a typo or two, not to probe addresses with the server.
 */
export const SYNC_SETUPS_PER_MINUTE = 10;
export const SYNC_SETUPS_PER_HOUR = 60;

export class SyncSetupLimited extends Error {}

/** Takes one of `userId`'s sync setups, or throws SyncSetupLimited. */
export function takeSyncSetup(userId: string, now = Date.now()) {
  const perMinute = sharedLimiter("syncSetup:minute", SYNC_SETUPS_PER_MINUTE, 60_000);
  const perHour = sharedLimiter("syncSetup:hour", SYNC_SETUPS_PER_HOUR, 60 * 60_000);
  if (
    takeAll(
      [
        [perMinute, userId],
        [perHour, userId],
      ],
      now,
    ) > 0
  ) {
    throw new SyncSetupLimited("Too many sync setups");
  }
}
