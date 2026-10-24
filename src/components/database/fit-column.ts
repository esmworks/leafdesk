import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@/lib/views";

/** A column wide enough for the widest of `widths` (what its cells hold), within the limits a view keeps. */
export function fittedWidth(widths: number[]) {
  const widest = Math.ceil(Math.max(0, ...widths));
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, widest));
}

/**
 * How wide each cell's content is when nothing cuts it short: a copy of what it holds is laid out
 * out of sight at its natural width (one line, nothing truncated), with the cell's own padding.
 */
export function contentWidths(cells: HTMLElement[]) {
  const stage = document.createElement("div");
  stage.setAttribute("aria-hidden", "true");
  stage.style.cssText = "position:absolute;top:0;left:-100000px;visibility:hidden;pointer-events:none;";
  document.body.appendChild(stage);
  try {
    return cells.map((cell) => {
      const style = getComputedStyle(cell);
      const copy = document.createElement("div");
      copy.style.cssText = `width:max-content;white-space:nowrap;padding-inline:${style.paddingLeft} ${style.paddingRight};font:${style.font};`;
      for (const child of cell.childNodes) {
        // The hover controls sit over the cell, out of its flow: they take no room.
        if (child instanceof HTMLElement && getComputedStyle(child).position === "absolute") continue;
        copy.appendChild(child.cloneNode(true));
      }
      copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
      stage.appendChild(copy);
      return copy.getBoundingClientRect().width;
    });
  } finally {
    stage.remove();
  }
}
