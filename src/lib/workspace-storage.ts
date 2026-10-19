/**
 * Storage people bring themselves for workspaces' uploads (see server/storage/workspace.ts): a
 * storage account is connected once, on someone's account, and each workspace that uses it gets
 * its own place there. Shared by the client and the server.
 */

/** Kinds of storage someone can connect. */
export const STORAGE_KINDS = ["s3", "gdrive", "dropbox"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

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

/** The Google Drive account signed in to (Leafdesk sees only the files it made there, `drive.file`). */
export type GDriveAccountConfig = {
  /** The Drive account: its stable id (`permissionId`) and address, for showing and telling apart. */
  accountId: string;
  account: string;
  /** The "Leafdesk" folder made on connecting, which workspaces' folders go in; absent for older connections. */
  rootFolderId?: string | null;
};

/** A folder Leafdesk made in someone's Google Drive for one workspace: its account, and the folder. */
export type GDriveStorageConfig = GDriveAccountConfig & {
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

/** What isn't secret about a connected storage account, by kind (`storage_account.config`). */
export type AccountConfig = S3StorageConfig | GDriveAccountConfig | DropboxStorageConfig;

/**
 * A workspace's own place in a storage account (`workspace_storage.config`): its Drive folder.
 * Nothing for a bucket or a Dropbox: every key starts with the workspace's id (`<workspace>/<file>`),
 * which keeps the workspaces using the same bucket or Dropbox apart already.
 */
export type PlaceConfig = { folderId?: string; folderName?: string };

/** A target's kind with its config, told apart by `kind`. */
export type StorageLocation =
  | { kind: "s3"; config: S3StorageConfig }
  | { kind: "gdrive"; config: GDriveStorageConfig }
  | { kind: "dropbox"; config: DropboxStorageConfig };

/** A storage account's kind and config with a workspace's place in it: the location they make. */
export const locationOf = (account: { kind: StorageKind; config: AccountConfig }, place: PlaceConfig = {}) =>
  ({ kind: account.kind, config: { ...account.config, ...place } }) as StorageLocation;

/** A storage account as the location it is before any workspace has a place there. */
export type AccountLocation =
  | { kind: "s3"; config: S3StorageConfig }
  | { kind: "gdrive"; config: GDriveAccountConfig }
  | { kind: "dropbox"; config: DropboxStorageConfig };

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
  /** The storage account it is a place in, and whose it is (null: their Leafdesk account is gone). */
  accountId: string;
  accountLabel: string;
  ownerName: string | null;
  /** Whether it is the viewer's own storage account. */
  mine: boolean;
  status: StorageStatus;
  lastError: string | null;
  lastErrorAt: string | null;
  verifiedAt: string;
  /** Files stored there, and their bytes. */
  files: number;
  bytes: number;
};

/** Why files are moved from one storage to another (see server/storage/moves.ts). */
export const MOVE_REASONS = ["manual", "left", "removed", "accountDeleted", "disconnected"] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];
/** `blocked`: a move was needed (its storage's owner went) but there was nowhere it may go. */
export type MoveStatus = "queued" | "running" | "done" | "failed" | "blocked";

/** A move of a workspace's files as Settings > Storage shows it. */
export type StorageMoveView = {
  id: string;
  status: MoveStatus;
  reason: MoveReason;
  /** Where the files go: a storage account (by its label), or the server's storage. */
  destination: { kind: "server" } | { kind: StorageKind; label: string };
  files: number;
  moved: number;
  failed: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** Somewhere an owner may move the workspace's files to (see server/storage/moves.ts). */
export type MoveDestinationView = { kind: "server" } | { kind: StorageKind; accountId: string; label: string };

export type StorageSettingsView = {
  /** Whether people may connect storage of their own here (OWN_STORAGE_ENABLED). */
  ownStorage: boolean;
  /** Where new uploads go; null for the instance's storage. */
  current: StorageView | null;
  /** Targets disconnected earlier that still hold files (still read from there). */
  retired: StorageView[];
  /** Bytes in the instance's storage, and its quota for the workspace (null: none). */
  instanceUsed: number;
  instanceQuota: number | null;
  /** The viewer's own storage accounts the workspace could use (when own storage is on). */
  accounts: StorageAccountView[];
  /** The kinds the viewer could connect here (see availableStorageKinds). */
  kinds: StorageKind[];
  /** Kinds this instance has no app for, named with what to set: only for the server's administrators. */
  unconfigured: OAuthStorageKind[];
  /** The latest move of the workspace's files, while it runs or until someone dismisses it. */
  move: StorageMoveView | null;
  /** Where an owner may move the files now. */
  destinations: MoveDestinationView[];
};

/** A connected storage account as the account settings show it. */
export type StorageAccountView = AccountLocation & {
  id: string;
  label: string;
  isDefault: boolean;
  status: StorageStatus;
  lastError: string | null;
  verifiedAt: string;
  /** The workspaces using it (or still holding files there), by name. */
  workspaces: { id: string; name: string; current: boolean }[];
};

export type StorageAccountsView = {
  ownStorage: boolean;
  accounts: StorageAccountView[];
  kinds: StorageKind[];
  unconfigured: OAuthStorageKind[];
};

/**
 * The kinds someone may connect: none while own storage is off; with it on, an S3-compatible
 * bucket always, and Drive or Dropbox once the instance has an app for them.
 */
export function availableStorageKinds(enabled: boolean, oauthReady: readonly OAuthStorageKind[]): StorageKind[] {
  if (!enabled) return [];
  return STORAGE_KINDS.filter((kind) => kind === "s3" || oauthReady.includes(kind));
}

/** What Settings > Storage says after a sign-in to Drive or Dropbox sent the browser back. */
export const STORAGE_NOTICES = ["connected", "refused", "oauthFailed", "notConfigured", "rateLimited", "unavailable", "disabled"] as const;
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
export function locationTitle(location: StorageLocation | AccountLocation): string {
  switch (location.kind) {
    case "s3": {
      const { config } = location;
      const host = config.endpoint ? new URL(config.endpoint).host : "s3.amazonaws.com";
      return `${config.bucket}${config.prefix ? `/${config.prefix}` : ""} · ${host}`;
    }
    case "gdrive":
      return "folderName" in location.config && location.config.folderName ? `${location.config.folderName} · ${location.config.account}` : location.config.account;
    case "dropbox":
      return location.config.account;
  }
}

/** The name a storage account gets when it is connected (it can be renamed): the bucket, or the account. */
export function defaultAccountLabel(location: AccountLocation): string {
  return location.kind === "s3" ? location.config.bucket : location.config.account;
}

/** A storage account's name as someone typed it: trimmed, at most 80 characters, never empty. */
export function cleanAccountLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  return label || fallback;
}
