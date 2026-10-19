import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { applySecretFiles } from "../src/lib/secret-files";

try {
  process.loadEnvFile();
} catch {}
applySecretFiles();

// onnotice: drizzle's "already exists, skipping" notices on every start are noise.
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
await sql.end();
console.log("migrations applied");
