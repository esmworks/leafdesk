import * as Y from "yjs";
import { COLLAB_FRAGMENT, COLLAB_META } from "./collab-constants";
import { COLLAB_TITLE } from "./collab-title";
import { THREADS_MAP } from "./comments";
import { rewriteDeep } from "./backup";

/**
 * Rewrites the strings of a page document (or a history version of one) with `rewrite`, for a
 * restored backup whose people have other ids here (lib/backup, idRewriter). People's ids sit in
 * mentions' and blocks' attributes (some hold JSON, such as a linked view's filters), in link marks,
 * in text and embeds, in the comment threads and their reactions. Every part of the document is walked: the body, the
 * synced blocks' fragments (`synced:<id>`), the threads, the page's metadata and its title.
 *
 * Returns the document's new state as an update, or null when nothing changed.
 */
export function rewriteDocument(state: Uint8Array, rewrite: (text: string) => string): Uint8Array | null {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  let changed = false;
  const fix = (value: unknown): { value: unknown; changed: boolean } => {
    const next = rewriteDeep(value, rewrite);
    return { value: next, changed: JSON.stringify(next) !== JSON.stringify(value) };
  };

  const walkMap = (map: Y.Map<unknown>) => {
    for (const [key, value] of [...map.entries()]) {
      if (value instanceof Y.AbstractType) walkType(value);
      else {
        const result = fix(value);
        if (result.changed) {
          map.set(key, result.value);
          changed = true;
        }
      }
    }
  };
  const walkArray = (array: Y.Array<unknown>) => {
    array.toArray().forEach((value, index) => {
      if (value instanceof Y.AbstractType) walkType(value);
      else {
        const result = fix(value);
        if (result.changed) {
          array.delete(index, 1);
          array.insert(index, [result.value]);
          changed = true;
        }
      }
    });
  };
  const walkText = (text: Y.Text) => {
    let index = 0;
    for (const op of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
      const length = typeof op.insert === "string" ? op.insert.length : 1;
      if (op.insert instanceof Y.AbstractType) walkType(op.insert);
      else {
        // The text itself, or an embedded value: put back with its marks, rewritten too. Marks are
        // passed even when there are none, or the new text would take its neighbours'.
        const inserted = fix(op.insert);
        if (inserted.changed) {
          const attributes = (op.attributes ? fix(op.attributes).value : {}) as Record<string, unknown>;
          text.delete(index, length);
          if (typeof inserted.value === "string") text.insert(index, inserted.value, attributes);
          else text.insertEmbed(index, inserted.value as object, attributes);
          index += typeof inserted.value === "string" ? inserted.value.length : 1;
          changed = true;
          continue;
        }
      }
      if (op.attributes) {
        const result = fix(op.attributes);
        if (result.changed) {
          // Marks whose name changed (none should) are left alone; their values are rewritten.
          text.format(index, length, result.value as Record<string, unknown>);
          changed = true;
        }
      }
      index += length;
    }
  };
  const walkXml = (node: Y.XmlFragment | Y.XmlElement) => {
    if (node instanceof Y.XmlElement) {
      for (const [name, value] of Object.entries(node.getAttributes())) {
        const result = fix(value);
        if (result.changed) {
          node.setAttribute(name, result.value as string);
          changed = true;
        }
      }
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) walkText(child);
      else if (child instanceof Y.XmlElement) walkXml(child);
    }
  };
  function walkType(type: Y.AbstractType<unknown>) {
    if (type instanceof Y.XmlText) walkText(type);
    else if (type instanceof Y.XmlFragment) walkXml(type);
    else if (type instanceof Y.Text) walkText(type);
    else if (type instanceof Y.Map) walkMap(type);
    else if (type instanceof Y.Array) walkArray(type);
  }

  doc.transact(() => {
    for (const name of [...doc.share.keys()]) {
      if (name === COLLAB_FRAGMENT || name.startsWith("synced:")) walkXml(doc.getXmlFragment(name));
      else if (name === THREADS_MAP || name === COLLAB_META) walkMap(doc.getMap(name));
      else if (name === COLLAB_TITLE) walkText(doc.getText(name));
    }
  });
  return changed ? Y.encodeStateAsUpdate(doc) : null;
}
