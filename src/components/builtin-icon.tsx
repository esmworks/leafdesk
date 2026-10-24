"use client";

import dynamic from "next/dynamic";
import { readBuiltinIcon } from "@/lib/icon-value";

function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

// The drawings (about 20 kB) load only where a built-in icon shows, rendered on the server too.
const Drawing = dynamic(() => import("./builtin-icon-drawing"), {
  loading: () => <svg width="1em" height="1em" aria-hidden />,
});

/** A built-in icon (lib/icon-value), sized by the font size around it, in its color or the text's. */
export function BuiltinIcon({ icon, className }: { icon: string; className?: string }) {
  const builtin = readBuiltinIcon(icon);
  if (!builtin) return null;
  return (
    <span className={cn("builtin-icon items-center justify-center leading-none", builtin.color && `icon-${builtin.color}`, className)}>
      <Drawing name={builtin.name} />
    </span>
  );
}

/** An icon field's value as it shows: an emoji as text, a built-in icon drawn. */
export function IconGlyph({ icon, className }: { icon: string; className?: string }) {
  if (icon.startsWith("icon:")) return <BuiltinIcon icon={icon} className={className} />;
  return <span className={cn("leading-none", className)}>{icon}</span>;
}
