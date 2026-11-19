/**
 * Prints the Dokploy template in deploy/dokploy/leafdesk as the Base64 text Dokploy imports
 * (a Compose service → Advanced → Import), the same shape its template catalog copies:
 * `{ compose, config }` as JSON, in Base64.
 *
 *   pnpm tsx scripts/dokploy-template.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export {};

const dir = path.join(import.meta.dirname, "..", "deploy", "dokploy", "leafdesk");
const json = JSON.stringify(
  {
    compose: readFileSync(path.join(dir, "docker-compose.yml"), "utf8"),
    config: readFileSync(path.join(dir, "template.toml"), "utf8"),
  },
  null,
  2,
);
console.log(Buffer.from(json, "utf8").toString("base64"));
