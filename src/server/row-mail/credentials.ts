import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mailbox } from "@/db/schema";
import { env } from "@/lib/env";
import { open, openJson, sealJson } from "@/server/secret-box";
import { connectError, MailConnectError, type MailCredentials } from "./connect";
import { refreshGoogleTokens, type GoogleMailTokens } from "./google";

type Box = typeof mailbox.$inferSelect;

/** An access token is renewed this long before it runs out. */
const EARLY_MS = 60_000;

/**
 * How to sign in to a connected mailbox: its password, or a current access token of its Google
 * sign-in, refreshed (and kept) when it is about to run out or `renew` asks for a new one.
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
  if (box.auth !== "google") return { servers, username: box.username, password: open(box.secret) };
  const app = env.mailGoogleApp;
  if (!app) throw new MailConnectError("signIn", "Signing in with Google isn't set up on this server");
  let tokens = openJson<GoogleMailTokens>(box.secret);
  if (renew || tokens.expiresAt - EARLY_MS <= Date.now()) {
    tokens = await refreshGoogleTokens(app, tokens);
    // Two refreshes at once (the sweep and a send) are harmless: Google keeps the refresh token.
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
    if (box.auth !== "google" || connectError(error).code !== "auth") throw error;
    return signedIn(await mailCredentials(box, { renew: true }));
  }
}
