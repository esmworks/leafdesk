import { and, asc, eq, gt, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { account, session, user } from "@/db/schema";
import { isInstanceAdmin } from "@/lib/instance-admin";
import { notAgentUser } from "@/server/agents/users";
import { getCollab } from "@/server/collab/bridge";
import { workspaceCounts } from "@/server/workspaces";

/**
 * What an instance administrator (ADMIN_EMAILS, see lib/instance-admin.ts) does on /admin: look
 * up the server's accounts, sign one or everyone out, and make one or everyone with a password
 * choose a new one at their next sign-in (see server/required-password.ts).
 *
 * Every function checks the caller itself, so a server action can't skip it. Signing out ends
 * browser sessions and their live collaboration connections; apps connected over MCP and REST
 * API tokens are grants of their own and keep working until they are revoked.
 */

export type AdminErrorCode = "notFound" | "noPassword" | "self";

export class AdminError extends Error {
  constructor(readonly code: AdminErrorCode) {
    super(code);
    this.name = "AdminError";
  }
}

/** The request's session, as Better Auth returns it. */
export type AdminSession = {
  user: { id: string; email: string; emailVerified?: boolean | null };
  session: { id: string };
};

/** Anyone but an instance admin gets "not found", as if there were nothing here. */
function assertAdmin(current: AdminSession | null | undefined): asserts current is AdminSession {
  if (!current || !isInstanceAdmin(current.user)) throw new AdminError("notFound");
}

export function checkInstanceAdmin(current: AdminSession | null | undefined): current is AdminSession {
  return !!current && isInstanceAdmin(current.user);
}

export type InstanceUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
  createdAt: Date;
  /** Workspaces they are in, as a guest too. */
  workspaces: number;
  /** Sessions that haven't ended. */
  sessions: number;
  /** Their most recent activity in any live session (refreshed about once a day of use). */
  lastActiveAt: Date | null;
  twoFactorEnabled: boolean;
  hasPassword: boolean;
  passwordResetRequired: boolean;
  isAdmin: boolean;
};

/** How many accounts one page of the list shows; a search narrows it down. */
export const USER_LIST_LIMIT = 200;

const likeEscape = (text: string) => text.replace(/[\\%_]/g, "\\$&");

/** Accounts whose name or email contains `query` (all of them without one), by name. */
export async function listInstanceUsers(
  current: AdminSession | null | undefined,
  query = "",
): Promise<{ users: InstanceUser[]; total: number }> {
  assertAdmin(current);
  const q = query.trim().slice(0, 200);
  // Agents' users are no accounts anyone signs in to: they are managed in their workspaces.
  const where = and(
    notAgentUser(user.id),
    q ? or(ilike(user.name, `%${likeEscape(q)}%`), ilike(user.email, `%${likeEscape(q)}%`)) : undefined,
  );
  // Subqueries name the outer row explicitly: inside them a bare "id" would be their own table's.
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        twoFactorEnabled: user.twoFactorEnabled,
        passwordResetRequired: user.passwordResetRequired,
        sessions: sql<number>`(select count(*) from ${session} s where s.user_id = "user"."id" and s.expires_at > now())::int`,
        lastActiveAt: sql<Date | null>`(select max(coalesce(s.updated_at, s.created_at)) from ${session} s where s.user_id = "user"."id" and s.expires_at > now())`,
        hasPassword: sql<boolean>`exists (select 1 from ${account} a where a.user_id = "user"."id" and a.provider_id = 'credential' and a.password is not null)`,
      })
      .from(user)
      .where(where)
      .orderBy(asc(sql`lower(${user.name})`), asc(user.email))
      .limit(USER_LIST_LIMIT),
    db.select({ total: sql<number>`count(*)::int` }).from(user).where(where),
  ]);
  const workspaces = await workspaceCounts(rows.map((row) => row.id));
  return {
    total,
    users: rows.map((row) => ({
      ...row,
      workspaces: workspaces.get(row.id) ?? 0,
      // Raw subqueries come back as strings from the driver.
      lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt) : null,
      twoFactorEnabled: row.twoFactorEnabled === true,
      passwordResetRequired: row.passwordResetRequired === true,
      isAdmin: isInstanceAdmin(row),
    })),
  };
}

/** Drops the live collaboration connections of these users' ended sessions (all of them unless kept). */
async function disconnect(userIds: Iterable<string>, current: AdminSession) {
  try {
    const collab = getCollab();
    for (const id of new Set(userIds)) await collab.disconnectSessions(id, id === current.user.id ? [current.session.id] : []);
  } catch (error) {
    // Scripts and tests run without the collab server; its connections end with their tokens.
    console.warn("[admin] could not close collab connections", error);
  }
}

async function targetOf(userId: string) {
  const [target] = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.id, typeof userId === "string" ? userId : ""))
    .limit(1);
  if (!target) throw new AdminError("notFound");
  return target;
}

/** Signs one account out on every device. For the admin's own account, this browser stays signed in. */
export async function signOutUser(current: AdminSession | null | undefined, userId: string) {
  assertAdmin(current);
  const target = await targetOf(userId);
  const own = target.id === current.user.id;
  const gone = await db
    .delete(session)
    .where(and(eq(session.userId, target.id), own ? ne(session.id, current.session.id) : undefined))
    .returning({ id: session.id });
  await disconnect([target.id], current);
  console.info(`[admin] ${current.user.email} signed out ${target.email} (${gone.length} sessions)`);
  return { sessions: gone.length };
}

/** Signs every account out on every device, except the admin in this browser. */
export async function signOutEveryone(current: AdminSession | null | undefined) {
  assertAdmin(current);
  const gone = await db.delete(session).where(ne(session.id, current.session.id)).returning({ userId: session.userId });
  const users = new Set(gone.map((s) => s.userId));
  await disconnect(users, current);
  console.info(`[admin] ${current.user.email} signed out everyone (${gone.length} sessions of ${users.size} accounts)`);
  return { sessions: gone.length, users: users.size };
}

/**
 * Makes one account choose a new password at its next password sign-in, and signs it out now.
 * Refused for accounts without a password (they sign in some other way, which stays as it is),
 * and for the admin's own (they change theirs on the account page).
 */
export async function requirePasswordReset(current: AdminSession | null | undefined, userId: string) {
  assertAdmin(current);
  const target = await targetOf(userId);
  if (target.id === current.user.id) throw new AdminError("self");
  const flagged = await db
    .update(user)
    .set({ passwordResetRequired: true })
    .where(and(eq(user.id, target.id), sql`exists (${withPassword(user.id)})`))
    .returning({ id: user.id });
  if (!flagged.length) throw new AdminError("noPassword");
  await db.delete(session).where(eq(session.userId, target.id));
  await disconnect([target.id], current);
  console.info(`[admin] ${current.user.email} required a new password of ${target.email}`);
}

/** The same for every account with a password but the admin's own. Returns how many there were. */
export async function requirePasswordResetForEveryone(current: AdminSession | null | undefined) {
  assertAdmin(current);
  const flagged = await db
    .update(user)
    .set({ passwordResetRequired: true })
    .where(and(ne(user.id, current.user.id), sql`exists (${withPassword(user.id)})`))
    .returning({ id: user.id });
  const ids = flagged.map((u) => u.id);
  // In slices: a statement takes at most 65535 parameters.
  for (let i = 0; i < ids.length; i += 5000) await db.delete(session).where(inArray(session.userId, ids.slice(i, i + 5000)));
  await disconnect(ids, current);
  console.info(`[admin] ${current.user.email} required a new password of everyone with one (${ids.length} accounts)`);
  return { users: ids.length };
}

/** The account's email/password login, if it has one. */
function withPassword(userId: typeof user.id) {
  return db
    .select({ one: sql`1` })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential"), isNotNull(account.password)));
}

/** Live sessions on the whole server, for the admin page. */
export async function countLiveSessions(current: AdminSession | null | undefined) {
  assertAdmin(current);
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(session)
    .where(gt(session.expiresAt, new Date()));
  return total;
}
