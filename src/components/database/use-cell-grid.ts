"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cellGridShortcut, isMac } from "@/lib/shortcuts";
import {
  clampRange,
  fillGrid,
  fillTarget,
  inBounds,
  isArrow,
  moveRange,
  pastedGrid,
  planPaste,
  rangeBounds,
  toTsv,
  type CellBounds,
  type CellPoint,
  type CellRange,
  type PasteColumn,
  type PastePlan,
} from "@/lib/table-clipboard";

const isTyping = (el: Element) => el.closest("input, textarea, select, [contenteditable='true']") !== null;

/**
 * The table's cells as a grid the keyboard moves through: arrows move the active cell, Shift with
 * an arrow (or a click) stretches a range from it, Enter opens the active cell's editor (Esc closes
 * it again, and the cell keeps focus), Delete clears the range. Copying puts the range on the
 * clipboard as tab-separated text, and pasting writes spreadsheet cells from the active cell on.
 * Filling copies the range's values into the cells its handle is dragged over (or, with Mod+D,
 * down from its top row), written like a paste. Keys and clipboard events only count while focus
 * is in the table itself (not in an editor, and not in a page around an inline table), so the
 * page's own editing is left alone.
 */
export function useCellGrid({
  box,
  rowCount,
  columns,
  rowIdAt,
  copyText,
  canEdit,
  canAddRows,
  canFill,
  timeZone,
  write,
  duplicateRow,
  reveal,
}: {
  box: React.RefObject<HTMLElement | null>;
  rowCount: number;
  columns: PasteColumn[];
  rowIdAt: (row: number) => string;
  /** A cell's value as clipboard text (see lib/table-clipboard cellText). */
  copyText: (row: number, col: number) => string | number | null;
  canEdit: (rowId: string | null, key: string) => boolean;
  canAddRows: boolean;
  /** Whether the fill handle shows (the viewer may change cells). */
  canFill: boolean;
  timeZone: string;
  write: (plan: PastePlan) => void;
  /** Duplicates the row in line `row` (Mod+D with cells of one row selected); missing where rows can't be added. */
  duplicateRow?: (row: number) => void;
  /** Scrolls a row that isn't rendered into view (see useTableWindow); false when it is rendered. */
  reveal: (row: number) => boolean;
}) {
  const [stored, setRange] = useState<CellRange | null>(null);
  const size = { rows: rowCount, cols: columns.length };
  const range = stored && clampRange(stored, size);
  const bounds = useMemo(() => range && rangeBounds(range), [range]);
  // After a keyboard move: the cell that takes focus, and the one to scroll to. A row scrolled into
  // view renders in the body alone (see useTableWindow), so this looks again a few times.
  const pending = useRef<{ focus: CellPoint; show: CellPoint; tries: number } | null>(null);
  const [, lookAgain] = useState(0);
  const dragging = useRef(false);
  const shiftClick = useRef(false);
  // The row the fill handle is dragged to, while it is (see fillHandle).
  const [fillTo, setFillTo] = useState<number | null>(null);
  const filling = bounds && fillTo !== null ? fillTarget(bounds, fillTo) : null;

  const cellAt = (p: CellPoint) => box.current?.querySelector<HTMLElement>(`[data-cell="${p.row}:${p.col}"]`) ?? null;

  // Focus follows the active cell; a cell the table doesn't render (scrolled away) waits for it.
  useEffect(() => {
    const next = pending.current;
    if (!next) return;
    const shown = cellAt(next.show);
    if (!shown && next.tries < 10 && (next.tries > 0 || reveal(next.show.row))) {
      next.tries++;
      const timer = setTimeout(() => lookAgain((n) => n + 1), 30);
      return () => clearTimeout(timer);
    }
    shown?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const target = cellAt(next.focus) ?? box.current;
    if (target && !target.contains(document.activeElement)) target.focus({ preventScroll: true });
    pending.current = null;
  });

  // A click outside the table (and outside its editors and menus) lets go of the range.
  useEffect(() => {
    if (!stored) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (box.current?.contains(target) || target.closest?.("[data-floating]")) return;
      setRange(null);
    };
    const onUp = () => (dragging.current = false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [stored, box]);

  const select = (next: CellRange) => {
    pending.current = { focus: next.anchor, show: next.focus, tries: 0 };
    setRange(next);
  };

  /** Whether an event belongs to the grid: it came from a cell (or the table itself), not an editor or a header. */
  const fromGrid = (e: React.SyntheticEvent) => {
    const target = e.target as HTMLElement;
    if (!box.current?.contains(target) || isTyping(target)) return false;
    return target === box.current || target.closest("[data-cell]") !== null;
  };

  const rowIds = () => Array.from({ length: rowCount }, (_, i) => rowIdAt(i));

  /** Writes the range's values into `target`, rows above or below it, as a paste does. */
  const fill = (from: CellBounds, target: CellBounds) => {
    const source: (string | number | null)[][] = [];
    for (let r = from.top; r <= from.bottom; r++) {
      const row: (string | number | null)[] = [];
      for (let c = from.left; c <= from.right; c++) row.push(copyText(r, c));
      source.push(row);
    }
    const plan = planPaste({ grid: fillGrid(source, from, target), target, rowIds: rowIds(), columns, canEdit, canAddRows: false, timeZone });
    if (plan.updates.length || plan.invalid || plan.skipped) write(plan);
  };

  // Letting go of the fill handle fills the cells it was dragged over, which stay selected with the range.
  useEffect(() => {
    if (fillTo === null) return;
    const onUp = () => {
      setFillTo(null);
      if (!range || !bounds || !filling) return;
      fill(bounds, filling);
      const down = filling.top > bounds.bottom;
      setRange({
        anchor: { row: down ? bounds.top : bounds.bottom, col: range.anchor.col },
        focus: { row: down ? filling.bottom : filling.top, col: range.anchor.col === bounds.left ? bounds.right : bounds.left },
      });
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  });

  const paste = (text: string) => {
    if (!bounds) return;
    const grid = pastedGrid(text);
    if (!grid.length) return;
    const plan = planPaste({ grid, target: bounds, rowIds: rowIds(), columns, canEdit, canAddRows, timeZone });
    if (plan.updates.length || plan.newRows.length || plan.invalid || plan.skipped) write(plan);
    // The pasted cells stay selected (one value filled the range it was pasted into).
    const single = grid.length === 1 && grid[0].length === 1;
    if (!single) {
      const focus = {
        row: Math.min(bounds.top + grid.length - 1, rowCount - 1 + plan.newRows.length),
        col: Math.min(bounds.left + grid[0].length - 1, columns.length - 1),
      };
      setRange({ anchor: { row: bounds.top, col: bounds.left }, focus });
    }
  };

  const containerProps = {
    // Focus lands here when the active cell scrolls out of the rendered rows, so keys still arrive.
    tabIndex: -1,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (!range || !fromGrid(e) || e.altKey) return;
      const target = e.target as HTMLElement;
      if (isArrow(e.key) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        select(moveRange(range, e.key, e.shiftKey, size));
      } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        // The cell's own editor opens it when it has the focus; otherwise it's opened from here.
        if (target.hasAttribute("data-cell-edit")) return;
        const edit = cellAt(range.anchor)?.querySelector<HTMLElement>("[data-cell-edit]");
        if (!edit) return;
        e.preventDefault();
        edit.click();
      } else if (e.key === "Escape") {
        if (bounds && (bounds.top !== bounds.bottom || bounds.left !== bounds.right)) setRange({ anchor: range.anchor, focus: range.anchor });
        else {
          setRange(null);
          target.blur();
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && bounds) {
        e.preventDefault();
        const plan = planPaste({ grid: [[""]], target: bounds, rowIds: rowIds(), columns, canEdit, canAddRows: false, timeZone });
        if (plan.updates.length) write({ ...plan, invalid: 0 });
      } else if (bounds && cellGridShortcut(e.nativeEvent, isMac()) === "fillDown") {
        // Several rows: each column takes its top cell's value. One row: the row is duplicated.
        e.preventDefault();
        if (bounds.bottom > bounds.top) fill({ ...bounds, bottom: bounds.top }, { ...bounds, top: bounds.top + 1 });
        else duplicateRow?.(bounds.top);
      }
    },
    onCopy: (e: React.ClipboardEvent<HTMLElement>) => {
      if (!bounds || !fromGrid(e)) return;
      // Text the viewer selected inside a cell copies as usual.
      const selected = window.getSelection();
      if (selected && !selected.isCollapsed && selected.toString().trim()) return;
      const cells: (string | number | null)[][] = [];
      for (let r = bounds.top; r <= bounds.bottom; r++) {
        const row: (string | number | null)[] = [];
        for (let c = bounds.left; c <= bounds.right; c++) row.push(copyText(r, c));
        cells.push(row);
      }
      e.preventDefault();
      e.clipboardData.setData("text/plain", toTsv(cells));
    },
    onPaste: (e: React.ClipboardEvent<HTMLElement>) => {
      if (!bounds || !fromGrid(e)) return;
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      paste(text);
    },
  };

  /** What a body cell gets: where it is, and the clicks that make it the active cell or stretch the range to it. */
  const cellProps = (row: number, col: number) => ({
    "data-cell": `${row}:${col}`,
    tabIndex: -1,
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const point = { row, col };
      if (e.shiftKey && range) {
        // Stretching the range doesn't open the cell's editor (see onClickCapture).
        e.preventDefault();
        shiftClick.current = true;
        setRange({ anchor: range.anchor, focus: point });
        return;
      }
      dragging.current = true;
      setRange({ anchor: point, focus: point });
    },
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (fillTo !== null) {
        if (e.buttons === 1 && row !== fillTo) setFillTo(row);
        return;
      }
      if (!dragging.current || !range || e.buttons !== 1) return;
      if (range.focus.row === row && range.focus.col === col) return;
      window.getSelection()?.removeAllRanges();
      setRange({ anchor: range.anchor, focus: { row, col } });
    },
    onClickCapture: (e: React.MouseEvent<HTMLElement>) => {
      if (!shiftClick.current) return;
      shiftClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  });

  /**
   * The small square at the range's bottom corner: dragging it up or down fills the cells it passes
   * over with the range's values (see fill). Only where the viewer may edit.
   */
  const fillHandle = (row: number, col: number) =>
    !bounds || !canFill || row !== bounds.bottom || col !== bounds.right
      ? null
      : {
          onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
            if (e.button !== 0) return;
            // Not a click on the cell, and no text selected on the way.
            e.preventDefault();
            e.stopPropagation();
            setFillTo(bounds.bottom);
          },
        };

  return {
    range,
    bounds,
    fillHandle,
    /** A cell the fill handle is being dragged over, with the sides of the filled area it is on; null for others. */
    fillingEdges: (row: number, col: number) =>
      filling && inBounds(filling, row, col)
        ? { top: row === filling.top, bottom: row === filling.bottom, start: col === filling.left, end: col === filling.right }
        : null,
    /** The cell keys and edits go to. */
    isActive: (row: number, col: number) => !!range && range.anchor.row === row && range.anchor.col === col,
    isSelected: (row: number, col: number) => !!bounds && inBounds(bounds, row, col),
    /** More than one cell is selected (a drag stops selecting text in cells). */
    spans: !!bounds && (bounds.top !== bounds.bottom || bounds.left !== bounds.right),
    containerProps,
    cellProps,
  };
}
