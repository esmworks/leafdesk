"use client";

import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { linkedPageRef } from "@/lib/mentions";

/**
 * Resting the pointer on a page mention or a link to a page of this app (in the editor and in
 * comments: anything inside a BlockNote view) shows a card about the page; on a group mention, who
 * is in the group; on a link shown as a mention, the link, to copy, refresh or turn into a
 * bookmark. Only with a mouse (no cards on touch screens), after a moment, and never taking
 * the focus; leaving, Escape, a click or scrolling closes it. The card and its data
 * (page-preview-card.tsx) load the first time one opens.
 */

export type PreviewTarget = { kind: "page" | "group" | "link"; id: string };
type Shown = { anchor: HTMLElement; target: PreviewTarget };

const PreviewCard = lazy(() => import("./page-preview-card"));

const OPEN_DELAY_MS = 450;
/** Time to move the pointer from the link into the card before it closes. */
const CLOSE_DELAY_MS = 150;
/** Where cards open: editors and comments. */
const SCOPE = ".bn-container";
/** The card, found by its attribute. */
const CARD = "[data-page-preview]";

function previewAt(element: Element | null): Shown | null {
  const anchor = element?.closest<HTMLElement>("a[href], [data-mention-group]");
  if (!anchor || !anchor.closest(SCOPE) || anchor.closest(CARD)) return null;
  const groupId = anchor.getAttribute("data-mention-group");
  if (groupId) return { anchor, target: { kind: "group", id: groupId } };
  if (anchor.hasAttribute("data-link-mention")) return { anchor, target: { kind: "link", id: anchor.getAttribute("href") ?? "" } };
  const linked = linkedPageRef(anchor.getAttribute("href"), window.location.origin);
  return linked ? { anchor, target: { kind: "page", id: linked.pageId } } : null;
}

// One set of listeners and one card for the whole window, however many editors are open (a row
// over its database, synced pages): the first editor mounted draws it.
let shown: Shown | null = null;
const listeners = new Set<() => void>();
const owners: symbol[] = [];
let stop: (() => void) | null = null;
let closeShown: (() => void) | null = null;

/** Closes the card that is open (after one of its buttons did its work). */
export function closePreview() {
  closeShown?.();
}

function show(next: Shown | null) {
  shown = next;
  for (const listener of listeners) listener();
}

function listen(): () => void {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return () => {};
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  // The link the pointer rests on, until its card opens; the link whose card is open.
  let pending: HTMLElement | null = null;
  let open: HTMLElement | null = null;

  const close = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    pending = null;
    if (!open) return;
    open = null;
    show(null);
  };
  const inCard = (node: EventTarget | null) => node instanceof Element && Boolean(node.closest(CARD));
  const onOver = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
    if (inCard(event.target)) return clearTimeout(closeTimer);
    const hit = previewAt(event.target);
    if (!hit) return;
    if (hit.anchor === open) return clearTimeout(closeTimer);
    if (hit.anchor === pending) return;
    clearTimeout(openTimer);
    pending = hit.anchor;
    openTimer = setTimeout(() => {
      pending = null;
      open = hit.anchor;
      clearTimeout(closeTimer);
      show(hit);
    }, OPEN_DELAY_MS);
  };
  const onOut = (event: PointerEvent) => {
    const from = event.target instanceof Node ? event.target : null;
    const to = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (!from) return;
    if (pending?.contains(from) && !(to && pending.contains(to))) {
      clearTimeout(openTimer);
      pending = null;
    }
    const leaving = open?.contains(from) || inCard(from);
    const staying = to && (open?.contains(to) || inCard(to));
    if (leaving && !staying) {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(close, CLOSE_DELAY_MS);
    }
  };
  const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
  const onDown = (event: PointerEvent) => !inCard(event.target) && close();

  closeShown = close;
  document.addEventListener("pointerover", onOver);
  document.addEventListener("pointerout", onOut);
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("scroll", close, true);
  window.addEventListener("blur", close);
  return () => {
    close();
    closeShown = null;
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("pointerout", onOut);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("blur", close);
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function PagePreviews() {
  const [me] = useState(() => Symbol("previews"));
  const current = useSyncExternalStore(
    subscribe,
    () => (owners[0] === me ? shown : null),
    () => null,
  );

  useEffect(() => {
    owners.push(me);
    if (!stop) stop = listen();
    // The first editor draws the card; tell it, now that there may be one.
    show(shown);
    return () => {
      owners.splice(owners.indexOf(me), 1);
      if (!owners.length) {
        stop?.();
        stop = null;
      }
      show(shown);
    };
  }, [me]);

  if (!current) return null;
  return (
    <Suspense fallback={null}>
      <PreviewCard key={`${current.target.kind}:${current.target.id}`} anchor={current.anchor} target={current.target} />
    </Suspense>
  );
}
