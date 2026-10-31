"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useSyncExternalStore } from "react";
import { read } from "@/components/read";
import type { MailboxTabView, MailFolderView } from "@/lib/mail-client";

/**
 * The person's mailboxes and folders in the workspace, shared by the sidebar's Mail tab and the
 * Mail page: one read, and the unread counts both show change together as mail is read.
 * What is open (mailbox, folder, thread, a new message) is in the address: `?box=&f=&t=&c=` (mailHref).
 */

type State = { workspaceId: string | null; boxes: MailboxTabView[] | null; error: string | null };

/** The read didn't reach the server: useMailboxes words it. */
const OFFLINE = "offline";

let state: State = { workspaceId: null, boxes: null, error: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
// One read at a time per workspace: one begun for another workspace doesn't hold this one up.
let loading: { workspaceId: string; done: Promise<void> } | null = null;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  emit();
}

/** Reads the mailboxes again (after a refresh, or on first use in a workspace). */
export function loadMailboxes(workspaceId: string) {
  if (state.workspaceId !== workspaceId) set({ workspaceId, boxes: null, error: null });
  if (loading?.workspaceId === workspaceId) return loading.done;
  const done = read("mailboxes", workspaceId)
    .then((result) => {
      if (state.workspaceId !== workspaceId) return;
      set(result.ok ? { boxes: result.data, error: null } : { error: result.error });
      if (result.ok) askAgainWhileReading(workspaceId, result.data);
    })
    .catch(() => {
      if (state.workspaceId === workspaceId) set({ error: OFFLINE });
    })
    .finally(() => {
      if (loading?.done === done) loading = null;
    });
  loading = { workspaceId, done };
  return done;
}

// Mailboxes not read yet are read on the server as they are listed (read.ts listMailboxes): the
// list is asked for again until their folders are there, for a minute or so at most.
const READ_AGAIN_MS = 4000;
let readTries = 0;
function askAgainWhileReading(workspaceId: string, boxes: MailboxTabView[]) {
  if (!boxes.some((b) => !b.folders && b.status !== "error") || readTries >= 15) {
    readTries = 0;
    return;
  }
  readTries++;
  setTimeout(() => {
    if (state.workspaceId === workspaceId) void loadMailboxes(workspaceId);
  }, READ_AGAIN_MS);
}

export function useMailboxes(workspaceId: string) {
  const t = useTranslations("mail");
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  useEffect(() => {
    if (current.workspaceId !== workspaceId || (!current.boxes && !current.error)) void loadMailboxes(workspaceId);
  }, [workspaceId, current.workspaceId, current.boxes, current.error]);
  if (current.workspaceId !== workspaceId) return { workspaceId, boxes: null, error: null };
  return current.error === OFFLINE ? { ...current, error: t("loadFailed") } : current;
}

/** Puts a mailbox's newer view in place (after it was opened or refreshed). */
export function putMailbox(box: MailboxTabView) {
  if (!state.boxes) return;
  set({ boxes: state.boxes.map((b) => (b.id === box.id ? box : b)) });
}

/** Puts a mailbox's folders in place. */
export function putFolders(mailboxId: string, folders: MailFolderView[]) {
  if (!state.boxes) return;
  set({ boxes: state.boxes.map((b) => (b.id === mailboxId ? { ...b, folders } : b)) });
}

/** Changes a folder's unread count by `delta` at once, before the server says so. */
export function countUnread(mailboxId: string, folderId: string, delta: number) {
  if (!state.boxes || !delta) return;
  set({
    boxes: state.boxes.map((b) =>
      b.id === mailboxId && b.folders ? { ...b, folders: b.folders.map((f) => (f.id === folderId ? { ...f, unseen: Math.max(0, f.unseen + delta) } : f)) } : b,
    ),
  });
}

/** The mailbox and folder an address names, else the default mailbox and its inbox. */
export function pickOpen(boxes: MailboxTabView[] | null, boxId: string | null, folderId: string | null) {
  const box = boxes?.find((b) => b.id === boxId) ?? boxes?.[0] ?? null;
  const folder = box?.folders?.find((f) => f.id === folderId) ?? box?.folders?.find((f) => f.role === "inbox") ?? box?.folders?.[0] ?? null;
  return { box, folder };
}

/**
 * A link's click within the Mail page: only the address changes, so the server isn't asked for the
 * page again. From another page, or opened elsewhere (a modifier, another button), the link goes.
 */
export function stayInMail(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number; preventDefault: () => void }, href: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  if (new URL(href, window.location.href).pathname !== window.location.pathname) return;
  e.preventDefault();
  window.history.pushState(null, "", href);
}

export function mailHref(workspaceId: string, open: { box?: string | null; f?: string | null; t?: string | null; q?: string | null; c?: string | null } = {}) {
  const params = new URLSearchParams();
  if (open.box) params.set("box", open.box);
  if (open.f) params.set("f", open.f);
  if (open.t) params.set("t", open.t);
  if (open.q) params.set("q", open.q);
  if (open.c) params.set("c", open.c);
  const query = params.toString();
  return `/w/${workspaceId}/mail${query ? `?${query}` : ""}`;
}

// "New message" in the sidebar opens the composer on the page.
const composeListeners = new Set<() => void>();
export const onCompose = (listener: () => void) => {
  composeListeners.add(listener);
  return () => void composeListeners.delete(listener);
};
export const requestCompose = () => composeListeners.forEach((l) => l());

/** A message's time as lists show it: the hour today, the day this year, else the date. */
export function useWhen() {
  const locale = useLocale();
  return (iso: string, long = false) => {
    const date = new Date(iso);
    const now = new Date();
    if (long) return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
    if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
    if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
    return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
  };
}
