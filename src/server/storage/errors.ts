import type { StorageInputError } from "@/lib/workspace-storage";
import { StorageError } from "./driver";

/**
 * Expected failures of the storage settings (a workspace's Settings > Storage, and the storage
 * accounts of someone's account), translated by the UI by `code`.
 */
export type StorageSettingsErrorCode =
  | StorageInputError["field"]
  | "unavailable"
  | "notConfigured"
  | "oauthFailed"
  | "refused"
  | "rateLimited"
  | "noStorage"
  /** Own storage is off on this server (OWN_STORAGE_ENABLED): nothing new can be connected. */
  | "disabled"
  /** The storage account isn't there, or isn't the person's own. */
  | "noAccount"
  /** The storage account was disconnected: no workspace may start using it. */
  | "accountDisconnected"
  /** A move of the workspace's files is under way: wait for it. */
  | "moveInProgress"
  /** There is nowhere the files may go (`detail`: the workspace's name). */
  | "noDestination"
  /** The server's storage can't take the files: not S3, or over the workspace's quota. */
  | "serverRefused"
  | "noMove";

export class StorageSettingsError extends Error {
  constructor(
    readonly code: StorageSettingsErrorCode,
    /** For `refused` and `oauthFailed`: what the storage said; for `noDestination`, the workspace. */
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Tries per person (or workspace) in a window: each one reaches out to a host someone typed. */
const MAX_TRIES = 20;
const TRY_WINDOW_MS = 10 * 60 * 1000;
const tries = new Map<string, number[]>();

export function countTry(scope: string, now = Date.now()) {
  const recent = (tries.get(scope) ?? []).filter((at) => now - at < TRY_WINDOW_MS);
  if (recent.length >= MAX_TRIES) throw new StorageSettingsError("rateLimited");
  recent.push(now);
  tries.set(scope, recent);
}

/** A storage failure while trying a target, as the settings say it. */
export function refusal(error: unknown): never {
  if (error instanceof StorageError) throw new StorageSettingsError("refused", error.message);
  if (error instanceof Error && error.message.startsWith("Bad storage key")) throw new StorageSettingsError("refused", error.message);
  throw error;
}
