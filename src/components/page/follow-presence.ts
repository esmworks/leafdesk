"use client";

import type { Awareness } from "y-protocols/awareness";
import { relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { useEffect } from "react";
import { FOLLOW_USER_EVENT, PRESENCE_FIELD } from "@/lib/presence";
import type { PageEditor } from "./embed-blocks";

/**
 * Clicking someone in the page header's list of who is here (presence-avatars.tsx) scrolls the
 * editor to their cursor: the `cursor` their editor puts in its awareness state (y-prosemirror),
 * found by the `presence` the collab server vouches for. Nothing happens while they have none
 * (reading without a caret) or it is in a part of the page this editor doesn't show.
 */

/** Where in the editor's document `userId`'s cursor is, from the tab of theirs that has one; null when none. */
export function cursorOf(editor: PageEditor, awareness: Awareness, userId: string): number | null {
  const sync = ySyncPluginKey.getState(editor.prosemirrorState);
  if (!sync?.binding) return null;
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const presence = state[PRESENCE_FIELD] as { id?: unknown } | undefined;
    const cursor = state.cursor as { head?: unknown } | undefined;
    if (presence?.id !== userId || !cursor?.head) continue;
    const pos = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(cursor.head), sync.binding.mapping);
    if (pos !== null) return Math.min(pos, editor.prosemirrorState.doc.content.size);
  }
  return null;
}

export function useFollowPresence(editor: PageEditor, awareness: Awareness | null | undefined, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !awareness) return;
    const follow = (event: Event) => {
      const userId = (event as CustomEvent<unknown>).detail;
      if (typeof userId !== "string") return;
      const pos = cursorOf(editor, awareness, userId);
      const view = editor.prosemirrorView;
      if (pos === null || !view) return;
      const { node } = view.domAtPos(pos);
      const element = node instanceof Element ? node : node.parentElement;
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    window.addEventListener(FOLLOW_USER_EVENT, follow);
    return () => window.removeEventListener(FOLLOW_USER_EVENT, follow);
  }, [editor, awareness, enabled]);
}
