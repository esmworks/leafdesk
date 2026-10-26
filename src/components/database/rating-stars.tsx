"use client";

import { Star } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/ui";

/**
 * A rating's stars (lib/number-format, format "rating"): `value` of `max` filled. With `onChange`,
 * clicking a star sets that many and clicking the current one clears the rating; hovering shows
 * what a click would set.
 */
export function RatingStars({
  value,
  max,
  label,
  onChange,
  className,
}: {
  value: number | null;
  max: number;
  label: string;
  onChange?: (value: number | null) => void;
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? Math.round(value ?? 0);
  const star = (i: number) => (
    <Star
      className="h-3.5 w-3.5"
      strokeWidth={1.75}
      aria-hidden
      // Option colors paint charts in `--chart-<color>`, strong enough in both themes.
      style={i < shown ? { color: "var(--chart-yellow)", fill: "var(--chart-yellow)" } : undefined}
    />
  );
  if (!onChange) {
    return (
      <span className={cn("inline-flex items-center gap-0.5 text-fg-faint", className)} role="img" aria-label={`${label}: ${value ?? 0}/${max}`}>
        {Array.from({ length: max }, (_, i) => (
          <span key={i}>{star(i)}</span>
        ))}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-fg-faint", className)} role="radiogroup" aria-label={label} onMouseLeave={() => setHover(null)}>
      {Array.from({ length: max }, (_, i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={Math.round(value ?? 0) === i + 1}
          aria-label={`${i + 1}/${max}`}
          data-cell-edit=""
          className="inline-flex rounded-sm p-px hover:scale-110"
          onMouseEnter={() => setHover(i + 1)}
          onClick={(e) => {
            e.stopPropagation();
            onChange(Math.round(value ?? 0) === i + 1 ? null : i + 1);
          }}
        >
          {star(i)}
        </button>
      ))}
    </span>
  );
}
