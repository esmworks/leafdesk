/**
 * Puts the Leafdesk server that local mode runs into `server/`, for electron-builder to ship in the
 * app's resources (electron-builder.yml, extraResources). It is Next's standalone build: the
 * compiled pages and only the packages they leave external (traced by Next), with server.ts and the
 * desktop's setup (scripts/desktop-setup.ts) bundled beside it into plain JavaScript, so nothing is
 * compiled when the app starts and neither the sources nor the development tools ship. Each
 * platform's app is built on that platform.
 *
 *   node scripts/bundle-server.ts [--skip-build]
 *
 * --skip-build takes the repository's `.next` as it is, from a standalone build made before.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const repo = path.join(import.meta.dirname, "..", "..");
const out = path.join(import.meta.dirname, "..", "server");
const next = path.join(repo, ".next");

if (!process.argv.includes("--skip-build")) {
  execFileSync("pnpm", ["build"], {
    cwd: repo,
    stdio: "inherit",
    // pnpm is a .cmd script on Windows, which only a shell runs.
    shell: process.platform === "win32",
    env: {
      ...process.env,
      LEAFDESK_STANDALONE: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      // Placeholders so modules that read the environment as they load can load during the
      // build; nothing connects (as in the Dockerfile).
      DATABASE_URL: "postgres://build:build@localhost:5432/build",
      BETTER_AUTH_SECRET: "build-only-placeholder-not-used-at-runtime-000000",
    },
  });
}
if (!fs.existsSync(path.join(next, "standalone", ".next", "BUILD_ID"))) {
  throw new Error("No standalone build in .next: run without --skip-build");
}

const standalone = path.join(next, "standalone");
fs.rmSync(out, { recursive: true, force: true });
// The compiled server, without what the build put beside it that the app doesn't run: Next's own
// server.js (server.ts takes its place), the .env files Next copies in (this computer's settings and
// secrets are no app's) and sources the trace picked up. Its packages are laid out below.
fs.cpSync(path.join(standalone, ".next"), path.join(out, ".next"), {
  recursive: true,
  filter: (source) => source !== path.join(standalone, ".next", "node_modules"),
});
fs.copyFileSync(path.join(standalone, "package.json"), path.join(out, "package.json"));
// Source maps of the compiled server: most of its size, and read by nobody here.
for (const file of fs.readdirSync(path.join(out, ".next", "server"), { recursive: true, encoding: "utf8" })) {
  if (file.endsWith(".map")) fs.rmSync(path.join(out, ".next", "server", file));
}
// What a standalone build leaves to be copied: the browser's files, the public ones, and the
// migrations the setup applies.
fs.cpSync(path.join(next, "static"), path.join(out, ".next", "static"), { recursive: true });
fs.cpSync(path.join(repo, "public"), path.join(out, "public"), { recursive: true });
fs.cpSync(path.join(repo, "drizzle"), path.join(out, "drizzle"), { recursive: true });

/**
 * The standalone build's packages, laid out as plain folders: pnpm links each package to its
 * dependencies, and links don't survive an app's resources (Windows least of all). A package goes
 * to the top of node_modules unless another version of it is there, and then into the folder of the
 * package that needs it, as Node looks for it nearest first.
 *
 * The compiled pages load some packages under a name with a hash (`.next/node_modules/yjs-<hash>`),
 * linked to the same folder as the package's own name. Copied twice, the two would be two modules,
 * so such a package keeps its own name and the pages are pointed at it. Answers each hashed name's
 * name in the layout.
 */
function layOutPackages(top: string): Map<string, string> {
  const SEGMENT = `${path.sep}node_modules${path.sep}`;
  /**
   * The folder a link leads to, read link by link rather than with realpath: on Windows the build
   * copies pnpm's links to folders as links to files, which the system refuses to follow (EPERM).
   * Throws ENOENT for a link to nothing.
   */
  const resolveLink = (file: string) => {
    let at = file;
    for (let hops = 0; fs.lstatSync(at).isSymbolicLink(); hops++) {
      if (hops === 40) throw new Error(`Too many links from ${file}`);
      at = path.resolve(path.dirname(at), fs.readlinkSync(at).replace(/^\\\\\?\\/, ""));
    }
    return at;
  };
  const namesIn = (folder: string) =>
    fs
      .readdirSync(folder)
      .filter((entry) => !entry.startsWith("."))
      .flatMap((entry) => (entry.startsWith("@") ? fs.readdirSync(path.join(folder, entry)).map((name) => `${entry}/${name}`) : [entry]));
  /** pnpm keeps a package in <store>/<id>/node_modules/<name>, with its dependencies linked beside it. */
  const dependenciesOf = (source: string) => {
    const at = source.lastIndexOf(SEGMENT);
    const folder = source.slice(0, at + SEGMENT.length - 1);
    const self = source.slice(at + SEGMENT.length).split(path.sep).join("/");
    const dependencies = new Map<string, string>();
    for (const name of namesIn(folder)) {
      if (name === self) continue;
      try {
        dependencies.set(name, resolveLink(path.join(folder, name)));
      } catch (error) {
        // A dependency the build didn't trace: nothing runs it.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return dependencies;
  };

  // The image optimizer's (next.config.ts turns it off for this build), native and for this
  // processor only.
  const unused = (name: string) => name === "sharp" || name.startsWith("@img/");

  // node_modules folder → package name → the store folder put there.
  const placed = new Map<string, Map<string, string>>();
  const queue: { name: string; source: string; chain: string[] }[] = [];
  const put = (folder: string, name: string, source: string, chain: string[]) => {
    if (!placed.has(folder)) placed.set(folder, new Map());
    placed.get(folder)!.set(name, source);
    const target = path.join(folder, ...name.split("/"));
    fs.cpSync(source, target, { recursive: true, dereference: true, filter: (file) => file !== path.join(source, "node_modules") });
    const below = [path.join(target, "node_modules"), ...chain.slice(chain.indexOf(folder))];
    for (const [dependency, from] of dependenciesOf(source)) queue.push({ name: dependency, source: from, chain: below });
  };
  // Breadth first: a package's own dependencies are in place before those of the packages below it.
  const drain = () => {
    while (queue.length) {
      const { name, source, chain } = queue.shift()!;
      if (unused(name)) continue;
      const found = chain.find((folder) => placed.get(folder)?.has(name));
      if (!found) put(top, name, source, chain);
      else if (placed.get(found)!.get(name) !== source) put(chain[0], name, source, chain);
    }
  };
  const versionAt = (folder: string) => (JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8")) as { version: string }).version;
  const packages = path.join(standalone, "node_modules");
  for (const name of namesIn(packages)) queue.push({ name, source: resolveLink(path.join(packages, name)), chain: [top] });
  drain();

  const names = new Map<string, string>();
  const hashedFolder = path.join(standalone, ".next", "node_modules");
  for (const alias of namesIn(hashedFolder)) {
    const source = resolveLink(path.join(hashedFolder, alias));
    const name = alias.replace(/-[0-9a-f]{16}$/, "");
    const there = placed.get(top)?.get(name);
    // The same package can come by another path (on Windows the build copies some links' folders
    // instead): the same version is the same package, kept once with the files traced for either.
    const same = there === source || (there !== undefined && versionAt(there) === versionAt(source));
    if (there && same && there !== source) {
      fs.cpSync(source, path.join(top, ...name.split("/")), { recursive: true, dereference: true, filter: (file) => file !== path.join(source, "node_modules") });
    }
    // Another version under the plain name: this one keeps its hashed name.
    const kept = there && !same ? alias : name;
    if (!there || kept === alias) put(top, kept, source, [top]);
    drain();
    names.set(alias, kept);
  }
  return names;
}
const hashed = layOutPackages(path.join(out, "node_modules"));
// The compiled pages load those packages by the names they now have.
const renamed = [...hashed].filter(([alias, name]) => alias !== name);
if (renamed.length) {
  const pattern = new RegExp(`"(${renamed.map(([alias]) => alias.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(?=["/])`, "g");
  const names = new Map(renamed);
  for (const file of fs.readdirSync(path.join(out, ".next", "server"), { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".js")) continue;
    const full = path.join(out, ".next", "server", file);
    const code = fs.readFileSync(full, "utf8");
    const rewritten = code.replace(pattern, (_match, alias: string) => `"${names.get(alias)}`);
    if (rewritten !== code) fs.writeFileSync(full, rewritten);
  }
}

// The packages the compiled pages leave external are those laid out above; the entry points import
// the same copies, by the same names, so each is one module for both (yjs must be: the pages and the
// collaboration server share documents). Everything else the entry points import, they carry.
const { config } = JSON.parse(fs.readFileSync(path.join(next, "required-server-files.json"), "utf8")) as {
  config: { serverExternalPackages: string[] };
};
const externals = ["next", ...config.serverExternalPackages];
const layoutName = new Map([...hashed].map(([alias, name]) => [alias.replace(/-[0-9a-f]{16}$/, ""), name]));
// Checked here rather than when the app first uses them: which packages the build leaves to be laid
// out follows Next's trace, and a hashed name is one folder with its own name only where pnpm links
// them (were Next to copy one instead, the pages and server.mjs would each load their own yjs).
const versionOf = (name: string) =>
  (JSON.parse(fs.readFileSync(path.join(out, "node_modules", ...name.split("/"), "package.json"), "utf8")) as { version: string }).version;
for (const external of externals) {
  if (!fs.existsSync(path.join(out, "node_modules", ...(layoutName.get(external) ?? external).split("/")))) {
    throw new Error(`${external} is left external but isn't in server/node_modules`);
  }
}
for (const [alias, name] of hashed) {
  const plain = alias.replace(/-[0-9a-f]{16}$/, "");
  if (name === alias && versionOf(alias) === versionOf(plain)) throw new Error(`${plain} is in server/node_modules twice, as ${plain} and ${alias}`);
}
// The parts of next the entry points import (next/headers, next/navigation): the compiled pages
// carry their own, so the build's trace leaves them out. Filled in below, after the bundling.
const nextPaths = new Set<string>();
const fromRepo = createRequire(path.join(repo, "package.json"));
const nextRoot = fs.realpathSync(path.dirname(fromRepo.resolve("next/package.json")));
await build({
  entryPoints: { server: path.join(repo, "server.ts"), "desktop-setup": path.join(repo, "scripts", "desktop-setup.ts") },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  // The entry points load most of the server with import() after reading the environment, and
  // some of those modules await as they load (the translations): in one file, esbuild would load
  // them in wrappers that wait on each other forever where modules import each other; in chunks,
  // Node loads them as ES modules, as it does the sources.
  splitting: true,
  chunkNames: "chunks/[hash]",
  platform: "node",
  format: "esm",
  target: "node24",
  tsconfig: path.join(repo, "tsconfig.json"),
  plugins: [
    {
      name: "externals",
      setup(bundler) {
        bundler.onResolve({ filter: /^[^./]/ }, ({ path: request }) => {
          const name = externals.find((external) => request === external || request.startsWith(`${external}/`));
          if (!name) return;
          if (name === "next" && request !== name) nextPaths.add(request);
          const imported = (layoutName.get(name) ?? name) + request.slice(name.length);
          // An ES module names the file it imports from a package that doesn't map its paths
          // (`exports`), as next doesn't: next/navigation is next/navigation.js there.
          const file = name === "next" ? path.join(nextRoot, request.slice(name.length)) : path.join(out, "node_modules", ...imported.split("/"));
          const withExtension = request !== name && !fs.existsSync(file) && fs.existsSync(`${file}.js`);
          return { path: withExtension ? `${imported}.js` : imported, external: true };
        });
      },
    },
  ],
  logLevel: "warning",
  // Bundled CommonJS packages still call require and read __dirname, which ES modules don't have.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      'const __dirname = __filename.replace(/[\\\\/][^\\\\/]*$/, "");',
    ].join("\n"),
  },
});

// What those parts need from next, traced as Next traces its own files, is added to its folder.
{
  const { nodeFileTrace } = fromRepo("next/dist/compiled/@vercel/nft") as {
    nodeFileTrace(files: string[], options: { base: string; processCwd: string }): Promise<{ fileList: Set<string> }>;
  };
  const { fileList } = await nodeFileTrace(
    [...nextPaths].map((request) => fromRepo.resolve(request)),
    { base: repo, processCwd: repo },
  );
  for (const traced of fileList) {
    const file = fs.realpathSync(path.join(repo, traced));
    if (!file.startsWith(`${nextRoot}${path.sep}`)) continue;
    const target = path.join(out, "node_modules", "next", path.relative(nextRoot, file));
    if (!fs.existsSync(target)) fs.cpSync(file, target, { dereference: true });
  }
}

const size = (folder: string): number =>
  fs.readdirSync(folder, { withFileTypes: true }).reduce((total, entry) => {
    const full = path.join(folder, entry.name);
    return total + (entry.isDirectory() ? size(full) : entry.isFile() ? fs.statSync(full).size : 0);
  }, 0);
console.log(`server/: ${Math.round(size(out) / 1024 / 1024)} MB`);
