import { createHash, randomBytes } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, desc, eq, gt, like } from "drizzle-orm";
import { db } from "@/db";
import { account, user, verification } from "@/db/schema";
import { requestLocale } from "@/i18n/config";
import { env } from "@/lib/env";
import { mailStatus, PASSWORD_RESET_MINUTES, passwordResetRequiredEmail, sendMail } from "@/server/mail";
import { recipientLocale } from "@/server/mail/locale";
import { forgetUnprovenHolder } from "@/server/account-security";
import { revokeAllConnectedApps } from "@/server/mcp/grants";

/**
 * "Require a password reset at next sign-in" (set by an instance admin, see
 * server/instance-admin.ts): `user.password_reset_required`. The flag only concerns the password,
 * so signing in with a passkey, GitHub, Google or single sign-on works as before, and accounts
 * without a password are never flagged.
 *
 * The next password sign-in gets no session. The password was right, so instead:
 * - with SMTP set up, the reset link goes to the account's address (the same link as "Forgot
 *   password"), since whoever asked for the reset may suspect the password is known to others;
 *   that proves the mailbox, and the address counts as verified afterwards;
 * - without SMTP (nothing could reach the mailbox), the sign-in page asks for a new password
 *   right there, holding a short-lived token from this answer, plus a two-step code when the
 *   account has two-step verification, so the old password alone can't take the account over.
 *
 * Changing the password in any way (the reset link, that step, or on the account page from a
 * session signed in some other way) clears the flag.
 */

export const PASSWORD_RESET_REQUIRED = "PASSWORD_RESET_REQUIRED";
/** The code `/reset-password` answers when the new password is the one that had to go. */
export const PASSWORD_UNCHANGED = "PASSWORD_UNCHANGED";

/** How long the in-app step may take: long enough to pick a password, not to put it off. */
export const RESET_STEP_MINUTES = 15;
/** A sign-in within this long of the last reset email doesn't send another. */
const RESEND_AFTER_MINUTES = 5;

/** Verification rows of the in-app step: the token's hash, holding the user id. */
const STEP = "required-password:";
/** Better Auth's own reset tokens: `reset-password:<token>`, holding the user id. */
const RESET = "reset-password:";

const hashOf = (token: string) => createHash("sha256").update(token).digest("base64url");

/** What the refused sign-in answers (403), for the sign-in page. */
export type RequiredResetAnswer =
  | { code: typeof PASSWORD_RESET_REQUIRED; message: string; delivery: "email" }
  | {
      code: typeof PASSWORD_RESET_REQUIRED;
      message: string;
      delivery: "in-app";
      /** For finishRequiredPasswordReset (server/account.ts); valid RESET_STEP_MINUTES. */
      resetToken: string;
      /** The step also asks for a two-step code (or recovery code). */
      twoFactor: boolean;
    };

type HookContext = { path?: string; request?: Request; context?: { baseURL?: string } } | null | undefined;

/**
 * `databaseHooks.session.create.before`: refuses the session of a password sign-in while the
 * account has to choose a new password (see the file comment). Runs before the two-step
 * challenge takes over the sign-in, so the code is asked for in the step, not before it.
 */
export async function holdRequiredPasswordReset(data: Record<string, unknown>, ctx: HookContext) {
  if (ctx?.path !== "/sign-in/email" || typeof data.userId !== "string") return;
  const userId = data.userId;
  const [row] = await db
    .select({
      required: user.passwordResetRequired,
      name: user.name,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row?.required) return;
  const message = "Choose a new password before signing in";
  if (mailStatus() === "smtp") {
    await emailResetLink(userId, row, ctx);
    throw new APIError("FORBIDDEN", { code: PASSWORD_RESET_REQUIRED, message, delivery: "email" } satisfies RequiredResetAnswer);
  }
  const resetToken = await startResetStep(userId);
  throw new APIError("FORBIDDEN", {
    code: PASSWORD_RESET_REQUIRED,
    message,
    delivery: "in-app",
    resetToken,
    twoFactor: row.twoFactorEnabled === true,
  } satisfies RequiredResetAnswer);
}

/**
 * Emails a Better Auth reset link, unless one went out moments ago (every sign-in attempt with
 * the right password would send another). Not awaited, like "Forgot password".
 */
async function emailResetLink(userId: string, to: { name: string; email: string }, ctx: HookContext) {
  const [recent] = await db
    .select({ createdAt: verification.createdAt })
    .from(verification)
    .where(and(like(verification.identifier, `${RESET}%`), eq(verification.value, userId), gt(verification.expiresAt, new Date())))
    .orderBy(desc(verification.createdAt))
    .limit(1);
  if (recent && Date.now() - recent.createdAt.getTime() < RESEND_AFTER_MINUTES * 60_000) return;
  const token = randomBytes(18).toString("base64url");
  await db.insert(verification).values({
    id: randomBytes(16).toString("hex"),
    identifier: RESET + token,
    value: userId,
    expiresAt: new Date(Date.now() + PASSWORD_RESET_MINUTES * 60_000),
  });
  // Better Auth checks the token there and continues to /reset-password?token=, as for "Forgot password".
  const base = ctx?.context?.baseURL ?? `${env.appUrl}/api/auth`;
  const url = `${base}/reset-password/${token}?callbackURL=${encodeURIComponent("/reset-password")}`;
  const locale = await recipientLocale(userId, ctx?.request ? requestLocale(ctx.request.headers) : null);
  void sendMail({ to: to.email, ...passwordResetRequiredEmail(locale, { name: to.name, url }) }).catch((error) =>
    console.error("could not send required password reset email", error),
  );
}

/** A token for the in-app step; an earlier one of the same account stops working. */
async function startResetStep(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.delete(verification).where(and(like(verification.identifier, `${STEP}%`), eq(verification.value, userId)));
    await tx.insert(verification).values({
      id: randomBytes(16).toString("hex"),
      identifier: STEP + hashOf(token),
      value: userId,
      expiresAt: new Date(Date.now() + RESET_STEP_MINUTES * 60_000),
    });
  });
  return token;
}

/** The account an in-app step's token belongs to while it works (and its account still has to reset). */
export async function resetStepUser(token: string): Promise<string | null> {
  if (!token || token.length > 128) return null;
  const [row] = await db
    .select({ userId: user.id })
    .from(verification)
    .innerJoin(user, eq(user.id, verification.value))
    .where(
      and(
        eq(verification.identifier, STEP + hashOf(token)),
        gt(verification.expiresAt, new Date()),
        eq(user.passwordResetRequired, true),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/** Uses the token up; false when someone else did first. */
export async function consumeResetStep(token: string) {
  const gone = await db
    .delete(verification)
    .where(and(eq(verification.identifier, STEP + hashOf(token)), gt(verification.expiresAt, new Date())))
    .returning({ id: verification.id });
  return gone.length > 0;
}

/** The password changed: the account no longer has to reset it, and open steps stop working. */
export async function clearPasswordResetRequirement(userId: string) {
  await db.update(user).set({ passwordResetRequired: false }).where(and(eq(user.id, userId), eq(user.passwordResetRequired, true)));
  await db.delete(verification).where(and(like(verification.identifier, `${STEP}%`), eq(verification.value, userId)));
}

/**
 * `emailAndPassword.onPasswordReset`: a reset link was used. It went to the account's address,
 * which is proven now (instance admins count only with a verified address, see lib/instance-admin.ts).
 * An address proven only now may have been signed up with by someone else: the account is the
 * owner's from here on, without what that person set up (forgetUnprovenHolder; the reset signs
 * every session out). Either way the apps the user connected are cut off like those sessions:
 * whoever knew the old password could have connected one.
 */
export async function afterPasswordReset(userId: string) {
  await clearPasswordResetRequirement(userId);
  const proven = await db
    .update(user)
    .set({ emailVerified: true })
    .where(and(eq(user.id, userId), eq(user.emailVerified, false)))
    .returning({ id: user.id });
  if (proven.length) await forgetUnprovenHolder(userId);
  else await revokeAllConnectedApps(userId);
}

/**
 * Refuses a reset link that would set the very password the account was asked to replace. Only
 * for flagged accounts: anyone else may "reset" to their current password.
 */
export function requiredPasswordPlugin() {
  return {
    id: "leafdesk-required-password",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/reset-password",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { token?: unknown; newPassword?: unknown };
            const token = typeof body.token === "string" ? body.token : (ctx.query as { token?: unknown } | undefined)?.token;
            if (typeof token !== "string" || !token || typeof body.newPassword !== "string") return;
            const [row] = await db
              .select({ hash: account.password })
              .from(verification)
              .innerJoin(user, eq(user.id, verification.value))
              .innerJoin(account, and(eq(account.userId, user.id), eq(account.providerId, "credential")))
              .where(and(eq(verification.identifier, RESET + token), eq(user.passwordResetRequired, true)))
              .limit(1);
            if (!row?.hash) return;
            if (await ctx.context.password.verify({ hash: row.hash, password: body.newPassword })) {
              throw APIError.from("BAD_REQUEST", { code: PASSWORD_UNCHANGED, message: "Choose a different password" });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
