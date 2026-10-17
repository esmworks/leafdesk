/**
 * What the desktop app runs before server.ts when Leafdesk runs on the computer itself (local mode,
 * desktop/src/local-server.ts): applies the migrations, then makes sure the computer's one account
 * exists, with the password the app keeps to sign in with. The account is made by signing up, as
 * anyone's is, so it gets its personal workspace; one that exists already gets the app's password
 * again, so an app that lost its copy isn't locked out.
 *
 * Env: DATABASE_URL, BETTER_AUTH_SECRET, and the account's LEAFDESK_LOCAL_EMAIL,
 * LEAFDESK_LOCAL_NAME and LEAFDESK_LOCAL_PASSWORD (not arguments: other programs see those).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const { DATABASE_URL, LEAFDESK_LOCAL_EMAIL: email, LEAFDESK_LOCAL_NAME: name, LEAFDESK_LOCAL_PASSWORD: password } = process.env;
if (!DATABASE_URL || !email || !name || !password) throw new Error("DATABASE_URL and the LEAFDESK_LOCAL_* variables are needed");

// onnotice: drizzle's "already exists, skipping" notices on every start are noise.
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
await sql.end();
console.log("migrations applied");

// Loaded once the migrations are in: it opens the app's own pool to the database.
const { auth } = await import("@/lib/auth");

try {
  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  let userId: string;
  if (!existing) {
    userId = (await auth.api.signUpEmail({ body: { email, name, password } })).user.id;
    console.log("local account created");
  } else {
    userId = existing.user.id;
    const hash = await context.password.hash(password);
    if (existing.accounts.some((account) => account.providerId === "credential")) {
      await context.internalAdapter.updatePassword(userId, hash);
    } else {
      await context.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
    }
    console.log("local account ready");
  }
  // Nobody can prove an address that reaches no one, and nothing should ask this account to.
  await context.internalAdapter.updateUser(userId, { emailVerified: true });
} finally {
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
// The database client may be kept under another name: don't wait on its idle connections.
process.exit(0);
