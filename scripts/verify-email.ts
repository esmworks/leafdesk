/**
 * Marks one account's email address as verified, for an instance administrator (ADMIN_EMAILS)
 * whose address was never confirmed: accounts made with a password aren't, and an unverified
 * address doesn't count as an administrator's. The other ways are signing in once with GitHub or
 * Google with that address, or resetting the password through the emailed link. Run it on the
 * server, as whoever administers this instance.
 *
 *   pnpm auth:verify-email person@example.com
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
const { user } = await import("@/db/schema");
const { adminEmailsFrom } = await import("@/lib/instance-admin");

const email = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

try {
  if (!email) {
    console.error("Usage: pnpm auth:verify-email <email>");
    process.exitCode = 1;
  } else {
    const [account] = await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(sql`lower(${user.email})`, email.trim().toLowerCase()))
      .returning({ email: user.email });
    if (!account) {
      console.error(`No account with the email ${email}.`);
      process.exitCode = 1;
    } else {
      const admin = adminEmailsFrom(process.env.ADMIN_EMAILS).has(account.email.toLowerCase());
      console.log(
        `${account.email} is verified.` +
          (admin ? " It is listed in ADMIN_EMAILS: the account is an instance administrator." : ""),
      );
    }
  }
} finally {
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
// The database client may be kept under another name: don't wait on its idle connections.
process.exit(process.exitCode ?? 0);
