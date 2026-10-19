import { resolve } from "node:path";
import type { StorageDriver } from "./driver";
import { localDriver } from "./local";
import { s3Driver } from "./s3";

export { keyOf, StorageError, type ObjectRef, type StorageDriver } from "./driver";

/** Where uploads go on disk when no S3 bucket is set; gitignored, a volume in Docker. */
export const DEFAULT_UPLOAD_DIR = "./data/uploads";

const MB = 1024 * 1024;

function megabytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback * MB;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number of megabytes`);
  return Math.floor(value * MB);
}

/**
 * Upload limits from the environment, in bytes. `UPLOAD_WORKSPACE_QUOTA_MB=0` turns the workspace
 * quota off.
 */
export function uploadLimits() {
  return {
    /** UPLOAD_MAX_FILE_MB, 50 MB by default. */
    maxFileBytes: megabytes("UPLOAD_MAX_FILE_MB", 50),
    /** UPLOAD_WORKSPACE_QUOTA_MB, 10 GB by default; 0 is unlimited. */
    workspaceQuotaBytes: megabytes("UPLOAD_WORKSPACE_QUOTA_MB", 10 * 1024) || Infinity,
  };
}

/**
 * The storage driver the environment picks: S3-compatible storage when S3_BUCKET is set (or
 * STORAGE_DRIVER=s3), a local directory (UPLOAD_DIR) otherwise.
 */
export function driverFromEnv(env: Record<string, string | undefined> = process.env): StorageDriver {
  const kind = env.STORAGE_DRIVER?.trim().toLowerCase() || (env.S3_BUCKET ? "s3" : "local");
  if (kind === "local") return localDriver(resolve(/*turbopackIgnore: true*/ env.UPLOAD_DIR?.trim() || DEFAULT_UPLOAD_DIR));
  if (kind !== "s3") throw new Error(`STORAGE_DRIVER must be "local" or "s3", not "${kind}"`);
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for S3 storage`);
    return value;
  };
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const pathStyle = env.S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  return s3Driver({
    bucket: need("S3_BUCKET"),
    endpoint,
    // R2 takes us-east-1 as well as "auto"; MinIO expects it unless configured otherwise.
    region: env.S3_REGION?.trim() || "us-east-1",
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    // Custom endpoints (MinIO, R2) are addressed by path unless told otherwise.
    forcePathStyle: pathStyle ? ["1", "true", "yes"].includes(pathStyle) : Boolean(endpoint),
    prefix: env.S3_PREFIX?.trim() || undefined,
  });
}

const KEY = "__leafdeskStorage";

/**
 * The instance's own storage (shared by server.ts and Next's route bundles through a global): for
 * avatars, and for the files of workspaces that bring none (see ./workspace.ts, storageFor).
 */
export function instanceStorage(): StorageDriver {
  const holder = globalThis as Record<string, unknown>;
  holder[KEY] ??= driverFromEnv();
  return holder[KEY] as StorageDriver;
}

/** Tests: use this driver as the instance's storage instead of the one from the environment. */
export function setStorage(driver: StorageDriver | null) {
  (globalThis as Record<string, unknown>)[KEY] = driver ?? undefined;
}
