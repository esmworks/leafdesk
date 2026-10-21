const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), audio[controls], video[controls], object, [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab inside an overlay (the file viewer, a presentation), wrapping around at its ends. */
export function trapFocus(event: KeyboardEvent, box: HTMLElement | null) {
  if (!box) return;
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) {
    event.preventDefault();
    box.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === box || !box.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !box.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
