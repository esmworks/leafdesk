/**
 * Text cut short with an ellipsis (a column's name, an option, a linked row, a page in the sidebar)
 * shows in full as a tooltip while the pointer rests on it, and so do lists of values that don't all
 * fit their cell (marked `data-cut-list`), one value after another. One listener for the whole workspace:
 * the tooltip is given only to text that is cut short at that moment, and taken back when the
 * pointer leaves, so it never goes stale.
 */

/** How far up from the element under the pointer the one cutting the text short may be. */
const LEVELS = 4;

/** Whether an element with this style and these sizes is cutting its text short. */
export function cutShort(
  style: { textOverflow: string; webkitLineClamp?: string },
  size: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number },
) {
  if (style.textOverflow === "ellipsis" && size.scrollWidth > size.clientWidth + 1) return true;
  const clamp = style.webkitLineClamp;
  return !!clamp && clamp !== "none" && size.scrollHeight > size.clientHeight + 1;
}

/** The element under the pointer (or around it) that cuts its text short, and that text in full. */
function truncating(start: Element | null): { el: HTMLElement; text: string } | null {
  // A list whose values don't all fit, or whose values are cut short themselves, shows them all.
  const list = start?.closest<HTMLElement>("[data-cut-list]");
  if (list && list.contains(start) && (list.scrollWidth > list.clientWidth + 1 || [...list.querySelectorAll("*")].some((el) => cutShort(getComputedStyle(el), el)))) {
    return { el: list, text: [...list.children].map((child) => tidy(child.textContent)).filter(Boolean).join(", ") };
  }
  let el = start;
  for (let i = 0; el && i < LEVELS; i++, el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.isContentEditable) return null;
    if (cutShort(getComputedStyle(el), el)) return { el, text: tidy(el.textContent) };
  }
  return null;
}

const tidy = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();

export function watchTruncatedText(root: Document = document) {
  let given: HTMLElement | null = null;
  const takeBack = () => {
    given?.removeAttribute("title");
    given = null;
  };
  const onOver = (e: MouseEvent) => {
    const found = truncating(e.target as Element);
    if (found && found.el === given) return;
    takeBack();
    // A tooltip already there (on it or around it) says what it should.
    if (!found || !found.text || found.el.closest("[title]")) return;
    found.el.setAttribute("title", found.text);
    given = found.el;
  };
  root.addEventListener("mouseover", onOver, { passive: true });
  root.addEventListener("pointerdown", takeBack, { passive: true });
  return () => {
    root.removeEventListener("mouseover", onOver);
    root.removeEventListener("pointerdown", takeBack);
    takeBack();
  };
}
