import type { CSSProperties } from "react";
import type { PageBackground } from "@/lib/page-background";

/**
 * How a page's background (lib/page-background) is drawn, by the page itself and its published
 * copy. No hooks, so server components use it too.
 *
 * A color tints the whole page: its root gets a `page-bg-*` class (globals.css), which mixes the
 * color into `--bg` and its siblings, so everything painted with the page colors (sticky table
 * columns, the header, hovers) takes it too, in either theme. An image stays put behind the page
 * while it scrolls (`BackdropImage`, the root's first child; the root must be `isolate`), and the
 * text sits on a plain surface over it (`IMAGE_SURFACE`).
 */
export function backdropRoot(background: PageBackground | null): { className?: string; style?: CSSProperties } {
  if (background?.kind !== "color") return {};
  return { className: `page-bg-${background.color} bg-bg` };
}

/** The image of an image background, filling the visible part of the page. */
export function BackdropImage({ background }: { background: PageBackground | null }) {
  if (background?.kind !== "image") return null;
  return (
    <div
      aria-hidden
      // Sticky and as tall as the window, pulled out of the flow by its own height: it stays in
      // view behind the page whichever element scrolls it.
      className="pointer-events-none sticky top-0 -z-10 -mb-[100dvh] h-[100dvh] w-full shrink-0 bg-bg-subtle bg-cover bg-center"
      style={{ backgroundImage: `url(${JSON.stringify(background.url)})` }}
    />
  );
}

/** The plain surface the content sits on over an image background. */
export const IMAGE_SURFACE = "rounded-xl bg-bg shadow-sm ring-1 ring-border/60";
