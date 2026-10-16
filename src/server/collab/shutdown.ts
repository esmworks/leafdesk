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
  const deadline = Date.now() + timeoutMs;
  hocuspocus.closeConnections();
  for (;;) {
    // Again on each round: closing a connection, or a direct write finishing, can queue another save.
    hocuspocus.flushPendingStores();
    if (!savesPending(hocuspocus)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function savesPending(hocuspocus: Hocuspocus) {
  for (const document of hocuspocus.documents.values()) {
    const id = `onStoreDocument-${document.name}`;
    if (hocuspocus.debouncer.isDebounced(id) || hocuspocus.debouncer.isCurrentlyExecuting(id) || document.saveMutex.isLocked()) {
      return true;
    }
  }
  return false;
}
