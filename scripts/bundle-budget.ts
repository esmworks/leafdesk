// Fails when the JavaScript a browser downloads grows past the budgets below. Run after `pnpm build`:
//   pnpm tsx scripts/bundle-budget.ts
// A route's first load is the chunks its client reference manifest lists for its layouts, page and
// error boundaries, plus the runtime every page loads (build-manifest.json's rootMainFiles). Every
// other chunk loads on demand (a lazy component, a dynamic import). Sizes are gzipped, as served.
// Raise a budget on purpose, in the same commit as the change that needs it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

/**
 * Gzipped kB, for what a person waits for rather than what the build holds:
 *
 * - `routeFirstLoad`: the largest first load of any route, what opening that page downloads: a
 *   page or database (about 768 kB, the editor and the table view among it), then Settings (about
 *   470 kB) and the workspace's other routes (about 365 kB).
 * - `firstLoadShared`: every chunk any route loads first, together (about 1172 kB); it grows when
 *   code moves into first loads, even into a route the largest doesn't show. Of that, about 80 kB
 *   are what pages and databases do on their own: views' color rules, the "Available offline"
 *   switch, the meeting block's editor spec, reactions and the discussions panel, form
 *   conditions, place values and new chat cards, then suggested edits' pending count, the
 *   verified badge, pinned properties and properties beside the body, comments on property
 *   values, the feed's reactions, the chat's model picker, research steps and scope, the inbox's
 *   swipes, link mentions, button colors, the floating outline's loader, the comments panel's
 *   person filter and personal filters on views people can't change, then editing values on cards, the fill
 *   handle, date formats, comment links and mentions, the view's default template and vertical
 *   lines, the link button's page search, `+` for new pages, code captions, the backlinks
 *   popup, ratings' stars and durations in cells, personal views' tabs and the unique values
 *   switch; their dialogs (row access,
 *   color rules, Build with AI, import, verifying a page, page webhooks, button settings, image
 *   crop, turning blocks into a page) and the feed view load when opened.
 * - `onDemandChunk`: the largest chunk loaded on demand. Lazy code is free until it is used, so
 *   there is no sum of it, but one chunk is still downloaded whole when it is: the Mermaid diagram
 *   layouts (elkjs) are the largest, about 430 kB, fetched only for a diagram that uses them.
 *
 * Built-in icons cost every route about 2 kB: the icon value's reader and the component that draws
 * one, whose drawings load when one shows; the names list (for checking icons) stays out of them
 * but Settings (lib/callout-styles-parse.ts).
 *
 * What keeps first loads small: the workspace layout loads no editor (the row panel's page view is
 * lazy), database views other than table, gallery and list load when shown, and dialogs used now
 * and then (automations, import, PDF export, QR codes) load when opened. The editor loads only the
 * dictionary of the language in use, after itself: ours (Turkish, Indonesian, Thai) about 3 kB
 * each, BlockNote's (one module) about 30 kB together, English none.
 *
 * Typed dates, tags in the search box, named versions and dictation's shortcut cost a page's first
 * load about 3 kB and all first loads together about 4 kB; the grammar, the tag list, the version
 * prompt and the recorder load when used.
 *
 * Rating stars, durations, unique values and personal views in database cells and the view bar
 * cost a page's first load about 2 kB and all first loads together about 3 kB; the number format
 * menu and the sync dialogs load when opened.
 *
 * The AI chat's approval of each web call (its address shown), the invitation email limit's note
 * and the sign-in policy gate for Telegram links and API token scopes add under 1 kB to a page's
 * first load and to all first loads together.
 *
 * The chat box's toolbar menu for where answers come from, models' names and the sidebar's
 * conversations grouped by day add about 0.5 kB to both; the full-page chat's suggestions load
 * with its own route.
 *
 * A dashboard's period, the change on number widgets and view filters' quarters add about 0.5 kB
 * to a page's first load and to all first loads together.
 *
 * A table's header row and a database page's view bar kept in sight as the page scrolls add under
 * 1 kB to a page's first load and to all first loads together.
 *
 * Pivot views cost a page's first load about 0.5 kB and all first loads together under 1 kB (their
 * settings' checks, quarter grouping, the icon and text group names); the view, its settings page
 * and the published table load when shown.
 *
 * The chat box keeping its edges in line with the messages above it (it measures the list's
 * scrollbar) and growing with its text add about 0.25 kB to a page's first load and to all first
 * loads together.
 *
 * An agent's own page (its header; the chat loads with it) adds about 1.5 kB to all first loads
 * together, as a route of its own.
 *
 * Dialogs' shared parts (title bar, body, footer bar, in components/ui.tsx, which every route loads)
 * and the inbox's tabs and row actions add under 1 kB to a page's first load and about 1 kB to all
 * first loads together.
 *
 * The chat box's Thinking picker (beside the model, shown as soon as the box is) adds about 0.3 kB
 * to a page's first load.
 *
 * Grouping by text, numbers and formulas (letters, number ranges and their labels, in
 * lib/grouping.ts, which every table loads) adds about 1 kB to a page's first load and to all
 * first loads together.
 *
 * The boxes beside the agent's page and the AI chat load with what fills them; the pages' new
 * layout (lib/side-layout.ts, the agent's card) adds about 1 kB to all first loads together.
 * The lines to a chat's questions and its button back to the latest load lazily too, but
 * ChatThread, in every workspace page's first load, takes about 1 kB more to place them.
 */
const BUDGET = { routeFirstLoad: 783, firstLoadShared: 1194, onDemandChunk: 450 };

const NEXT = ".next";
const kB = (bytes: number) => bytes / 1024;

const gzipped = new Map<string, number>();
function gzipSize(file: string) {
  let size = gzipped.get(file);
  if (size === undefined) {
    size = gzipSync(readFileSync(join(NEXT, file)), { level: 9 }).length;
    gzipped.set(file, size);
  }
  return size;
}

function manifests(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return manifests(path);
    return name.endsWith("_client-reference-manifest.js") ? [path] : [];
  });
}

let buildManifest: { rootMainFiles: string[] };
try {
  buildManifest = JSON.parse(readFileSync(join(NEXT, "build-manifest.json"), "utf8"));
} catch {
  console.error("No build found in .next; run `pnpm build` first.");
  process.exit(1);
}

const firstLoad = new Set(buildManifest.rootMainFiles);
const routes: { route: string; size: number }[] = [];
for (const path of manifests(join(NEXT, "server", "app"))) {
  const sandbox: { globalThis?: unknown; __RSC_MANIFEST?: Record<string, { entryJSFiles?: Record<string, string[]> }> } = {};
  sandbox.globalThis = sandbox;
  runInNewContext(readFileSync(path, "utf8"), sandbox);
  for (const [route, manifest] of Object.entries(sandbox.__RSC_MANIFEST ?? {})) {
    const files = new Set(buildManifest.rootMainFiles);
    for (const chunks of Object.values(manifest.entryJSFiles ?? {})) chunks.forEach((chunk) => files.add(chunk));
    files.forEach((file) => firstLoad.add(file));
    routes.push({ route, size: [...files].reduce((sum, file) => sum + gzipSize(file), 0) });
  }
}
if (routes.length === 0) {
  console.error("No client reference manifests found; the build output format may have changed.");
  process.exit(1);
}

const chunkDir = join(NEXT, "static", "chunks");
const allChunks = readdirSync(chunkDir, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".js"))
  .map((name) => relative(NEXT, join(chunkDir, name)));
const missing = [...firstLoad].filter((file) => !allChunks.includes(file));
if (missing.length > 0) {
  console.error(`First-load chunks missing from ${chunkDir}: ${missing.slice(0, 3).join(", ")}; the build output format may have changed.`);
  process.exit(1);
}
const shared = [...firstLoad].reduce((sum, file) => sum + gzipSize(file), 0);
const onDemand = allChunks.filter((file) => !firstLoad.has(file)).map((file) => ({ file, size: gzipSize(file) }));
onDemand.sort((a, b) => b.size - a.size);
const onDemandTotal = onDemand.reduce((sum, chunk) => sum + chunk.size, 0);

routes.sort((a, b) => b.size - a.size);
const row = (size: number, name: string) => `  ${kB(size).toFixed(0).padStart(6)} kB  ${name}`;
console.log("Largest first loads (gzipped):");
for (const { route, size } of routes.slice(0, 8)) console.log(row(size, route));
console.log(`First-load chunks of all routes: ${kB(shared).toFixed(0)} kB in ${firstLoad.size} chunks`);
console.log("Largest chunks loaded on demand:");
for (const { file, size } of onDemand.slice(0, 5)) console.log(row(size, file));
console.log(`On demand in all: ${kB(onDemandTotal).toFixed(0)} kB in ${onDemand.length} chunks (no budget: each loads only when used)`);

const failures: string[] = [];
const largest = routes[0];
if (kB(largest.size) > BUDGET.routeFirstLoad) {
  failures.push(`${largest.route} loads ${kB(largest.size).toFixed(0)} kB, over the ${BUDGET.routeFirstLoad} kB budget`);
}
if (kB(shared) > BUDGET.firstLoadShared) {
  failures.push(`the first-load chunks of all routes are ${kB(shared).toFixed(0)} kB, over the ${BUDGET.firstLoadShared} kB budget`);
}
const biggest = onDemand[0];
if (biggest && kB(biggest.size) > BUDGET.onDemandChunk) {
  failures.push(`${biggest.file}, loaded on demand, is ${kB(biggest.size).toFixed(0)} kB, over the ${BUDGET.onDemandChunk} kB budget for one chunk`);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`Over budget: ${failure}.`);
  console.error("Load the new code lazily (or split it), or raise the budget in scripts/bundle-budget.ts if the growth is intended.");
  process.exit(1);
}
console.log(
  `Within budget (first load ${BUDGET.routeFirstLoad} kB, all first loads ${BUDGET.firstLoadShared} kB, one on-demand chunk ${BUDGET.onDemandChunk} kB).`,
);
