"use client";

import { CommentsExtension } from "@blocknote/core/comments";
import { Thread, useExtension } from "@blocknote/react";
import { useEffect, useMemo, useSyncExternalStore, type ComponentProps } from "react";

/**
 * BlockNote's Thread for a resolved thread whose resolver may not be loaded yet. BlockNote throws
 * while rendering a resolved thread when it doesn't know who resolved it (it loads them only after
 * that render), which took the whole page down as soon as a resolved thread was listed. Until the
 * resolver is known, or when they can't be (the server names only people in the page's threads and
 * the workspace), the thread shows without its "marked as resolved" line.
 */
export function KnownResolverThread(props: ComponentProps<typeof Thread>) {
  const { userStore } = useExtension(CommentsExtension);
  const resolver = props.thread.resolved ? props.thread.resolvedBy : undefined;
  const known = useSyncExternalStore(
    userStore.store.subscribe,
    () => !resolver || userStore.store.state.has(resolver),
    () => !resolver,
  );
  useEffect(() => {
    if (resolver) void userStore.loadUsers([resolver]);
  }, [userStore, resolver]);
  const thread = useMemo(() => (known ? props.thread : { ...props.thread, resolvedBy: undefined }), [known, props.thread]);
  return <Thread {...props} thread={thread} />;
}
