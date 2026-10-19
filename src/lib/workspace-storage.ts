/**
 * Storage a workspace brings itself for its uploads (see server/storage/workspace.ts). Shared by
 * the client and the server.
 */

/** Kinds of storage a workspace can bring. Only those in AVAILABLE_STORAGE_KINDS can be connected yet. */
export const STORAGE_KINDS = ["s3", "gdrive", "dropbox"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];
export const AVAILABLE_STORAGE_KINDS: readonly StorageKind[] = ["s3", "gdrive", "dropbox"];

/**
 * Kinds connected by signing in to the provider (OAuth) rather than by typing keys. Each needs an
 * app the instance registered with the provider (STORAGE_GDRIVE_* / STORAGE_DROPBOX_*).
 */
export const OAUTH_STORAGE_KINDS = ["gdrive", "dropbox"] as const;
export type OAuthStorageKind = (typeof OAUTH_STORAGE_KINDS)[number];
export const isOAuthStorageKind = (kind: unknown): kind is OAuthStorageKind => OAUTH_STORAGE_KINDS.includes(kind as OAuthStorageKind);

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

/** A folder Leafdesk made in someone's Google Drive (it sees only the files it made, `drive.file`). */
export type GDriveStorageConfig = {
  /** The Drive account: its stable id (`permissionId`) and address, for showing and telling apart. */
  accountId: string;
  account: string;
  folderId: string;
  folderName: string;
};

/** Someone's Dropbox, in the folder Dropbox gives Leafdesk's app (Apps/<app name>). */
export type DropboxStorageConfig = {
  accountId: string;
  account: string;
};

/** What isn't secret about a target, by kind. */
export type StorageConfig = S3StorageConfig | GDriveStorageConfig | DropboxStorageConfig;

/** A target's kind with its config, told apart by `kind`. */
export type StorageLocation =
  | { kind: "s3"; config: S3StorageConfig }
  | { kind: "gdrive"; config: GDriveStorageConfig }
  | { kind: "dropbox"; config: DropboxStorageConfig };

/** A stored kind and config as the location they make (the database keeps them apart). */
export const locationOf = (target: { kind: StorageKind; config: StorageConfig }) => ({ kind: target.kind, config: target.config }) as StorageLocation;

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

/**
 * What signing in to a provider gave: the refresh token that lasts, and the access token in use
 * with when it runs out (ms since the epoch). Written back whenever a token is refreshed.
 */
export type OAuthCredentials = { refreshToken: string; accessToken?: string; expiresAt?: number };

export type StorageCredentials = S3Credentials | OAuthCredentials;

/** A target as Settings > Storage shows it. */
export type StorageView = StorageLocation & {
  id: string;
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
  /** The sign-in kinds this instance has an app for (the others can't be connected here). */
  oauthReady: OAuthStorageKind[];
};

/** What Settings > Storage says after a sign-in to Drive or Dropbox sent the browser back. */
export const STORAGE_NOTICES = ["connected", "refused", "oauthFailed", "notConfigured", "rateLimited", "unavailable"] as const;
export type StorageNotice = (typeof STORAGE_NOTICES)[number];

/** The notice the query of the page the browser came back to asks for (an unknown error: a failed sign-in). */
export function storageNoticeOf(query: { storageConnected?: unknown; storageError?: unknown }): StorageNotice | undefined {
  if (query.storageConnected === "1") return "connected";
  if (!query.storageError) return undefined;
  return STORAGE_NOTICES.includes(query.storageError as StorageNotice) && query.storageError !== "connected" ? (query.storageError as StorageNotice) : "oauthFailed";
}

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

/** Whether two targets are the same place: the same bucket, Drive folder or Dropbox account. */
export function sameLocation(a: StorageLocation, b: StorageLocation): boolean {
  if (a.kind === "s3" && b.kind === "s3") return sameS3Location(a.config, b.config);
  if (a.kind === "gdrive" && b.kind === "gdrive") return a.config.accountId === b.config.accountId && a.config.folderId === b.config.folderId;
  if (a.kind === "dropbox" && b.kind === "dropbox") return a.config.accountId === b.config.accountId;
  return false;
}

/** A target as one line: bucket and host, Drive folder and account, or Dropbox account. */
export function locationTitle(location: StorageLocation): string {
  switch (location.kind) {
    case "s3": {
      const { config } = location;
      const host = config.endpoint ? new URL(config.endpoint).host : "s3.amazonaws.com";
      return `${config.bucket}${config.prefix ? `/${config.prefix}` : ""} · ${host}`;
    }
    case "gdrive":
      return `${location.config.folderName} · ${location.config.account}`;
    case "dropbox":
      return location.config.account;
  }
}
