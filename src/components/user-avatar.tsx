"use client";

import { useLocale } from "next-intl";
import { useState, type CSSProperties } from "react";
import { avatarSrc } from "@/lib/avatar";
import { initialOf } from "@/lib/presence";
import { cn } from "@/components/ui";

const SIZES = {
  xs: "h-5 w-5 text-[10px]",
  sm: "h-6 w-6 text-[11px]",
  md: "h-7 w-7 text-xs",
  lg: "h-9 w-9 text-sm",
  xl: "h-16 w-16 text-2xl",
} as const;

/**
 * A person's profile picture (`user.image`, see lib/avatar.ts), or the first letter of their name
 * when they have none or it doesn't load, in `colors` (classes; or colors set through `style`).
 */
export function UserAvatar({
  name,
  image,
  size = "md",
  colors = "bg-bg-active text-fg-muted",
  className,
  style,
  title,
}: {
  name: string;
  image?: string | null;
  size?: keyof typeof SIZES;
  colors?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const locale = useLocale();
  const src = avatarSrc(image);
  const [failed, setFailed] = useState<string | null>(null);
  const base = cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium", SIZES[size]);
  if (src && failed !== src) {
    return (
      <span aria-hidden title={title} className={cn(base, "bg-bg-active", className)}>
        <img
          src={src}
          alt=""
          // Provider pictures (GitHub, Google) needn't learn which page they were shown on.
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setFailed(src)}
        />
      </span>
    );
  }
  return (
    <span aria-hidden title={title} className={cn(base, colors, className)} style={style}>
      {initialOf(name, locale)}
    </span>
  );
}
