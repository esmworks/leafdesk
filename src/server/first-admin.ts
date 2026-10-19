import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { user, verification } from "@/db/schema";
import { isInstanceAdmin, type AdminCandidate } from "@/lib/instance-admin";

/**
 * The first account of a new server is its instance administrator, so whoever installs Leafdesk
 * can manage it (and close sign-up, see the admin page) without editing ADMIN_EMAILS first.
 *
 * Kept as one row in `verification`, keyed by user id (not by address, so it needs no verified
 * email: the first account has none on a server without mail), written once and never moved:
 *
 * - only an account that no other account predates gets it, so a server that already has accounts
 *   never names one, and deleting the first account doesn't hand it to the next;
 * - the check and the write run under one lock, so of two accounts signing up at the same time
 *   exactly one is it, whichever order their sign-ups finish in.
 *
 * ADMIN_EMAILS works as before, next to it.
 */

const MARK = "leafdesk:first-admin";
/** Never expires: Better Auth only clears verification rows that have. */
const NEVER = new Date("9999-12-31T00:00:00Z");

const cache = globalThis as unknown as { __leafdeskFirstAdmin?: { id: string | null; at: number } };
/** How long "no first administrator" is believed before asking the database again. */
const NONE_TTL_MS = 60_000;

/**
 * Makes `userId` the first administrator if the server had no account before it. Called right
 * after an account is created; true when it became the first administrator.
 */
export async function claimFirstAdmin(userId: string): Promise<boolean> {
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${MARK}))`);
    const [taken] = await tx.select({ id: verification.id }).from(verification).where(eq(verification.identifier, MARK)).limit(1);
    if (taken) return false;
    // After hooks run once the sign-up has committed, so the account is there to compare with;
    // if it isn't (deleted meanwhile), nobody is named.
    const [first] = await tx.execute<{ first: boolean }>(sql`
      select not exists (
        select 1 from ${user} other
        where other.id <> me.id and (other.created_at, other.id) < (me.created_at, me.id)
      ) as first
      from ${user} me where me.id = ${userId}`);
    if (!first?.first) return false;
    await tx.insert(verification).values({ id: crypto.randomUUID(), identifier: MARK, value: userId, expiresAt: NEVER });
    return true;
  });
  if (claimed) cache.__leafdeskFirstAdmin = { id: userId, at: Date.now() };
  return claimed;
}

/** The first administrator's user id, or null on a server that had accounts before it had this rule. */
export async function firstAdminId(): Promise<string | null> {
  const known = cache.__leafdeskFirstAdmin;
  if (known && (known.id || Date.now() - known.at < NONE_TTL_MS)) return known.id;
  const [row] = await db.select({ value: verification.value }).from(verification).where(eq(verification.identifier, MARK)).limit(1);
  const id = row?.value ?? null;
  cache.__leafdeskFirstAdmin = { id, at: Date.now() };
  return id;
}

/** Whether this account is an instance administrator: ADMIN_EMAILS (verified) or the first account. */
export async function instanceAdmin(candidate: AdminCandidate): Promise<boolean> {
  if (!candidate) return false;
  return isInstanceAdmin(candidate, undefined, await firstAdminId());
}
