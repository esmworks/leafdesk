"use client";

import { useState } from "react";
import { isRtl } from "@/components/direction";

type Side = "before" | "after";

export type ReorderDragHandlers = {
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  /** This item is the one being dragged. */
  dragging: boolean;
  /** Where the dragged item would land next to this one. */
  dropSide: Side | null;
  /** Along which axis `dropSide` is: always `axis`, except in a grid. */
  dropAxis: "x" | "y" | null;
};

type Box = { left: number; top: number; width: number; height: number };

/**
 * Which side of the item `box` a drag at `point` lands on, and along which axis. In a grid an item
 * as wide as its row (`rowWidth`) is above or below the others, so its halves are top and bottom.
 * Right to left (`rtl`), an item's right half is the one before it.
 */
export function dropPlace(axis: "x" | "y" | "grid", box: Box, rowWidth: number | undefined, point: { x: number; y: number }, rtl = false) {
  const along = axis !== "grid" ? axis : rowWidth !== undefined && box.width >= rowWidth - 1 ? "y" : "x";
  const before = along === "x" ? (point.x < box.left + box.width / 2) !== rtl : point.y < box.top + box.height / 2;
  return { side: (before ? "before" : "after") as Side, axis: along };
}

/**
 * Dragging items of a list to reorder them, along "x" (table columns), "y" (menus) or in a "grid"
 * (side by side, except an item as wide as its row, which goes above or below). `onMove` gets the
 * dragged item's id, the one it was dropped on and which side of it. The drag carries the id as
 * `type`; the editor ignores a drop it can't read as text, so items inside a page use their own.
 */
export function useReorderDrag(
  axis: "x" | "y" | "grid",
  onMove: (moved: string, target: string, side: Side) => void,
  type = "text/plain",
) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; side: Side; axis: "x" | "y" } | null>(null);
  const end = () => {
    setDragged(null);
    setDrop(null);
  };
  const placeOf = (e: React.DragEvent) =>
    dropPlace(
      axis,
      e.currentTarget.getBoundingClientRect(),
      e.currentTarget.parentElement?.getBoundingClientRect().width,
      { x: e.clientX, y: e.clientY },
      isRtl(e.currentTarget),
    );
  return {
    handlers: (id: string): ReorderDragHandlers => ({
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(type, id);
        setDragged(id);
      },
      onDragOver: (e) => {
        // Only an item dragged from here; files and text dragged in pass through.
        if (!dragged) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const place = id === dragged ? null : placeOf(e);
        if (drop?.id !== id || drop.side !== place?.side || drop.axis !== place?.axis) setDrop(place ? { id, ...place } : null);
      },
      onDrop: (e) => {
        if (!dragged) return;
        e.preventDefault();
        if (id !== dragged) onMove(dragged, id, placeOf(e).side);
        end();
      },
      onDragEnd: end,
      dragging: dragged === id,
      dropSide: drop?.id === id ? drop.side : null,
      dropAxis: drop?.id === id ? drop.axis : null,
    }),
  };
}
