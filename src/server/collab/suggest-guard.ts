import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { onlySuggestionsOf } from "@/lib/suggestions";
import { bodyRoot } from "./suggestion-doc";
import { staysInside } from "./thread-guard";

/**
 * People who may only comment on a page may suggest edits to it (lib/suggestions), through the
 * same live connection editors type in, but the server stays the judge of what they change: it
 * applies an update of theirs only when its whole effect is their own suggestions. Their browser
 * suggests every change it makes and sends nothing else (components/page/suggesting.ts), so a
 * refusal means a bug or a tampered browser; the connection is dropped then and the tab loads the
 * page again (SUGGESTION_REFUSED_EVENT).
 *
 * The check is on what the update does, not on how Yjs encodes it: it must stay inside the body
 * (thread-guard staysInside: no title, threads, synced blocks or style), apply completely (no part
 * left waiting for clocks the server lacks), and the body after it, with the person's own
 * suggestions rejected, must be the body before it with theirs rejected (lib/suggestions
 * onlySuggestionsOf). So they can add text only marked as their insertion, mark text deleted or
 * reformatted only in their name, take back only their own suggestions, and touch no one else's
 * text or suggestions.
 */
export function onlyOwnSuggestions(doc: Y.Doc, update: Uint8Array, userId: string): boolean {
  if (!staysInside(doc, update, COLLAB_FRAGMENT)) return false;
  const copy = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const before = bodyRoot(copy.getXmlFragment(COLLAB_FRAGMENT));
    Y.applyUpdate(copy, update);
    if (copy.store.pendingStructs || copy.store.pendingDs) return false;
    const after = bodyRoot(copy.getXmlFragment(COLLAB_FRAGMENT));
    return onlySuggestionsOf(before, after, userId);
  } catch {
    return false;
  } finally {
    copy.destroy();
  }
}
