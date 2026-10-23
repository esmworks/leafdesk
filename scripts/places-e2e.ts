/**
 * End-to-end check of place properties and map views against the database, with a stand-in
 * address search (a Nominatim-compatible server this script runs on 127.0.0.1): an address written
 * to a row is looked up and stored with its coordinates, coordinates and {lat, lng, address} are
 * taken as they are, unknown and malformed values are refused, places filter and sort by their
 * address, a map view picks the place property, and with address search off only coordinates go in.
 * Creates its own user and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/places-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. GEOCODER_URL is set
 * by the script.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

// The stand-in search service: two known places, every query recorded.
const KNOWN: Record<string, { lat: string; lon: string; display_name: string; name: string }> = {
  "galata tower": { lat: "41.0256", lon: "28.9744", display_name: "Galata Kulesi, Beyoğlu, İstanbul, Türkiye", name: "Galata Kulesi" },
  "kordon izmir": { lat: "38.4337", lon: "27.1405", display_name: "Kordon, Alsancak, Konak, İzmir, Türkiye", name: "Kordon" },
};
const queries: string[] = [];
const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  queries.push(q);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(KNOWN[q] ? [KNOWN[q]] : []));
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
process.env.GEOCODER_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { addProperty, addView, deleteProperty, getProperties, listRows, updateRowProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { PropertyValueError } = await import("@/lib/properties");

const RUN = `places-e2e-${Date.now().toString(36)}`;
const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function rejects(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    return "resolved";
  } catch (error) {
    return error instanceof PropertyValueError && error.code === code ? true : String(error);
  }
}

const owner = `${RUN}-owner`;
const workspaceId = `${RUN}-ws`;
const stored = async (rowId: string) =>
  (await db.select({ properties: page.properties }).from(page).where(eq(page.id, rowId)))[0].properties as Record<string, unknown>;

try {
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values({ workspaceId, userId: owner, role: "owner" });
  const actor = { userId: owner };
  const trips = await createPage(actor, { workspaceId, kind: "database", title: "Trips" });
  for (const prop of await getProperties(trips.id)) await deleteProperty(owner, prop.id);

  const where = await addProperty(owner, trips.id, { name: "Where", type: "place" });
  const map = await addView(owner, trips.id, { name: "Map", type: "map" });
  check(map.config.placeBy === where.id, "a new map view places rows by the place property", map.config);

  // An address is looked up and stored with its coordinates.
  const galata = await createPage(actor, { workspaceId, parentId: trips.id, title: "Galata", properties: { Where: "Galata Tower" } });
  const g = (await stored(galata.id))[where.id] as { address: string; name?: string; lat: number; lng: number };
  check(g?.lat === 41.0256 && g.lng === 28.9744 && g.address.startsWith("Galata Kulesi") && g.name === "Galata Kulesi", "an address is looked up", g);
  check(queries.includes("galata tower"), "the lookup went to the configured search service", queries);

  // Coordinates and objects go in without a lookup.
  const before = queries.length;
  const pier = await createPage(actor, { workspaceId, parentId: trips.id, title: "Pier", properties: { Where: "38.4337, 27.1405" } });
  const p = (await stored(pier.id))[where.id] as { address: string; lat: number; lng: number };
  check(p?.lat === 38.4337 && p.lng === 27.1405 && p.address === "38.4337, 27.1405", "pasted coordinates are kept as they are", p);
  const office = await createPage(actor, {
    workspaceId,
    parentId: trips.id,
    title: "Office",
    properties: { [where.id]: { lat: 39.92, lng: 32.85, address: "Kızılay, Ankara", name: "Office" } },
  });
  const o = (await stored(office.id))[where.id] as { address: string; name?: string; lat: number; lng: number };
  check(o?.address === "Kızılay, Ankara" && o.name === "Office" && o.lat === 39.92, "a {lat, lng, address} value is stored", o);
  check(queries.length === before, "coordinates and objects need no lookup", queries.slice(before));
  const nowhere = await createPage(actor, { workspaceId, parentId: trips.id, title: "Nowhere" });

  // Unknown and malformed values are refused.
  check((await rejects(() => updateRowProperties(owner, nowhere.id, { Where: "Atlantis" }), "placeNotFound")) === true, "an unknown address is refused");
  check((await rejects(() => updateRowProperties(owner, nowhere.id, { Where: { lat: 95, lng: 10 } }), "invalidPlace")) === true, "a latitude past 90 is refused");
  check((await rejects(() => updateRowProperties(owner, nowhere.id, { Where: 42 }), "invalidPlace")) === true, "a number is refused");
  await updateRowProperties(owner, pier.id, { Where: "Kordon Izmir" });
  const k = (await stored(pier.id))[where.id] as { name?: string };
  check(k?.name === "Kordon", "an edit with an address looks it up again", k);
  await updateRowProperties(owner, pier.id, { Where: null });
  check((await stored(pier.id))[where.id] == null, "a place can be cleared");

  // Filters and sorts read the address.
  const inIstanbul = await listRows(owner, trips.id, { filters: [{ propertyId: where.id, op: "contains", value: "beyoğlu" }] });
  check(inIstanbul.map((r) => r.title).join() === "Galata", "places filter on what their address contains", inIstanbul.map((r) => r.title));
  const empty = await listRows(owner, trips.id, { filters: [{ propertyId: where.id, op: "is_empty" }] });
  check(empty.map((r) => r.title).sort().join() === "Nowhere,Pier", "places filter on being empty", empty.map((r) => r.title));
  const sorted = await listRows(owner, trips.id, { sorts: [{ propertyId: where.id, direction: "asc" }] });
  check(sorted.slice(0, 2).map((r) => r.title).join() === "Galata,Office", "places sort by their address", sorted.map((r) => r.title));

  // With address search off, only coordinates go in.
  process.env.GEOCODER_URL = "";
  check((await rejects(() => updateRowProperties(owner, nowhere.id, { Where: "Galata Tower" }), "geocodingOff")) === true, "with search off an address is refused");
  await updateRowProperties(owner, nowhere.id, { Where: "geo:41.0082,28.9784" });
  const n = (await stored(nowhere.id))[where.id] as { lat: number };
  check(n?.lat === 41.0082, "with search off coordinates still go in", n);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(eq(user.id, owner));
  hocuspocus.closeConnections();
  fake.close();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
