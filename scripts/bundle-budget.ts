// Fails when the JavaScript a browser downloads grows past the budgets below. Run after `pnpm build`:
//   pnpm tsx scripts/bundle-budget.ts
// A route's first load is the chunks its client reference manifest lists for its layouts, page and
// error boundaries, plus the runtime every page loads (build-manifest.json's rootMainFiles). Sizes
// are gzipped, as served. Raise a budget on purpose, in the same commit as the change that needs it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

/** Gzipped kB. The largest first load of any route, and every client chunk of the build together. */
const BUDGET = { routeFirstLoad: 800, allClientJs: 3150 };

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

const routes: { route: string; size: number }[] = [];
for (const path of manifests(join(NEXT, "server", "app"))) {
  const sandbox: { globalThis?: unknown; __RSC_MANIFEST?: Record<string, { entryJSFiles?: Record<string, string[]> }> } = {};
  sandbox.globalThis = sandbox;
  runInNewContext(readFileSync(path, "utf8"), sandbox);
  for (const [route, manifest] of Object.entries(sandbox.__RSC_MANIFEST ?? {})) {
    const files = new Set(buildManifest.rootMainFiles);
    for (const chunks of Object.values(manifest.entryJSFiles ?? {})) chunks.forEach((chunk) => files.add(chunk));
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
const allClientJs = allChunks.reduce((sum, file) => sum + gzipSize(file), 0);

routes.sort((a, b) => b.size - a.size);
console.log("Largest first loads (gzipped):");
for (const { route, size } of routes.slice(0, 8)) console.log(`  ${kB(size).toFixed(0).padStart(6)} kB  ${route}`);
console.log(`All client JavaScript: ${kB(allClientJs).toFixed(0)} kB in ${allChunks.length} chunks`);

const failures: string[] = [];
const largest = routes[0];
if (kB(largest.size) > BUDGET.routeFirstLoad) {
  failures.push(`${largest.route} loads ${kB(largest.size).toFixed(0)} kB, over the ${BUDGET.routeFirstLoad} kB budget`);
}
if (kB(allClientJs) > BUDGET.allClientJs) {
  failures.push(`all client JavaScript is ${kB(allClientJs).toFixed(0)} kB, over the ${BUDGET.allClientJs} kB budget`);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`Over budget: ${failure}.`);
  console.error("Load the new code lazily, or raise the budget in scripts/bundle-budget.ts if the growth is intended.");
  process.exit(1);
}
console.log(`Within budget (first load ${BUDGET.routeFirstLoad} kB, all ${BUDGET.allClientJs} kB).`);
