import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mailbox } from "@/db/schema";
import { env } from "@/lib/env";
import { open, openJson, sealJson } from "@/server/secret-box";
import { connectError, MailConnectError, type MailCredentials } from "./connect";
import { refreshGoogleTokens } from "./google";
import { refreshMicrosoftTokens } from "./microsoft";
import type { MailOAuthTokens } from "./oauth";

type Box = typeof mailbox.$inferSelect;

/** An access token is renewed this long before it runs out. */
const EARLY_MS = 60_000;

/** A new access token for a sign-in with its provider, or why there is none: the server has no client for it any more. */
function refreshFor(auth: "google" | "microsoft"): (tokens: MailOAuthTokens) => Promise<MailOAuthTokens> {
  if (auth === "microsoft") {
    const app = env.mailMicrosoftApp;
    if (!app) throw new MailConnectError("signIn", "Signing in with Microsoft isn't set up on this server");
    return (tokens) => refreshMicrosoftTokens(app, tokens);
  }
  const app = env.mailGoogleApp;
  if (!app) throw new MailConnectError("signIn", "Signing in with Google isn't set up on this server");
  return (tokens) => refreshGoogleTokens(app, tokens);
}

/**
 * How to sign in to a connected mailbox: its password, or a current access token of its sign-in
 * with Google or Microsoft, refreshed (and kept) when it is about to run out or `renew` asks for a
 * new one.
 */
export async function mailCredentials(box: Box, { renew = false }: { renew?: boolean } = {}): Promise<MailCredentials> {
  const servers = {
    imapHost: box.imapHost,
    imapPort: box.imapPort,
    imapSecure: box.imapSecure,
    smtpHost: box.smtpHost,
    smtpPort: box.smtpPort,
    smtpSecure: box.smtpSecure,
  };
  if (box.auth === "password") return { servers, username: box.username, password: open(box.secret) };
  const refresh = refreshFor(box.auth);
  let tokens = openJson<MailOAuthTokens>(box.secret);
  if (renew || tokens.expiresAt - EARLY_MS <= Date.now()) {
    tokens = await refresh(tokens);
    // Two refreshes at once (the sweep and a send) are harmless: Google keeps the refresh token,
    // and a refresh token Microsoft replaced keeps working until it runs out.
    await db
      .update(mailbox)
      .set({ secret: sealJson(tokens) })
      .where(eq(mailbox.id, box.id));
  }
  return { servers, username: box.username, accessToken: tokens.accessToken };
}

/**
 * Runs `signedIn` with the mailbox signed in to. An access token the server refused (taken back
 * before it ran out) is renewed once and `signedIn` tried again; a password the server refused is not.
 */
export async function withMailCredentials<T>(box: Box, signedIn: (credentials: MailCredentials) => Promise<T>): Promise<T> {
  try {
    return await signedIn(await mailCredentials(box));
  } catch (error) {
    if (box.auth === "password" || connectError(error).code !== "auth") throw error;
    return signedIn(await mailCredentials(box, { renew: true }));
  }
}
