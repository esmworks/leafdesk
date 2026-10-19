import type { Readable } from "node:stream";
import type { StorageKind } from "@/lib/workspace-storage";

/**
 * A stored object: its key, and the storage's own id for it where the storage addresses objects by
 * id (what `put` returned). A bare string is a key.
 */
export type ObjectRef = string | { key: string; objectId?: string | null };

export const keyOf = (ref: ObjectRef) => (typeof ref === "string" ? ref : ref.key);
export const objectIdOf = (ref: ObjectRef) => (typeof ref === "string" ? null : (ref.objectId ?? null));

/**
 * Where uploaded bytes live: the instance's storage (local or S3, from the environment) or one a
 * workspace brought (server/storage/workspace.ts). The database (`file` table) knows what a file is
 * and who may read it; a driver only stores bytes under a key. Keys are made by server/files.ts
 * (`<workspace>/<file id>`) and never come from a request.
 */
export interface StorageDriver {
  readonly kind: "local" | StorageKind;
  /**
   * Stores `size` bytes from `body` under `key`, replacing what was there. Returns the storage's
   * own id for the object when it addresses objects by id rather than by key (kept on the file row,
   * and given back to `get` and `delete`).
   */
  put(key: string, body: Readable, info: { size: number; contentType: string }): Promise<string | void>;
  /**
   * The bytes of the object, or the inclusive `range` of them; null when there is nothing there.
   */
  get(ref: ObjectRef, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null>;
  /** Removes the object; missing ones are fine. */
  delete(ref: ObjectRef): Promise<void>;
}

/**
 * A request the storage answered with an error (`status`), or couldn't be made (`status` null). A
 * server error or "slow down" is `transient`: worth trying again, and no sign the storage is broken.
 */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
  }

  get transient() {
    return this.status !== null && (this.status >= 500 || this.status === 429);
  }
}

/** Keys the drivers accept: path-like, no traversal, no leading slash. */
export function assertKey(key: string) {
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(key) || key.length > 256) throw new Error(`Bad storage key: ${key}`);
}
