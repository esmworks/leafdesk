import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import { TAB_LIST_BLOCK } from "./tabs";

/** Marks the tab strip's own changes that take tabs out of a list (moving, deleting one). */
export const TAB_EDIT = "leafdeskTabEdit";

/** Whether a step of `tr` takes a tab out of a list that stays: a tab deleted, or two joined. */
export function dropsTabs(tr: Transaction): boolean {
  return tr.steps.some((step, i) => {
    const before = tr.docs[i];
    const after = tr.docs[i + 1] ?? tr.doc;
    const map = step.getMap();
    let drops = false;
    map.forEach((from, to) => {
      if (drops || to <= from) return;
      before.nodesBetween(from, to, (node, pos) => {
        if (drops || node.isTextblock) return false;
        if (node.type.name !== TAB_LIST_BLOCK) return true;
        // A whole list may go (moved, deleted, cut).
        if (pos >= from && pos + node.nodeSize <= to) return false;
        const now = after.nodeAt(map.map(pos, -1));
        if (now?.type.name !== TAB_LIST_BLOCK || now.childCount < node.childCount) drops = true;
        return false;
      });
    });
    return drops;
  });
}

/**
 * Tabs leave a list only through the strip, or with the whole list. The other tabs are hidden
 * (`display: none`), so an edit the browser makes itself (a Backspace ProseMirror didn't handle, a
 * word deleted with Alt+Backspace, a phone's keyboard) or a selection reaching across them would
 * otherwise delete tabs the person can't see. Others' changes and undo come through Yjs.
 */
export const tabGuard = new Plugin({
  key: new PluginKey("leafdeskTabGuard"),
  filterTransaction: (tr) => !tr.docChanged || Boolean(tr.getMeta(TAB_EDIT)) || Boolean(tr.getMeta(ySyncPluginKey)) || !dropsTabs(tr),
});
