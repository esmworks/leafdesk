import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SELECT_COLORS } from "@/lib/properties";

/**
 * What scripts/mcp-app.ts builds app-bundle.ts from, shared with app-bundle.test.ts, which checks
 * that the bundle in the repository is the one its sources make today.
 */

/** Packages whose code goes into the bundle: a new version needs a new bundle. */
export const BUNDLED_PACKAGES = ["@modelcontextprotocol/ext-apps", "esbuild"] as const;

/** A hash of the bundle's own source files (paths from the repository's root) and the packages' versions. */
export function sourcesHash(sources: readonly string[], root = process.cwd()): string {
  const hash = createHash("sha256");
  for (const path of [...sources].sort()) hash.update(`${path}\0${readFileSync(join(root, path), "utf8")}\0`);
  for (const name of BUNDLED_PACKAGES) {
    const { version } = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version: string };
    hash.update(`${name}@${version}\0`);
  }
  return hash.digest("hex");
}

/**
 * The option chips' colors in globals.css (`.opt-*`), light and then dark, as the view's CSS: the
 * dark ones under `[data-theme="dark"]`, which applyDocumentTheme sets from the app's theme.
 */
export function optionPaletteCss(globals: string): string {
  const rule = /\.opt-([a-z]+), \.tint-[a-z]+ \{ --opt-bg: (#[0-9a-f]{6}); --opt-fg: (#[0-9a-f]{6});/g;
  const found = [...globals.matchAll(rule)].map(([, color, bg, fg]) => ({ color, bg, fg }));
  const light = found.slice(0, SELECT_COLORS.length);
  const dark = found.slice(SELECT_COLORS.length);
  const names = (list: typeof found) => list.map((c) => c.color).join(",");
  if (found.length !== SELECT_COLORS.length * 2 || names(light) !== SELECT_COLORS.join(",") || names(dark) !== SELECT_COLORS.join(",")) {
    throw new Error("globals.css no longer holds one light and one dark .opt-* rule per option color, in SELECT_COLORS's order");
  }
  return [
    ...light.map((c) => `.opt-${c.color}{--opt-bg:${c.bg};--opt-fg:${c.fg}}`),
    ...dark.map((c) => `[data-theme="dark"] .opt-${c.color}{--opt-bg:${c.bg};--opt-fg:${c.fg}}`),
  ].join("");
}
