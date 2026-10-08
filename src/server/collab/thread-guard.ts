import * as Y from "yjs";
import { THREADS_MAP } from "@/lib/comments";

/**
 * Comment threads live in the page's document, which editors' browsers write to. Only the server
 * may change them (server/comments.ts checks who may do what), so an update from a browser that
 * adds to or deletes from the threads map is refused before it is applied. Browsers never write
 * there themselves: their comment store sends every change to the server.
 *
 * The lengths in an update are the browser's word (a deleted run of content is only a number), so
 * every loop here runs over the structs and ranges the update or the document holds, never over
 * the clocks they cover.
 */

type AnyType = Y.AbstractType<unknown>;
type Struct = Y.Item | Y.GC;

/** The root type an item sits in. */
function rootOf(item: Y.Item): AnyType | null {
  let type = item.parent as AnyType | null;
  while (type?._item) type = type._item.parent as AnyType | null;
  return type;
}

/** The struct of one client's list (sorted by clock) that covers `clock`, by binary search. */
function covering<T extends Struct>(list: readonly T[], clock: number): T | null {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const struct = list[mid];
    if (clock < struct.id.clock) high = mid - 1;
    else if (clock >= struct.id.clock + struct.length) low = mid + 1;
    else return struct;
  }
  return null;
}

/** The item with this id in the document, if the document has it. */
function itemAt(doc: Y.Doc, id: Y.ID): Y.Item | null {
  const found = covering((doc.store.clients.get(id.client) ?? []) as Struct[], id.clock);
  return found instanceof Y.Item ? found : null;
}

/** Whether a client's update would change the page's comment threads. */
export function touchesThreads(doc: Y.Doc, update: Uint8Array): boolean {
  const threads = doc.share.get(THREADS_MAP) ?? null;
  const { structs, ds } = Y.decodeUpdate(update);
  const items = structs.filter((s): s is Y.Item => s instanceof Y.Item);

  // Items of this update by client, in clock order, to follow references between them.
  const own = new Map<number, Y.Item[]>();
  for (const item of items) {
    const list = own.get(item.id.client);
    if (list) list.push(item);
    else own.set(item.id.client, [item]);
  }
  for (const list of own.values()) list.sort((a, b) => a.id.clock - b.id.clock);
  const ownAt = (id: Y.ID) => covering(own.get(id.client) ?? [], id.clock);

  const inThreads = new Map<Y.Item, boolean>();
  const isThreads = (item: Y.Item, depth = 0): boolean => {
    const known = inThreads.get(item);
    if (known !== undefined) return known;
    let result = false;
    if (depth > 10_000) result = true; // a chain this long is no editor's; refuse it
    else if (typeof item.parent === "string") result = item.parent === THREADS_MAP;
    else {
      // Inside another item (a nested type), or next to one: the same place as that item.
      const ref = item.parent instanceof Y.ID ? item.parent : (item.origin ?? item.rightOrigin);
      if (ref) {
        const existing = itemAt(doc, ref);
        if (existing) {
          // A parent item holds a nested type in the same root as the item itself.
          result = threads !== null && rootOf(existing) === threads;
        } else {
          const sibling = ownAt(ref);
          result = sibling ? isThreads(sibling, depth + 1) : false;
        }
      }
    }
    inThreads.set(item, result);
    return result;
  };

  if (items.some((item) => isThreads(item))) return true;
  if (!threads) return false;
  // Deletions: walk the document's structs each range covers. Ranges are taken in clock order and
  // never walk a struct twice, so overlapping or tiny ranges cost no more than the document's length.
  for (const [client, deletes] of ds.clients) {
    const existing = (doc.store.clients.get(client) ?? []) as Struct[];
    if (!existing.length) continue;
    const last = existing[existing.length - 1];
    const end = last.id.clock + last.length;
    let walked = 0; // clocks below this were looked at
    for (const { clock, len } of [...deletes].sort((a, b) => a.clock - b.clock)) {
      for (let at = Math.max(clock, walked); at < Math.min(clock + len, end); ) {
        const struct = covering(existing, at);
        if (!struct) break; // the store has no gaps below `end`
        // Deleting what is already deleted changes nothing: a browser's sync sends its whole delete
        // set, server deletions in the threads included.
        if (struct instanceof Y.Item && !struct.deleted && rootOf(struct) === threads) return true;
        at = struct.id.clock + struct.length;
        walked = at;
      }
      if (clock >= end) break;
    }
  }
  return false;
}
