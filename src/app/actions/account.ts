"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { revalidateAccountPages } from "@/server/account-pages";
import { getTranslations } from "next-intl/server";
import { type AccountErrorCode, type DeletionPlan, type Proof, proofOf } from "@/lib/account";
import { auth } from "@/lib/auth";
import {
  AccountError,
  type AccountSession,
  cancelEmailChange,
  changePassword,
  confirmEmailChange,
  deleteAccount,
  finishRequiredPasswordReset,
  removeAvatar,
  requestEmailChange,
  revokeOtherSessions,
  revokeSession,
  setPassword,
  updateName,
} from "@/server/account";
import { getSession } from "@/server/session";

/**
 * The account page's actions. None of them looks at a workspace, so they work for someone a
 * workspace's two-step policy holds back (they may be on their way to set it up).
 * Expected failures come back translated, with their code for scripts.
 */
export type AccountResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: AccountErrorCode | "generic" };

async function signedIn(): Promise<AccountSession> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  return session;
}

async function run<T>(fn: () => Promise<T>): Promise<AccountResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    const t = await getTranslations("account.errors");
    const message =
      error.code === "soleOwner" || error.code === "storageStuck" || error.code === "legalHold"
        ? t(error.code, { workspaces: error.workspaces.join(", ") })
        : t(error.code);
    return { ok: false, error: message, code: error.code };
  }
}

const refresh = () => revalidatePath("/", "layout");

export async function updateNameAction(name: string) {
  const current = await signedIn();
  const result = await run(() => updateName(current.user.id, name));
  if (result.ok) refresh();
  return result;
}

export async function removeAvatarAction() {
  const current = await signedIn();
  const result = await run(() => removeAvatar(current.user.id));
  if (result.ok) refresh();
  return result;
}

export async function changePasswordAction(input: { currentPassword: string; newPassword: string; revokeOthers: boolean }) {
  const current = await signedIn();
  const { currentPassword, newPassword, revokeOthers } = (input ?? {}) as Record<string, unknown>;
  const requestHeaders = await headers();
  const result = await run(() => changePassword(current, requestHeaders, { currentPassword, newPassword, revokeOthers }));
  if (result.ok) revalidateAccountPages();
  return result;
}

export async function setPasswordAction(input: { newPassword: string; proof: Proof }) {
  const current = await signedIn();
  const { newPassword, proof } = (input ?? {}) as Record<string, unknown>;
  const requestHeaders = await headers();
  const result = await run(() => setPassword(current, requestHeaders, { newPassword, proof: proofOf(proof) }));
  if (result.ok) revalidateAccountPages();
  return result;
}

export async function requestEmailChangeAction(input: { newEmail: string; proof: Proof }) {
  const current = await signedIn();
  const { newEmail, proof } = (input ?? {}) as Record<string, unknown>;
  const result = await run(() => requestEmailChange(current, { newEmail, proof: proofOf(proof) }));
  revalidateAccountPages();
  return result;
}

export async function cancelEmailChangeAction() {
  const current = await signedIn();
  await cancelEmailChange(current.user.id);
  revalidateAccountPages();
}

/**
 * The sign-in page's "choose a new password" step (an instance admin asked for it, and the
 * server can't email a reset link); needs no session, the step's token stands for the sign-in.
 */
export async function finishRequiredPasswordResetAction(input: { token: string; newPassword: string; code?: string }) {
  const { token, newPassword, code } = (input ?? {}) as Record<string, unknown>;
  return run(() => finishRequiredPasswordReset({ token, newPassword, code }));
}

/** From the link in the confirmation email; needs no session. */
export async function confirmEmailChangeAction(token: string) {
  const result = await run(() => confirmEmailChange(typeof token === "string" ? token : ""));
  if (result.ok) refresh();
  return result;
}

export async function revokeSessionAction(sessionId: string) {
  const current = await signedIn();
  const result = await run(() => revokeSession(current, typeof sessionId === "string" ? sessionId : ""));
  revalidateAccountPages();
  return result;
}

export async function revokeOtherSessionsAction() {
  const current = await signedIn();
  const result = await run(() => revokeOtherSessions(current));
  revalidateAccountPages();
  return result;
}

export async function deleteAccountAction(input: { confirmation: string; proof: Proof }): Promise<AccountResult<DeletionPlan>> {
  const current = await signedIn();
  const { confirmation, proof } = (input ?? {}) as Record<string, unknown>;
  const result = await run(() => deleteAccount(current, { confirmation, proof: proofOf(proof) }));
  if (result.ok) {
    // The session row is gone with the user; clear its cookies so the browser starts signed out.
    const [store, { authCookies }] = await Promise.all([cookies(), auth.$context]);
    for (const cookie of [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken]) {
      // With the cookie's own attributes: a __Secure- cookie is only replaced by a Secure one.
      const { path, secure, sameSite, httpOnly, domain } = cookie.attributes;
      const same = sameSite?.toLowerCase() as "strict" | "lax" | "none" | undefined;
      store.set(cookie.name, "", { path: path ?? "/", secure, sameSite: same, httpOnly, domain, maxAge: 0 });
    }
  }
  return result;
}
