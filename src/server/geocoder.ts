import { addressQueries, liesWithin } from "@/lib/address-query";
import { env } from "@/lib/env";
import { formatCoordinates, MAX_PLACE_ADDRESS, MAX_PLACE_NAME, type PlaceValue } from "@/lib/place";
import { APP_INFO } from "./app-info";
import { fetchRemoteFile, isBlockedAddress, readRemoteText, RemoteFetchError } from "./remote-fetch";

/**
 * Looks addresses and place names up for place properties, through a Nominatim-compatible search
 * API (GEOCODER_URL, OpenStreetMap's public one by default). Only the server asks it, never the
 * browser, so the service sees this server and not the people using it.
 *
 * The public service allows about one request a second for a whole application: requests from the
 * server wait their turn one second apart (and are refused once the wait would get long), each
 * person may search only so often, and answers are kept in memory for a day, so typing the same
 * address again asks nobody. The default address is reached only on public addresses; a server
 * named in GEOCODER_URL is the administrator's choice and is reached wherever it is (a geocoder
 * on the same network, say).
 *
 * The service wants every word of a search to match, so an address written as people write it
 * ("Hacı İshak Mah. … No:13, 45200 Akhisar/Manisa") finds nothing; when it doesn't, simpler
 * spellings of it are tried in turn (lib/address-query.ts), down to the district it is in.
 */

export class GeocoderError extends Error {
  constructor(
    readonly code: "off" | "busy" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "GeocoderError";
  }
}

export type GeocoderOptions = {
  /** The search API's base address; null turns geocoding off. */
  url: string | null;
  /** The base address was configured on purpose (GEOCODER_URL), so private addresses are allowed. */
  trusted: boolean;
  /** Time between two requests to the service, for the whole server. */
  intervalMs?: number;
  /** The longest a request waits for its turn before it is refused as busy. */
  maxWaitMs?: number;
  /** Searches one person may send to the service per minute (answers from the cache are free). */
  perUserPerMinute?: number;
  timeoutMs?: number;
  cacheMs?: number;
  cacheSize?: number;
  userAgent?: string;
};

const MAX_QUERY = 300;
const MAX_RESULTS = 8;
/** Searches sent to the service for one address at most: as typed, then simpler spellings. */
const MAX_TRIES = 6;
/** Nominatim answers with a few kilobytes; anything far bigger isn't an answer. */
const MAX_BYTES = 512 * 1024;

type Cached = { at: number; results: PlaceValue[] };

export type Geocoder = {
  enabled: boolean;
  /** Places matching `query`, best first; `userId` counts the search against that person. */
  search(query: string, options?: { userId?: string; language?: string; limit?: number }): Promise<PlaceValue[]>;
};

/** A place from one Nominatim search result, or null for a result without usable coordinates. */
export function placeFromResult(result: unknown): PlaceValue | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { lat?: unknown; lon?: unknown; display_name?: unknown; name?: unknown };
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const address = typeof r.display_name === "string" && r.display_name.trim() ? r.display_name.trim().slice(0, MAX_PLACE_ADDRESS) : formatCoordinates(lat, lng);
  const name = typeof r.name === "string" ? r.name.trim().slice(0, MAX_PLACE_NAME) : "";
  return { address, ...(name && name !== address ? { name } : {}), lat, lng };
}

export function createGeocoder(options: GeocoderOptions): Geocoder {
  const {
    url,
    trusted,
    intervalMs = 1000,
    maxWaitMs = 4000,
    perUserPerMinute = 30,
    timeoutMs = 5000,
    cacheMs = 24 * 60 * 60 * 1000,
    cacheSize = 2000,
    userAgent = `Leafdesk/${APP_INFO.version} (+${env.appUrl})`,
  } = options;
  const cache = new Map<string, Cached>();
  const asked = new Map<string, number[]>();
  let nextSlot = 0;

  const base = url ? url.replace(/\/+$/, "") : null;

  /** Waits for the server's next turn at the service; refuses when that is too far off. */
  async function turn() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    if (slot - now > maxWaitMs) throw new GeocoderError("busy", "Too many address searches at once; try again in a moment");
    nextSlot = slot + intervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }

  function countSearch(userId: string | undefined) {
    if (!userId) return;
    const now = Date.now();
    const recent = (asked.get(userId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= perUserPerMinute) {
      asked.set(userId, recent);
      throw new GeocoderError("busy", "Too many address searches; try again in a minute");
    }
    recent.push(now);
    asked.set(userId, recent);
    // Forget people who stopped searching, so the map doesn't grow without end.
    if (asked.size > 10_000) for (const [id, times] of asked) if (!times.some((at) => now - at < 60_000)) asked.delete(id);
  }

  function remember(key: string, results: PlaceValue[]) {
    cache.delete(key);
    cache.set(key, { at: Date.now(), results });
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value as string);
  }

  /** One request to the service, its answer kept for a day. */
  async function ask(q: string, lang: string, count: number): Promise<PlaceValue[]> {
    const key = `${lang}\u0000${count}\u0000${q.toLocaleLowerCase()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) {
      remember(key, hit.results);
      return hit.results;
    }
    await turn();
    const params = new URLSearchParams({ q, format: "jsonv2", limit: String(count) });
    if (lang) params.set("accept-language", lang);
    let text: string;
    try {
      const file = await fetchRemoteFile(`${base}/search?${params}`, {
        maxBytes: MAX_BYTES,
        timeoutMs,
        maxRedirects: 0,
        userAgent,
        accept: "application/json",
        isBlocked: trusted ? () => false : isBlockedAddress,
      });
      text = await readRemoteText(file, MAX_BYTES);
    } catch (error) {
      const reason = error instanceof RemoteFetchError ? error.message : "no answer";
      throw new GeocoderError("failed", `Address search failed: ${reason}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GeocoderError("failed", "Address search sent something that isn't JSON");
    }
    if (!Array.isArray(parsed)) throw new GeocoderError("failed", "Address search sent an unexpected answer");
    const results = parsed.flatMap((r) => placeFromResult(r) ?? []).slice(0, count);
    remember(key, results);
    return results;
  }

  return {
    enabled: base !== null,
    async search(query, { userId, language, limit = 5 } = {}) {
      if (!base) throw new GeocoderError("off", "Address search is off on this server");
      const q = query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
      if (!q) return [];
      const lang = (language ?? "").trim().slice(0, 35);
      const count = Math.min(Math.max(1, Math.floor(limit)), MAX_RESULTS);
      const key = `found\u0000${lang}\u0000${count}\u0000${q.toLocaleLowerCase()}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < cacheMs) {
        remember(key, hit.results);
        return hit.results;
      }
      // One search for the person, however many spellings of it the service is asked.
      countSearch(userId);
      const tries = addressQueries(q, MAX_TRIES);
      for (const [i, { query: spelling, within }] of tries.entries()) {
        let found: PlaceValue[];
        try {
          found = await ask(spelling, lang, count);
        } catch (error) {
          // The address as typed has its answer or its error; a simpler spelling that couldn't
          // be asked leaves the search with nothing, unremembered, so it is tried again later.
          if (i === 0) throw error;
          return [];
        }
        const results = found.filter((place) => liesWithin(place.address, within));
        if (results.length) {
          remember(key, results);
          return results;
        }
      }
      remember(key, []);
      return [];
    },
  };
}

/** GEOCODER_URL as the geocoder reads it (see env.geocoder). */
function configured() {
  return env.geocoder;
}

// Next's bundle and server.ts are separate module graphs: one geocoder (one rate limit, one
// cache) for both lives on globalThis, made again when GEOCODER_URL changes (tests).
const g = globalThis as typeof globalThis & { __leafdeskGeocoder?: { key: string; geocoder: Geocoder } };

/** The server's geocoder. */
export function geocoder(): Geocoder {
  const { url, trusted } = configured();
  const key = `${url ?? ""}|${trusted}`;
  if (g.__leafdeskGeocoder?.key !== key) g.__leafdeskGeocoder = { key, geocoder: createGeocoder({ url, trusted }) };
  return g.__leafdeskGeocoder.geocoder;
}

/** Looks one address up: the best match, or null when nothing matches. */
export async function geocodeAddress(address: string, options: { userId?: string; language?: string } = {}): Promise<PlaceValue | null> {
  const [first] = await geocoder().search(address, { ...options, limit: 1 });
  return first ?? null;
}
