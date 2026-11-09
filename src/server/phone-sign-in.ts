import { createHash, randomBytes } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, eq, gt, inArray, lt, or } from "drizzle-orm";
import * as z from "zod";
import { db } from "@/db";
import { phoneSignIn, user, workspace } from "@/db/schema";
import { env } from "@/lib/env";
import { isPhoneToken, PHONE_SIGN_IN_ENDPOINT, PHONE_SIGN_IN_SECONDS, phoneSignInUrl } from "@/lib/phone-sign-in";
import { memberWorkspaceIds, policyHold, policyStateOf } from "@/server/access";
import { recordAudit } from "@/server/audit";

/**
 * "Sign in on your phone" (account page, Security): a link shown as a QR code that signs the
 * phone's browser in as the person who showed it. It lasts PHONE_SIGN_IN_SECONDS and works once:
 * only the token's SHA-256 is stored, and the row is deleted as the link is used. Showing a new
 * code replaces the one before, and the account page asks for the same proof as other sensitive
 * changes first (server/account.ts `startPhoneSignIn`).
 *
 * The phone's session is a new sign-in, never a copy of the computer's: it records no single
 * sign-on, so "SSO only" would hold it back, and with two-step verification on the phone asks for
 * the code (the two-factor plugin's challenge covers the endpoint, lib/auth-security.ts). People a
 * workspace would hold back that way get no code at all, with the reason (`phoneSignInRefusal`).
 * Approved networks are checked on the phone's own requests, as after any sign-in.
 */

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export type PhoneSignInRefusal = { hold: "sso" | "two-factor"; workspaces: string[] };

/**
 * The workspaces whose sign-in policies would hold back the phone's session, by the policy: "SSO
 * only" first (nothing on the account page meets it), then two-step verification (turning it on
 * does). Null when none would.
 */
export async function phoneSignInRefusal(userId: string): Promise<PhoneSignInRefusal | null> {
  const [person] = await db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId)).limit(1);
  if (!person) return null;
  // What the phone's session will have: two-step if the account has it (the phone enters a code),
  // no single sign-on. Its address is checked on each of its requests, so it doesn't count here.
  const facts = { strong: person.twoFactorEnabled === true, ssoProviderId: null, ip: null };
  const held: Record<PhoneSignInRefusal["hold"], string[]> = { sso: [], "two-factor": [] };
  for (const workspaceId of await memberWorkspaceIds(userId)) {
    const state = await policyStateOf(userId, workspaceId);
    if (!state) continue;
    const hold = policyHold({ ...state, allowedNetworks: [] }, facts, workspaceId);
    if (hold === "sso" || hold === "two-factor") held[hold].push(workspaceId);
  }
  const kind = held.sso.length ? "sso" : held["two-factor"].length ? "two-factor" : null;
  if (!kind) return null;
  const rows = await db.select({ name: workspace.name }).from(workspace).where(inArray(workspace.id, held[kind]));
  return { hold: kind, workspaces: rows.map((row) => row.name).sort() };
}

/** A new code for `userId`, replacing any shown before; expired codes of everyone go too. */
export async function issuePhoneSignIn(userId: string): Promise<{ url: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + PHONE_SIGN_IN_SECONDS * 1000);
  await db.transaction(async (tx) => {
    await tx.delete(phoneSignIn).where(or(eq(phoneSignIn.userId, userId), lt(phoneSignIn.expiresAt, new Date(now))));
    await tx.insert(phoneSignIn).values({ tokenHash: hashOf(token), userId, expiresAt });
  });
  return { url: phoneSignInUrl(env.appUrl, token), expiresAt: expiresAt.toISOString() };
}

/** Whose code this is, for the phone's page to name before anything happens; null once it's used or expired. */
export async function findPhoneSignIn(token: string): Promise<{ name: string; email: string } | null> {
  if (env.localMode || !isPhoneToken(token)) return null;
  const [row] = await db
    .select({ name: user.name, email: user.email })
    .from(phoneSignIn)
    .innerJoin(user, eq(user.id, phoneSignIn.userId))
    .where(and(eq(phoneSignIn.tokenHash, hashOf(token)), gt(phoneSignIn.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

/** Uses the code up: one statement deletes it, so two phones racing get it once. Its user, while it was valid. */
async function claimPhoneSignIn(token: string): Promise<string | null> {
  if (!isPhoneToken(token)) return null;
  const [row] = await db
    .delete(phoneSignIn)
    .where(eq(phoneSignIn.tokenHash, hashOf(token)))
    .returning({ userId: phoneSignIn.userId, expiresAt: phoneSignIn.expiresAt });
  return row && row.expiresAt > new Date() ? row.userId : null;
}

/** Each of the person's workspaces records the sign-in, as connected apps are (they reach them all). */
async function recordPhoneSignIn(userId: string) {
  const workspaceIds = await memberWorkspaceIds(userId);
  await recordAudit(
    workspaceIds.map((workspaceId) => ({
      workspaceId,
      actorId: userId,
      action: "account.phone_signed_in" as const,
      target: { type: "user" as const, id: userId },
    })),
  );
}

const refused = (code: string, message: string, status: "BAD_REQUEST" | "FORBIDDEN" = "BAD_REQUEST") => APIError.from(status, { code, message });

/**
 * The endpoint the phone's page posts the code to. It goes through Better Auth's own session
 * creation, so every `session.create` hook runs (agents' users never sign in, the sign-in is
 * recorded as "phone") and the cookie is Better Auth's.
 */
export function phoneSignInPlugin() {
  return {
    id: "leafdesk-phone-sign-in",
    endpoints: {
      phoneSignIn: createAuthEndpoint(
        PHONE_SIGN_IN_ENDPOINT,
        { method: "POST", body: z.object({ token: z.string().max(128) }) },
        async (ctx) => {
          // On one computer there is no phone that could reach the server.
          if (env.localMode) throw refused("PHONE_LINK_INVALID", "This sign-in link doesn't work here");
          const userId = await claimPhoneSignIn(ctx.body.token);
          const found = userId ? await ctx.context.internalAdapter.findUserById(userId) : null;
          // An account that has to choose a new password signs in only once it has.
          if (!found || (found as { passwordResetRequired?: boolean | null }).passwordResetRequired) {
            throw refused("PHONE_LINK_INVALID", "This sign-in link has expired or was used already");
          }
          // The policies may have changed since the code was shown.
          const refusal = await phoneSignInRefusal(found.id);
          if (refusal) {
            throw refused(
              refusal.hold === "sso" ? "PHONE_LINK_SSO" : "PHONE_LINK_TWO_FACTOR",
              refusal.hold === "sso" ? "Single sign-on required" : "Two-step verification required",
              "FORBIDDEN",
            );
          }
          const session = await ctx.context.internalAdapter.createSession(found.id);
          if (!session) throw refused("PHONE_LINK_INVALID", "Could not sign in");
          await setSessionCookie(ctx, { session, user: found });
          await recordPhoneSignIn(found.id);
          return ctx.json({ ok: true });
        },
      ),
    },
    rateLimit: [{ pathMatcher: (path: string) => path === PHONE_SIGN_IN_ENDPOINT, window: 60, max: 10 }],
  } satisfies BetterAuthPlugin;
}
