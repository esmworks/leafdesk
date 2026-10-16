/**
 * "A database row changed" notices: its values (row writes in databases.ts) or its title and
 * content (saves of its document in collab/service.ts). AI autofill listens to update values that
 * are set to follow their row (see ai-properties.ts). Listeners live on globalThis: the collab
 * server and Next's route handlers are separate module graphs in one process.
 */

export type RowChange = {
  rowId: string;
  databaseId: string;
  /** Who made the change; null when unknown (a save without a user). */
  userId: string | null;
  /**
   * Set when an AI autofill value made the change: the property it wrote, and every AI property
   * written in the cascade it belongs to, this one included (see ai-properties.ts).
   */
  autofill?: { propertyId: string; chain: string[] };
};

type Listener = (change: RowChange) => void;

const KEY = "__leafdeskRowListeners";
const listeners = ((globalThis as Record<string, unknown>)[KEY] ??= new Map<string, Listener>()) as Map<string, Listener>;

/** Registers (or replaces) the listener named `name`. */
export function onRowChanged(name: string, listener: Listener) {
  listeners.set(name, listener);
}

export function rowChanged(change: RowChange) {
  for (const listener of listeners.values()) {
    try {
      listener(change);
    } catch (error) {
      console.error("[row-events] listener failed", error);
    }
  }
}
