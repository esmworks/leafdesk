import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNotNull, like, ne, or } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { db } from "@/db";
import { account, session, twoFactor, user, verification } from "@/db/schema";
import {
  type AccountErrorCode,
  cleanName,
  confirmsDeletion,
  type DeletionPlan,
  EMAIL_CHANGE_HOURS,
  FRESH_SIGN_IN_MINUTES,
  passwordProblem,
  type Proof,
} from "@/lib/account";
import { auth } from "@/lib/auth";
import {
  AVATAR_TYPES,
  avatarName,
  avatarStorageKey,
  avatarUrl,
  MAX_AVATAR_BYTES,
  parseAvatarUrl,
  sniffImage,
} from "@/lib/avatar";
import { isAgentEmail } from "@/lib/agents";
import { isEmail, normalizeEmail } from "@/lib/emails";
import { env } from "@/lib/env";
import { sharedLimiter, takeAll } from "@/lib/rate-limit";
import { verifyTotp } from "@/lib/totp";
import { getCollab } from "@/server/collab/bridge";
import { removeStored } from "@/server/files";
import { applyDomainPolicies } from "@/server/join-requests";
import { emailChangedEmail, emailChangeEmail, mailStatus, passwordChangedEmail, sendMail } from "@/server/mail";
import { recipientLocale, requestLocale } from "@/server/mail/locale";
import { clearPasswordResetRequirement, consumeResetStep, resetStepUser } from "@/server/required-password";
import { getStorage } from "@/server/storage";
import { accountDeletionPlan, withdrawFromWorkspaces } from "@/server/workspaces";

/**
 * The signed-in person's own account (the account page, /account): profile, password, email,
 * sessions and deleting the account.
 *
 * Sensitive changes (email, password, deletion) ask for proof first (`reauthenticate`): the
 * current password; for accounts without one (GitHub or Google only) a code from the
 * authenticator app or a recovery code, which is used up; and for accounts with neither, a sign-in
 * within the last few minutes. Attempts are rate limited per account.
 */

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    /** For `soleOwner`: the workspaces to hand over first. */
    readonly workspaces: string[] = [],
  ) {
    super(code);
    this.name = "AccountError";
  }
}

/** The request's session, as Better Auth returns it. */
export type AccountSession = {
  user: { id: string; name: string; email: string };
  session: { id: string; createdAt: Date | string };
};

const LIMITS = {
  /** Password or code checks, and so every sensitive change. */
  proof: [10, 15 * 60_000],
  /** Confirmation emails to new addresses. */
  email: [5, 60 * 60_000],
  avatar: [20, 60 * 60_000],
  profile: [30, 60 * 60_000],
  sessions: [30, 60_000],
} as const;

function limit(kind: keyof typeof LIMITS, userId: string) {
  const [count, windowMs] = LIMITS[kind];
  if (takeAll([[sharedLimiter(`account:${kind}`, count, windowMs), userId]]) > 0) throw new AccountError("rateLimited");
}

async function passwordHashOf(userId: string) {
  const [row] = await db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential"), isNotNull(account.password)))
    .limit(1);
  return row?.password ?? null;
}

async function twoFactorOf(userId: string) {
  const [row] = await db
    .select({ enabled: user.twoFactorEnabled, id: twoFactor.id, secret: twoFactor.secret, backupCodes: twoFactor.backupCodes })
    .from(user)
    .leftJoin(twoFactor, eq(twoFactor.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  return row?.enabled && row.id && row.secret && row.backupCodes
    ? { id: row.id, secret: row.secret, backupCodes: row.backupCodes }
    : null;
}

/**
 * Whether `code` is the current code of the authenticator app, or an unused recovery code, which
 * is then crossed off (only if nobody used it meanwhile).
 */
async function consumeCode(code: string, row: { id: string; secret: string; backupCodes: string }) {
  const { secretConfig: key } = await auth.$context;
  const clean = code.trim();
  const secret = await symmetricDecrypt({ key, data: row.secret });
  if (verifyTotp(Buffer.from(secret, "utf8"), clean.replace(/\s+/g, ""))) return true;
  let codes: unknown;
  try {
    codes = JSON.parse(await symmetricDecrypt({ key, data: row.backupCodes }));
  } catch {
    return false;
  }
  if (!Array.isArray(codes) || !codes.includes(clean)) return false;
  const rest = await symmetricEncrypt({ key, data: JSON.stringify(codes.filter((c) => c !== clean)) });
  const used = await db
    .update(twoFactor)
    .set({ backupCodes: rest })
    .where(and(eq(twoFactor.id, row.id), eq(twoFactor.backupCodes, row.backupCodes)))
    .returning({ id: twoFactor.id });
  return used.length > 0;
}

/** Throws AccountError unless `proof` confirms it's the account's owner (see the file comment). */
export async function reauthenticate(current: AccountSession, proof: Proof) {
  const userId = current.user.id;
  limit("proof", userId);
  const hash = await passwordHashOf(userId);
  if (hash) {
    if (typeof proof.password !== "string" || !proof.password) throw new AccountError("proofRequired");
    const { password } = await auth.$context;
    if (!(await password.verify({ hash, password: proof.password }))) throw new AccountError("wrongPassword");
    return;
  }
  const codes = await twoFactorOf(userId);
  if (codes) {
    if (typeof proof.code !== "string" || !proof.code.trim()) throw new AccountError("proofRequired");
    if (!(await consumeCode(proof.code, codes))) throw new AccountError("invalidCode");
    return;
  }
  const signedInAt = new Date(current.session.createdAt).getTime();
  if (!(Date.now() - signedInAt < FRESH_SIGN_IN_MINUTES * 60_000)) throw new AccountError("signInAgain");
}

export type SessionSummary = {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  signedInAt: Date;
  /** When the session was last refreshed (Better Auth does it about once a day of use). */
  lastActiveAt: Date;
  authMethod: string | null;
};

export type AccountOverview = {
  name: string;
  email: string;
  image: string | null;
  /** Proven to be theirs (a verification link, or a provider that vouches for it). */
  emailVerified: boolean;
  hasPassword: boolean;
  twoFactorEnabled: boolean;
  /** Linked sign-in providers other than email and password ("github", "google"). */
  providers: string[];
  /** A new address waiting for its confirmation link, if any. */
  pendingEmail: string | null;
  sessions: SessionSummary[];
};

export async function getAccountOverview(current: AccountSession): Promise<AccountOverview> {
  const userId = current.user.id;
  const [[row], accounts, sessions, pending] = await Promise.all([
    db
      .select({
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        twoFactorEnabled: user.twoFactorEnabled,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
    db.select({ providerId: account.providerId, password: account.password }).from(account).where(eq(account.userId, userId)),
    db
      .select({
        id: session.id,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        authMethod: session.authMethod,
      })
      .from(session)
      .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
      .orderBy(desc(session.updatedAt)),
    pendingEmailChange(userId),
  ]);
  if (!row) throw new AccountError("sessionNotFound");
  const summaries = sessions.map((s) => ({
    id: s.id,
    current: s.id === current.session.id,
    userAgent: s.userAgent,
    ipAddress: s.ipAddress,
    signedInAt: s.createdAt,
    lastActiveAt: s.updatedAt ?? s.createdAt,
    authMethod: s.authMethod,
  }));
  return {
    name: row.name,
    email: row.email,
    image: row.image,
    emailVerified: row.emailVerified,
    hasPassword: accounts.some((a) => a.providerId === "credential" && a.password),
    twoFactorEnabled: row.twoFactorEnabled === true,
    providers: [...new Set(accounts.map((a) => a.providerId).filter((p) => p !== "credential"))].sort(),
    pendingEmail: pending?.to ?? null,
    // This browser's session first, then the most recently used.
    sessions: [...summaries.filter((s) => s.current), ...summaries.filter((s) => !s.current)],
  };
}

// ---------------------------------------------------------------------------------------------
// Profile

export async function updateName(userId: string, name: unknown) {
  const clean = cleanName(name);
  if (!clean.ok) throw new AccountError(clean.error);
  limit("profile", userId);
  await db.update(user).set({ name: clean.name }).where(eq(user.id, userId));
  return clean.name;
}

async function removeOwnAvatar(userId: string, image: string | null | undefined) {
  const own = parseAvatarUrl(image);
  if (own && own.userId === userId) await removeStored([avatarStorageKey(userId, own.name)]);
}

/**
 * Stores a new profile picture (PNG, JPEG, WebP or GIF, checked by its bytes, at most
 * MAX_AVATAR_BYTES) and removes the previous upload. Returns the new `user.image`.
 */
export async function setAvatar(userId: string, bytes: Uint8Array) {
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw new AccountError("avatarTooLarge");
  const format = sniffImage(bytes);
  if (!format) throw new AccountError("avatarType");
  limit("avatar", userId);
  const name = avatarName(randomBytes(16).toString("hex"), format);
  const key = avatarStorageKey(userId, name);
  const { Readable } = await import("node:stream");
  await getStorage().put(key, Readable.from([Buffer.from(bytes)]), { size: bytes.byteLength, contentType: AVATAR_TYPES[format] });
  const url = avatarUrl(userId, name);
  const previous = await db.transaction(async (tx) => {
    const [old] = await tx.select({ image: user.image }).from(user).where(eq(user.id, userId)).for("update");
    if (!old) return undefined;
    await tx.update(user).set({ image: url }).where(eq(user.id, userId));
    return old.image;
  });
  if (previous === undefined) {
    await removeStored([key]);
    throw new AccountError("sessionNotFound");
  }
  await removeOwnAvatar(userId, previous);
  return url;
}

export async function removeAvatar(userId: string) {
  limit("avatar", userId);
  const [old] = await db.select({ image: user.image }).from(user).where(eq(user.id, userId)).limit(1);
  await db.update(user).set({ image: null }).where(eq(user.id, userId));
  await removeOwnAvatar(userId, old?.image);
}

// ---------------------------------------------------------------------------------------------
// Password

function authErrorCode(error: unknown): string | null {
  if (error instanceof APIError) return (error.body as { code?: string } | undefined)?.code ?? null;
  return null;
}

/**
 * Tells the account's owner about a change to it, at `to`: in their stored language (see
 * server/mail/locale.ts), else the request's. A confirmation link may be opened in another browser.
 */
async function notify(
  userId: string,
  to: string,
  build: (locale: Awaited<ReturnType<typeof requestLocale>>) => { subject: string; text: string; html: string },
) {
  if (mailStatus() === "disabled") return;
  const mail = build(await recipientLocale(userId, await requestLocale()));
  // Not awaited: a slow or failing mail server shouldn't hold up or undo the change.
  void sendMail({ to, ...mail }).catch((error) => console.error("could not send account email", error));
}

/**
 * Changes the password (Better Auth checks the current one). With `revokeOthers`, every other
 * session ends and this browser gets a fresh one (set on the response by nextCookies).
 */
export async function changePassword(
  current: AccountSession,
  headers: Headers,
  input: { currentPassword: unknown; newPassword: unknown; revokeOthers: unknown },
) {
  const userId = current.user.id;
  const problem = passwordProblem(input.newPassword);
  if (problem) throw new AccountError(problem);
  if (typeof input.currentPassword !== "string" || !input.currentPassword) throw new AccountError("proofRequired");
  limit("proof", userId);
  if (!(await passwordHashOf(userId))) throw new AccountError("noPassword");
  try {
    await auth.api.changePassword({
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword as string,
        revokeOtherSessions: input.revokeOthers === true,
      },
      headers,
    });
  } catch (error) {
    const code = authErrorCode(error);
    if (code === "INVALID_PASSWORD") throw new AccountError("wrongPassword");
    if (code === "PASSWORD_TOO_SHORT") throw new AccountError("passwordTooShort");
    if (code === "PASSWORD_TOO_LONG") throw new AccountError("passwordTooLong");
    throw error;
  }
  if (input.revokeOthers === true) await disconnectEndedSessions(userId);
  await notify(userId, current.user.email, (locale) => passwordChangedEmail(locale, { name: current.user.name }));
}

/** For accounts without a password (GitHub or Google only): adds one, after proof. */
export async function setPassword(current: AccountSession, headers: Headers, input: { newPassword: unknown; proof: Proof }) {
  const problem = passwordProblem(input.newPassword);
  if (problem) throw new AccountError(problem);
  if (await passwordHashOf(current.user.id)) throw new AccountError("passwordAlreadySet");
  await reauthenticate(current, input.proof);
  try {
    await auth.api.setPassword({ body: { newPassword: input.newPassword as string }, headers });
  } catch (error) {
    if (authErrorCode(error) === "PASSWORD_ALREADY_SET") throw new AccountError("passwordAlreadySet");
    throw error;
  }
  await notify(current.user.id, current.user.email, (locale) => passwordChangedEmail(locale, { name: current.user.name }));
}

/**
 * The sign-in page's "choose a new password" step, for an account an instance admin asked to
 * reset its password on a server without email (see server/required-password.ts). Nobody is
 * signed in yet: the token from the refused sign-in stands for the right old password, and
 * accounts with two-step verification also give a code, which a recovery code is used up for.
 * The new password has to differ from the old one. Signs nobody in; the page then signs in with
 * the new password as usual.
 */
export async function finishRequiredPasswordReset(input: { token: unknown; newPassword: unknown; code: unknown }) {
  const token = typeof input.token === "string" ? input.token : "";
  const userId = await resetStepUser(token);
  if (!userId) throw new AccountError("resetStepExpired");
  const problem = passwordProblem(input.newPassword);
  if (problem) throw new AccountError(problem);
  const newPassword = input.newPassword as string;
  limit("proof", userId);
  const codes = await twoFactorOf(userId);
  if (codes) {
    if (typeof input.code !== "string" || !input.code.trim()) throw new AccountError("proofRequired");
    if (!(await consumeCode(input.code, codes))) throw new AccountError("invalidCode");
  }
  const { password } = await auth.$context;
  const hash = await passwordHashOf(userId);
  if (hash && (await password.verify({ hash, password: newPassword }))) throw new AccountError("samePassword");
  if (!(await consumeResetStep(token))) throw new AccountError("resetStepExpired");
  const changed = await db
    .update(account)
    .set({ password: await password.hash(newPassword), updatedAt: new Date() })
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .returning({ id: account.id });
  if (!changed.length) throw new AccountError("resetStepExpired");
  await clearPasswordResetRequirement(userId);
  // It had none (every password sign-in was refused), but one from before the flag may have slipped in.
  await db.delete(session).where(eq(session.userId, userId));
  await disconnectEndedSessions(userId);
  const [owner] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  if (owner) await notify(userId, owner.email, (locale) => passwordChangedEmail(locale, { name: owner.name }));
}

// ---------------------------------------------------------------------------------------------
// Email

const EMAIL_CHANGE = "change-email:";
const tokenHash = (token: string) => createHash("sha256").update(token).digest("base64url");

type EmailChange = { userId: string; from: string; to: string };

function parseChange(value: string): EmailChange | null {
  try {
    const parsed = JSON.parse(value) as Partial<EmailChange>;
    if (typeof parsed.userId === "string" && typeof parsed.from === "string" && typeof parsed.to === "string") {
      return { userId: parsed.userId, from: parsed.from, to: parsed.to };
    }
  } catch {}
  return null;
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, "\\$&");

/**
 * Verification rows that hold a change for `userId`: their value is the JSON written below, which
 * starts with the user id (matched as text; other rows' values aren't JSON).
 */
const changeRowsOf = (userId: string) =>
  and(
    like(verification.identifier, `${EMAIL_CHANGE}%`),
    like(verification.value, `${likeEscape(`{"userId":${JSON.stringify(userId)},`)}%`),
  );

async function pendingEmailChange(userId: string) {
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(and(changeRowsOf(userId), gt(verification.expiresAt, new Date())))
    .orderBy(desc(verification.createdAt))
    .limit(1);
  return row ? parseChange(row.value) : null;
}

export const emailChangeEnabled = () => mailStatus() !== "disabled";

/**
 * Emails a confirmation link to `newEmail`; the change happens when it is opened (see
 * confirmEmailChange), so the address is proven to be theirs. An address that already has an
 * account gets nothing, and the answer is the same, so this can't be used to find accounts.
 * A new request replaces an earlier one.
 */
export async function requestEmailChange(current: AccountSession, input: { newEmail: unknown; proof: Proof }) {
  if (!emailChangeEnabled()) throw new AccountError("mailDisabled");
  const userId = current.user.id;
  const email = typeof input.newEmail === "string" ? normalizeEmail(input.newEmail) : "";
  // Agents' addresses (see lib/agents.ts) are no one's.
  if (!isEmail(email) || email.length > 254 || isAgentEmail(email)) throw new AccountError("invalidEmail");
  if (email === normalizeEmail(current.user.email)) throw new AccountError("sameEmail");
  limit("email", userId);
  await reauthenticate(current, input.proof);

  await db.delete(verification).where(changeRowsOf(userId));
  const [taken] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (taken) return { email };
  const token = randomBytes(32).toString("base64url");
  const change: EmailChange = { userId, from: current.user.email, to: email };
  await db.insert(verification).values({
    id: randomBytes(16).toString("hex"),
    identifier: EMAIL_CHANGE + tokenHash(token),
    value: JSON.stringify(change),
    expiresAt: new Date(Date.now() + EMAIL_CHANGE_HOURS * 60 * 60_000),
  });
  const url = `${env.appUrl}/confirm-email?token=${encodeURIComponent(token)}`;
  const mail = emailChangeEmail(await recipientLocale(userId, await requestLocale()), {
    name: current.user.name,
    oldEmail: current.user.email,
    url,
    hours: EMAIL_CHANGE_HOURS,
  });
  await sendMail({ to: email, ...mail });
  return { email };
}

export async function cancelEmailChange(userId: string) {
  await db.delete(verification).where(changeRowsOf(userId));
}

/** The change a confirmation link stands for, while it can still go through. */
export async function findEmailChange(token: string) {
  if (!token || token.length > 128) return null;
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(and(eq(verification.identifier, EMAIL_CHANGE + tokenHash(token)), gt(verification.expiresAt, new Date())))
    .limit(1);
  const change = row && parseChange(row.value);
  if (!change) return null;
  const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, change.userId)).limit(1);
  return owner && owner.email === change.from ? change : null;
}

/**
 * Makes the new address the account's email (verified: the link reached it). Works without being
 * signed in, and signs nobody in. The old address hears about it.
 */
export async function confirmEmailChange(token: string) {
  if (!token || token.length > 128) throw new AccountError("linkInvalid");
  type Outcome = { ok: false; error: "linkInvalid" | "emailTaken" } | { ok: true; change: EmailChange; name: string };
  const result: Outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const [row] = await tx
      .delete(verification)
      .where(eq(verification.identifier, EMAIL_CHANGE + tokenHash(token)))
      .returning({ value: verification.value, expiresAt: verification.expiresAt });
    const change = row && row.expiresAt > new Date() ? parseChange(row.value) : null;
    if (!change) return { ok: false, error: "linkInvalid" };
    const [owner] = await tx
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, change.userId))
      .for("update");
    if (!owner || owner.email !== change.from) return { ok: false, error: "linkInvalid" };
    const [taken] = await tx.select({ id: user.id }).from(user).where(eq(user.email, change.to)).limit(1);
    if (taken) return { ok: false, error: "emailTaken" };
    await tx.update(user).set({ email: change.to, emailVerified: true }).where(eq(user.id, change.userId));
    return { ok: true, change, name: owner.name };
  }).catch((error: unknown): Outcome => {
    // Someone took the address between the check and the update.
    // (Drizzle wraps the driver's error; its code is on the cause.)
    const code = (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") return { ok: false, error: "emailTaken" };
    throw error;
  });
  if (!result.ok) throw new AccountError(result.error);
  const { change, name } = result;
  await notify(change.userId, change.from, (locale) => emailChangedEmail(locale, { name, oldEmail: change.from, newEmail: change.to }));
  // A newly verified address may be on a workspace's allowed domain.
  await applyDomainPolicies(change.userId).catch((error) => console.error("could not apply allowed email domains", error));
  return { email: change.to };
}

// ---------------------------------------------------------------------------------------------
// Sessions

/** Drops live collab connections (open pages) of the user's sessions that have ended. */
async function disconnectEndedSessions(userId: string) {
  const live = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())));
  try {
    await getCollab().disconnectSessions(userId, live.map((s) => s.id));
  } catch (error) {
    // Scripts and tests run without the collab server; its connections end with their tokens.
    console.warn("[account] could not close collab connections", error);
  }
}

export async function revokeSession(current: AccountSession, sessionId: string) {
  if (sessionId === current.session.id) throw new AccountError("currentSession");
  limit("sessions", current.user.id);
  const gone = await db
    .delete(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, current.user.id)))
    .returning({ id: session.id });
  if (!gone.length) throw new AccountError("sessionNotFound");
  await disconnectEndedSessions(current.user.id);
}

export async function revokeOtherSessions(current: AccountSession) {
  limit("sessions", current.user.id);
  const gone = await db
    .delete(session)
    .where(and(eq(session.userId, current.user.id), ne(session.id, current.session.id)))
    .returning({ id: session.id });
  await disconnectEndedSessions(current.user.id);
  return gone.length;
}

// ---------------------------------------------------------------------------------------------
// Deleting the account

/** What deleting the account would do now, for the confirmation dialog. */
export async function deletionPlanFor(userId: string): Promise<DeletionPlan> {
  return accountDeletionPlan(userId);
}

/**
 * Deletes the account, after proof and the typed confirmation (the account's email). Refused while
 * the person is the only owner of a workspace others are in. Otherwise, in one transaction:
 * workspaces nobody else is in are deleted with their pages and files; from the others the person
 * leaves, and an owner takes over the pages only they could manage (as when leaving); then the user
 * row goes, and with it (by foreign keys) their sessions, sign-in methods, passkeys, two-step
 * settings, connected apps' grants and tokens, page permissions, favorites and notifications. What
 * they wrote in shared workspaces stays, no longer attributed to anyone.
 */
export async function deleteAccount(current: AccountSession, input: { confirmation: unknown; proof: Proof }) {
  const userId = current.user.id;
  if (!confirmsDeletion(input.confirmation, current.user.email)) throw new AccountError("confirmationMismatch");
  // Before the proof, so a blocked deletion doesn't use up a code.
  const preview = await deletionPlanFor(userId);
  if (preview.blockers.length) throw new AccountError("soleOwner", preview.blockers.map((w) => w.name));
  await reauthenticate(current, input.proof);

  const { plan, keys } = await db.transaction(async (tx) => {
    const { plan, fileKeys: keys } = await withdrawFromWorkspaces(tx, userId);
    if (plan.blockers.length) throw new AccountError("soleOwner", plan.blockers.map((w) => w.name));
    // Pending email changes and password reset links (Better Auth keeps the user id as the value).
    await tx.delete(verification).where(or(eq(verification.value, userId), changeRowsOf(userId)));
    const [gone] = await tx.delete(user).where(eq(user.id, userId)).returning({ image: user.image });
    const own = parseAvatarUrl(gone?.image);
    if (own && own.userId === userId) keys.push(avatarStorageKey(userId, own.name));
    return { plan, keys };
  });

  await removeStored(keys);
  try {
    await getCollab().disconnectSessions(userId, []);
  } catch (error) {
    console.warn("[account] could not close collab connections", error);
  }
  return plan;
}
