"use client";

import { createElement } from "react";
import { BUILTIN_ICONS } from "@/lib/builtin-icons-data";

/** A built-in icon's drawing, 1em square in the current color; nothing for a name there isn't. Loaded lazily by BuiltinIcon. */
export default function BuiltinIconDrawing({ name }: { name: string }) {
  const node = BUILTIN_ICONS[name];
  if (!node) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      {node.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
