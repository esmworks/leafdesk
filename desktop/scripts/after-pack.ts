/**
 * electron-builder's afterPack (electron-builder.yml), before the app is signed:
 *
 * - puts the Leafdesk server local mode runs, made by scripts/bundle-server.ts (pnpm server), into
 *   the app's resources. Not as extraResources: electron-builder leaves out a resource's
 *   node_modules, which the server needs;
 * - leaves only the PostgreSQL of the app's platform, of the five installed. The Mac's binaries are
 *   universal: both Mac apps keep the same one (src/local-db.ts takes either).
 */
import fs from "node:fs";
import path from "node:path";
import { Arch, type AfterPackContext } from "electron-builder";

export default function afterPack({ appOutDir, packager, electronPlatformName, arch }: AfterPackContext) {
  const resources = packager.getResourcesDir(appOutDir);
  const server = path.join(import.meta.dirname, "..", "server");
  if (!fs.existsSync(path.join(server, "server.mjs"))) throw new Error("No server to package: run pnpm server first");
  fs.cpSync(server, path.join(resources, "server"), { recursive: true, verbatimSymlinks: true });

  const own = { darwin: "darwin-arm64", win32: "windows-x64" }[electronPlatformName] ?? `${electronPlatformName}-${Arch[arch]}`;
  const postgres = path.join(resources, "app.asar.unpacked", "node_modules", "@embedded-postgres");
  if (!fs.existsSync(path.join(postgres, own))) throw new Error(`PostgreSQL for this app (@embedded-postgres/${own}) isn't installed`);
  for (const other of fs.readdirSync(postgres)) if (other !== own) fs.rmSync(path.join(postgres, other), { recursive: true });
}
