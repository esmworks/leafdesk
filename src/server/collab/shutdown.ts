import type { Hocuspocus } from "@hocuspocus/server";

/**
 * Saves every open document before the process exits (server.ts, on SIGINT/SIGTERM). Edits wait up
 * to the debounce (see service.ts) before they are written, so without this the last seconds of
 * typing would be lost on every restart.
 *
 * Closes the websockets first, so no new edits arrive meanwhile (browsers keep theirs and send them
 * again when they reconnect), then starts the pending saves and waits until none is pending or
 * running. Returns false when `timeoutMs` passed first: a container runtime kills the process soon
 * after the signal (Docker after 10 s), and exiting on our own is better than being killed midway.
 */
export async function flushCollab(
  hocuspocus: Hocuspocus,
  { timeoutMs = 8000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  hocuspocus.closeConnections();
  return saveOpenDocuments(hocuspocus, { timeoutMs, pollMs });
}

/**
 * Starts the pending saves of every open document (or only those `names`) and waits until none is
 * pending or running, or `timeoutMs` passed (false then). Connections stay open, so edits made
 * meanwhile are saved later; a workspace backup (server/backup) calls it so its pages are read as
 * they were a moment before, a copy (server/duplicate) for the pages it copies.
 */
export async function saveOpenDocuments(
  hocuspocus: Hocuspocus,
  { timeoutMs = 8000, pollMs = 25, names }: { timeoutMs?: number; pollMs?: number; names?: ReadonlySet<string> } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Again on each round: closing a connection, or a direct write finishing, can queue another save.
    if (names) flushStores(hocuspocus, names);
    else hocuspocus.flushPendingStores();
    if (!savesPending(hocuspocus, names)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** hocuspocus.flushPendingStores for some documents only. */
function flushStores(hocuspocus: Hocuspocus, names: ReadonlySet<string>) {
  for (const name of names) {
    const document = hocuspocus.documents.get(name);
    const id = `onStoreDocument-${name}`;
    if (document && !document.isLoading && hocuspocus.debouncer.isDebounced(id)) hocuspocus.debouncer.executeNow(id);
  }
}

function savesPending(hocuspocus: Hocuspocus, names?: ReadonlySet<string>) {
  for (const document of hocuspocus.documents.values()) {
    if (names && !names.has(document.name)) continue;
    const id = `onStoreDocument-${document.name}`;
    if (hocuspocus.debouncer.isDebounced(id) || hocuspocus.debouncer.isCurrentlyExecuting(id) || document.saveMutex.isLocked()) {
      return true;
    }
  }
  return false;
}
