/**
 * Storage a workspace brings itself for its uploads (see server/storage/workspace.ts). Shared by
 * the client and the server.
 */

/** Kinds of storage a workspace can bring. Only those in AVAILABLE_STORAGE_KINDS can be connected yet. */
export const STORAGE_KINDS = ["s3", "gdrive", "dropbox"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];
export const AVAILABLE_STORAGE_KINDS: readonly StorageKind[] = ["s3"];

export type StorageStatus = "active" | "broken" | "disconnected";

/** Where an S3-compatible bucket is (the keys apart). */
export type S3StorageConfig = {
  /** e.g. https://<account>.r2.cloudflarestorage.com; null for AWS itself. */
  endpoint: string | null;
  region: string;
  bucket: string;
  /** A folder of the bucket the files go under, without slashes at either end. */
  prefix: string | null;
  /** `<endpoint>/<bucket>/<key>` rather than `<bucket>.<endpoint>/<key>`. */
  forcePathStyle: boolean;
};

/** What isn't secret about a target, by kind (only S3 so far). */
export type StorageConfig = S3StorageConfig;

/** What an owner types to connect an S3-compatible bucket. */
export type S3StorageInput = {
  endpoint?: unknown;
  region?: unknown;
  bucket?: unknown;
  prefix?: unknown;
  forcePathStyle?: unknown;
  accessKeyId?: unknown;
  secretAccessKey?: unknown;
};

export type S3Credentials = { accessKeyId: string; secretAccessKey: string };

/** A target as Settings > Storage shows it. */
export type StorageView = {
  id: string;
  kind: StorageKind;
  config: StorageConfig;
  status: StorageStatus;
  lastError: string | null;
  lastErrorAt: string | null;
  verifiedAt: string;
  /** Files stored there, and their bytes. */
  files: number;
  bytes: number;
};

export type StorageSettingsView = {
  /** Where new uploads go; null for the instance's storage. */
  current: StorageView | null;
  /** Targets disconnected earlier that still hold files (still read from there). */
  retired: StorageView[];
  /** Bytes in the instance's storage, and its quota for the workspace (null: none). */
  instanceUsed: number;
  instanceQuota: number | null;
};

export class StorageInputError extends Error {
  constructor(readonly field: "endpoint" | "region" | "bucket" | "prefix" | "accessKeyId" | "secretAccessKey") {
    super(`Invalid ${field}`);
  }
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The endpoint as stored: an http(s) origin with an optional path, nothing else. */
export function normalizeEndpoint(value: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageInputError("endpoint");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    throw new StorageInputError("endpoint");
  }
  if (value.length > 300) throw new StorageInputError("endpoint");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Checks and tidies what an owner typed for an S3-compatible bucket. */
export function parseS3Input(input: S3StorageInput): { config: S3StorageConfig; credentials: S3Credentials } {
  const endpoint = normalizeEndpoint(text(input?.endpoint));
  const region = text(input?.region) || "us-east-1";
  if (!/^[a-z0-9-]{1,40}$/.test(region)) throw new StorageInputError("region");
  const bucket = text(input?.bucket);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/.test(bucket) || bucket.includes("..")) throw new StorageInputError("bucket");
  const prefix = text(input?.prefix).replace(/^\/+|\/+$/g, "");
  if (prefix && (prefix.length > 100 || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(prefix))) throw new StorageInputError("prefix");
  const accessKeyId = text(input?.accessKeyId);
  if (!accessKeyId || accessKeyId.length > 256 || /\s/.test(accessKeyId)) throw new StorageInputError("accessKeyId");
  const secretAccessKey = text(input?.secretAccessKey);
  if (!secretAccessKey || secretAccessKey.length > 256 || /\s/.test(secretAccessKey)) throw new StorageInputError("secretAccessKey");
  return {
    // A custom endpoint is addressed by path unless told otherwise (it may have no wildcard DNS).
    config: { endpoint, region, bucket, prefix: prefix || null, forcePathStyle: input?.forcePathStyle === undefined ? Boolean(endpoint) : input.forcePathStyle === true },
    credentials: { accessKeyId, secretAccessKey },
  };
}

/** Whether two S3 configs name the same place, so the files of one are the files of the other. */
export function sameS3Location(a: S3StorageConfig, b: S3StorageConfig) {
  return a.endpoint === b.endpoint && a.bucket === b.bucket && (a.prefix ?? null) === (b.prefix ?? null) && a.region === b.region;
}
