/**
 * "A page's searchable text may have changed" notices: its document was saved with an edit
 * (collab/service.ts), it was created or restored from the trash (pages.ts). `subtree`: its title
 * changed or it moved, which changes what the pages under it say about where they are too. Semantic search
 * listens to index the page again in the background (see semantic-index.ts). Listeners live on
 * globalThis: the collab server and Next's route handlers are separate module graphs in one
 * process. Row value changes come through row-events.ts.
 */

export type PageChange = { pageId: string; subtree?: boolean };

type Listener = (change: PageChange) => void;

const KEY = "__leafdeskPageListeners";
const listeners = ((globalThis as Record<string, unknown>)[KEY] ??= new Map<string, Listener>()) as Map<string, Listener>;

/** Registers (or replaces) the listener named `name`. */
export function onPageChanged(name: string, listener: Listener) {
  listeners.set(name, listener);
}

export function pageChanged(change: PageChange) {
  for (const listener of listeners.values()) {
    try {
      listener(change);
    } catch (error) {
      console.error("[page-events] listener failed", error);
    }
  }
}
