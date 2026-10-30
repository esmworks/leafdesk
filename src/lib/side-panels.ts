/**
 * The panels that open at the window's edge beside a page (a page's comments or graph, the AI chat)
 * show one at a time: the one opening says so, and the others close. `owner` names the one opening.
 */
const SIDE_PANEL_EVENT = "leafdesk:side-panel";

export function openingSidePanel(owner: string) {
  window.dispatchEvent(new CustomEvent(SIDE_PANEL_EVENT, { detail: owner }));
}

/** Calls `close` when a panel other than `owner`'s opens; returns the unsubscribe. */
export function onOtherSidePanel(owner: string, close: () => void) {
  const listener = (e: Event) => {
    if ((e as CustomEvent<string>).detail !== owner) close();
  };
  window.addEventListener(SIDE_PANEL_EVENT, listener);
  return () => window.removeEventListener(SIDE_PANEL_EVENT, listener);
}
