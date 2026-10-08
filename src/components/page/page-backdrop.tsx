import type { PageBackground } from "@/lib/page-background";

/**
 * The classes that draw a page's background (lib/page-background), on the page itself and its
 * published copy. No hooks, so server components use them too. A color is a `page-bg-*` class
 * (globals.css), which mixes the color into `--bg`, `--border` and their siblings, so everything
 * painted with the page colors (sticky table columns, the header, table lines, hovers) takes it
 * too, in either theme. A pattern is a `page-pattern-*` class, drawn behind the page's content.
 */
export function backdropClass(background: PageBackground | null): string | undefined {
  if (!background) return undefined;
  return [
    background.color && `page-bg-${background.color} bg-bg`,
    background.pattern && `page-pattern page-pattern-${background.pattern}`,
  ]
    .filter(Boolean)
    .join(" ");
}
