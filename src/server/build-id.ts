import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | null | undefined;

/**
 * The build this server runs (written by `next build` to .next/BUILD_ID, see next.config), or null
 * in development and when the file can't be read: then no tab counts as foreign (lib/build-id).
 */
export function serverBuildId(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.env.NODE_ENV === "production") {
    try {
      cached = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim() || null;
    } catch {}
  }
  return cached;
}
