import type { PageBackground } from "@/lib/page-background";

/**
 * The classes that color a page (lib/page-background), on the page itself and its published copy.
 * No hooks, so server components use it too. The root gets a `page-bg-*` class (globals.css), which
 * mixes the color into `--bg` and its siblings, so everything painted with the page colors (sticky
 * table columns, the header, hovers) takes it too, in either theme.
 */
export function backdropClass(background: PageBackground | null): string | undefined {
  return background ? `page-bg-${background.color} bg-bg` : undefined;
}
