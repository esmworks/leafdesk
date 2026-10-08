import { getAuthenticatorName } from "@better-auth/passkey";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { account, passkey, session, user } from "@/db/schema";
import { isStrongSession } from "@/lib/auth-security";

export type PasskeySummary = {
  id: string;
  /** What the user called it, or the authenticator's make when known. */
  name: string | null;
  createdAt: Date | null;
  /** Synced across the user's devices (iCloud Keychain, Google Password Manager, …). */
  backedUp: boolean;
};

export type AccountSecurity = {
  twoFactorEnabled: boolean;
  /** Has an email/password login; without one, confirming asks for a code instead. */
  hasPassword: boolean;
  passkeys: PasskeySummary[];
};

/** What Settings > Account security shows for the signed-in user. */
export async function getAccountSecurity(userId: string): Promise<AccountSecurity> {
  const [[row], [credential], keys] = await Promise.all([
    db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId)).limit(1),
    db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential"), isNotNull(account.password)))
      .limit(1),
    db
      .select({
        id: passkey.id,
        name: passkey.name,
        aaguid: passkey.aaguid,
        createdAt: passkey.createdAt,
        backedUp: passkey.backedUp,
      })
      .from(passkey)
      .where(eq(passkey.userId, userId))
      .orderBy(asc(passkey.createdAt)),
  ]);
  return {
    twoFactorEnabled: row?.twoFactorEnabled === true,
    hasPassword: Boolean(credential),
    passkeys: keys.map(({ aaguid, ...key }) => ({
      ...key,
      name: key.name?.trim() || getAuthenticatorName(aaguid) || null,
    })),
  };
}

/**
 * What the workspace policies look at in the session a collab token was issued to, checked when the
 * websocket connects: whether it passes "require two-step verification" (isStrongSession) and the
 * SSO provider it came through. Null when that session has ended (signed out, revoked, expired or
 * replaced, as turning two-step verification on does) or the account is gone: tokens outlive their
 * session, and the connection is refused; a tab then asks for a token of the session it has now
 * (components/collab/socket). A token that names no session, which only scripts issue, counts by
 * the user alone.
 */
export async function collabSessionFacts(
  sessionId: string | null,
  userId: string,
): Promise<{ strong: boolean; ssoProviderId: string | null } | null> {
  const [[account], [current]] = await Promise.all([
    db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId)).limit(1),
    sessionId
      ? db
          .select({ authMethod: session.authMethod, ssoProviderId: session.ssoProviderId })
          .from(session)
          .where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, new Date())))
          .limit(1)
      : Promise.resolve([]),
  ]);
  if (!account || (sessionId && !current)) return null;
  return {
    strong: isStrongSession({ user: account, session: { authMethod: current?.authMethod ?? null } }),
    ssoProviderId: current?.ssoProviderId ?? null,
  };
}
