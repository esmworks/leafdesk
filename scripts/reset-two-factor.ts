/**
 * Last-resort recovery for someone who lost both their authenticator app and their recovery
 * codes: turns two-step verification off for one account, so they can sign in with the password
 * (or GitHub/Google) and set it up again. `--passkeys` also removes their passkeys. Their current
 * sessions are signed out. Run it on the server, as whoever administers this instance.
 *
 *   pnpm auth:reset-2fa person@example.com [--passkeys]
 *
 * Env: DATABASE_URL (read from .env when present, or made from a Docker install's secret files).
 */
import { applySecretFiles } from "../src/lib/secret-files";

try {
  process.loadEnvFile();
} catch {}
// In a Docker install without DATABASE_URL, the bundled database's (lib/secret-files.ts).
applySecretFiles();

const { eq, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { passkey, session, twoFactor, user } = await import("@/db/schema");

const args = process.argv.slice(2);
const email = args.find((arg) => !arg.startsWith("--"));
const withPasskeys = args.includes("--passkeys");

try {
  if (!email) {
    console.error("Usage: pnpm auth:reset-2fa <email> [--passkeys]");
    process.exitCode = 1;
  } else {
    const [account] = await db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(eq(sql`lower(${user.email})`, email.trim().toLowerCase()))
      .limit(1);
    if (!account) {
      console.error(`No account with the email ${email}.`);
      process.exitCode = 1;
    } else {
      await db.transaction(async (tx) => {
        await tx.delete(twoFactor).where(eq(twoFactor.userId, account.id));
        await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, account.id));
        if (withPasskeys) await tx.delete(passkey).where(eq(passkey.userId, account.id));
        await tx.delete(session).where(eq(session.userId, account.id));
      });
      console.log(
        `Two-step verification is off for ${account.email}${withPasskeys ? " and their passkeys are removed" : ""}; ` +
          "their sessions were signed out. Workspaces that require it will ask them to set it up again.",
      );
    }
  }
} finally {
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
