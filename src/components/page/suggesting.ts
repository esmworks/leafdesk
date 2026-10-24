"use client";

import { createExtension } from "@blocknote/core";
import { Extension } from "@tiptap/core";
import type { Transaction } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import { suggestTransaction } from "@/lib/suggest-changes";
import { suggestionMarkExtensions } from "@/lib/suggestion-marks";
import { newSuggestionId, onlySuggestionsOf } from "@/lib/suggestions";

/**
 * Suggesting mode of the page editor: while it is on, every change the person makes is turned into
 * a suggested edit in their name (lib/suggest-changes): typed text is marked inserted, deleted text
 * stays, struck through, and new formatting is marked as a change. Everyone with the page open sees
 * them live, through the page's document.
 *
 * People who may edit switch it on and off in the page header. For people who may only comment it
 * is always on and strict: a change that can't be suggested (a block's type or settings, say) is
 * left out, and so is any change that would be more than their own suggestions, which the server
 * would refuse anyway (collab/suggest-guard.ts).
 */
export type SuggestingMode = {
  on: boolean;
  /** Leave out what can't be suggested: the person may only comment. */
  strict: boolean;
  authorId: string;
};

/** A transaction with this meta is applied as it is (accepting, rejecting, the server's own). */
export const AS_IS = "leafdesk-suggesting-as-is";

type Controls = { read: () => SuggestingMode; ai: boolean };

/** Each editor's suggesting controls, for code that changes its content (the writing assistant). */
const controlsOf = new WeakMap<object, Controls>();

/**
 * Runs `change`, synchronous changes of `editor`, as suggestions of the AI in its person's name
 * (lib/suggestions newSuggestionId with `ai`), whatever mode the editor is in.
 */
export function suggestAsAi(editor: object, change: () => void) {
  const controls = controlsOf.get(editor);
  if (!controls) return change();
  controls.ai = true;
  try {
    change();
  } finally {
    controls.ai = false;
  }
}

/**
 * The suggestion marks and the suggesting mode, as a BlockNote extension for the page editor.
 * `read` gives the mode at the moment of each change.
 */
export function suggestingExtension(read: () => SuggestingMode) {
  const controls: Controls = { read, ai: false };
  return createExtension(({ editor }) => {
    controlsOf.set(editor, controls);
    const hook = Extension.create({
      name: "suggesting",
      dispatchTransaction({ transaction, next }) {
        const mode = controls.read();
        const ai = controls.ai;
        if ((!mode.on && !ai) || !transaction.docChanged || passesAsIs(transaction)) return next(transaction);
        const state = this.editor.state;
        const { tr, untracked } = suggestTransaction(transaction, state, {
          authorId: mode.authorId,
          newId: () => newSuggestionId(mode.authorId, { ai }),
        });
        if (mode.strict && (untracked || !onlySuggestionsOf(state.doc, tr.doc, mode.authorId))) return;
        next(tr);
      },
    });
    return { key: "suggesting", tiptapExtensions: [...suggestionMarkExtensions, hook] };
  })();
}

/** Changes from the document (other people's, undo) and the ones marked AS_IS go through untouched. */
const passesAsIs = (tr: Transaction) => Boolean(tr.getMeta(ySyncPluginKey)?.isChangeOrigin) || Boolean(tr.getMeta(AS_IS));
