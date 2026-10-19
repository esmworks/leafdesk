import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Secrets of a Docker install that nobody had to write into a .env file. docker-compose.yml's
 * `secrets` service makes them once, at random, into a volume the app reads at
 * LEAFDESK_SECRETS_DIR:
 *
 * - `auth-secret`: BETTER_AUTH_SECRET, when the environment doesn't set one;
 * - `postgres-password`: the bundled database's password, from which DATABASE_URL is made when the
 *   environment sets neither DATABASE_URL (EXTERNAL_DATABASE_URL in compose) nor POSTGRES_PASSWORD.
 *
 * What the environment sets always wins, so a .env written for an older release works unchanged.
 * Without LEAFDESK_SECRETS_DIR (`pnpm dev`, other ways of running the server) nothing happens.
 * Values are never logged; env.ts still refuses a weak auth secret in production.
 */

/** Host, user and database of the bundled PostgreSQL in docker-compose.yml. */
export const BUNDLED_DATABASE = { host: "db", port: 5432, user: "leafdesk", database: "leafdesk" } as const;

/** Reads one secret file: its trimmed content, or null when it doesn't exist or is empty. */
export type SecretReader = (name: string) => string | null;

export function secretReaderFor(dir: string): SecretReader {
  return (name) => {
    try {
      return readFileSync(join(dir, name), "utf8").trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A file that is there but can't be read is a broken install, not a missing secret.
      throw new Error(`Could not read the secret ${name} in ${dir}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    }
  };
}

const unset = (value: string | undefined) => !value || !value.trim();

/** The bundled database's URL with this password (any characters; it is encoded). */
export function bundledDatabaseUrl(password: string) {
  const { host, port, user, database } = BUNDLED_DATABASE;
  return `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/**
 * Fills BETTER_AUTH_SECRET and DATABASE_URL in `env` from the secret files where `env` leaves them
 * unset or empty (compose passes unset variables as empty strings). Returns the names it filled.
 */
export function applySecretFiles(
  env: Record<string, string | undefined> = process.env,
  read: SecretReader | null = unset(env.LEAFDESK_SECRETS_DIR) ? null : secretReaderFor(env.LEAFDESK_SECRETS_DIR!.trim()),
): string[] {
  if (!read) return [];
  const filled: string[] = [];
  if (unset(env.BETTER_AUTH_SECRET)) {
    const secret = read("auth-secret");
    if (secret) {
      env.BETTER_AUTH_SECRET = secret;
      filled.push("BETTER_AUTH_SECRET");
    }
  }
  if (unset(env.DATABASE_URL)) {
    const password = unset(env.POSTGRES_PASSWORD) ? read("postgres-password") : env.POSTGRES_PASSWORD!.trim();
    if (password) {
      env.DATABASE_URL = bundledDatabaseUrl(password);
      filled.push("DATABASE_URL");
    }
  }
  return filled;
}
