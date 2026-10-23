"use client";

import * as Y from "yjs";
import { acquireDoc, type SharedDoc } from "@/components/collab/socket";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";

/** How long one page's document may take to arrive. */
const DOC_TIMEOUT_MS = 20_000;

/**
 * Opens a page's document with its offline copy, until `done` says it has what it waited for,
 * the server refuses it, or `ms` pass.
 */
export function holdDoc(
  userId: string,
  pageId: string,
  done: (shared: SharedDoc) => boolean,
  ms = DOC_TIMEOUT_MS,
): Promise<{ ok: boolean; denied: string | null; bytes: number; text: string }> {
  return new Promise((resolve) => {
    const { shared, release } = acquireDoc(`page:${pageId}`, { offlineFor: userId });
    const copy = shared.offline;
    let settled = false;
    let stop = () => {};
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      shared.provider.off("authenticationFailed", refused);
      shared.provider.off("synced", check);
      const bytes = ok ? Y.encodeStateAsUpdate(shared.doc).byteLength : 0;
      const text = ok ? shared.doc.getXmlFragment(COLLAB_FRAGMENT).toString() : "";
      const denied = shared.denied;
      release();
      resolve({ ok, denied, bytes, text });
    };
    const refused = () => finish(false);
    const check = () => {
      if (done(shared)) finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    if (!copy) return finish(false);
    stop = copy.on(check);
    shared.provider.on("synced", check);
    shared.provider.on("authenticationFailed", refused);
    check();
  });
}

/** The page's document is in this browser and matches the server's. */
export const docSynced = (shared: SharedDoc) => Boolean(shared.offline?.loaded && shared.provider.isSynced);
