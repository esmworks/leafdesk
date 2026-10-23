// Client-safe: place values, coordinates and how they read as text (no server imports).
import type { PlaceValue } from "@/db/schema/app";

export type { PlaceValue };

/** What a map view needs to draw its map (see env.mapTiles): a tile URL template and the credit to show with it. */
export type MapTiles = { url: string; attribution: string; attributionUrl: string | null };

/** Longest address and name a place value keeps. */
export const MAX_PLACE_ADDRESS = 500;
export const MAX_PLACE_NAME = 200;

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

function validCoordinates(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Coordinates written the way people read them: up to six decimals (about 10 cm), "41.04, 29.01". */
export function formatCoordinates(lat: number, lng: number) {
  const round = (n: number) => String(Math.round(n * 1e6) / 1e6);
  return `${round(lat)}, ${round(lng)}`;
}

/**
 * Coordinates typed or pasted as text: "41.04, 29.01", "41.04 29.01", "41.04;29.01", with an
 * optional "geo:" in front, or with hemisphere letters ("41.04 N, 29.01 E", "N41.04 E29.01").
 * Latitude comes first. Null when the text isn't coordinates (an address, say).
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  let s = text.trim().replace(/^geo:/i, "").replace(/[°º]/g, "").trim();
  if (!s) return null;
  // Hemisphere letters, before or after each number.
  const hemi = /^([NS])?\s*(\d+(?:\.\d+)?)\s*([NS])?\s*[,;\s]\s*([EW])?\s*(\d+(?:\.\d+)?)\s*([EW])?$/i.exec(s);
  if (hemi && (hemi[1] || hemi[3]) && (hemi[4] || hemi[6]) && !(hemi[1] && hemi[3]) && !(hemi[4] && hemi[6])) {
    const ns = (hemi[1] ?? hemi[3]).toUpperCase();
    const ew = (hemi[4] ?? hemi[6]).toUpperCase();
    const lat = Number(hemi[2]) * (ns === "S" ? -1 : 1);
    const lng = Number(hemi[5]) * (ew === "W" ? -1 : 1);
    return validCoordinates(lat, lng) ? { lat, lng } : null;
  }
  // A "geo:" URI may carry more after the coordinates (";u=35", "?z=12").
  s = s.replace(/[;?].*[a-z=].*$/i, "");
  const plain = /^([+-]?\d+(?:\.\d+)?)\s*(?:[,;]\s*|\s+)([+-]?\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!plain) return null;
  const lat = Number(plain[1]);
  const lng = Number(plain[2]);
  return validCoordinates(lat, lng) ? { lat, lng } : null;
}

/** A stored place value, or null for anything that isn't one. */
export function asPlace(value: unknown): PlaceValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<PlaceValue>;
  if (!validCoordinates(v.lat, v.lng)) return null;
  const address = typeof v.address === "string" && v.address.trim() ? v.address : formatCoordinates(v.lat, v.lng as number);
  const name = typeof v.name === "string" && v.name.trim() ? v.name : undefined;
  return { address, ...(name ? { name } : {}), lat: v.lat, lng: v.lng as number };
}

/** What a place reads as wherever values are text (filters, sorts, formulas, exports): its address. */
export function placeText(value: unknown): string {
  return asPlace(value)?.address ?? "";
}

/** What a cell shows: the place's name when it has one, else its address. */
export function placeLabel(place: PlaceValue): string {
  return place.name || place.address;
}

/** A link to the place on the OpenStreetMap website, for "Open on map". */
export function placeMapHref(place: Pick<PlaceValue, "lat" | "lng">) {
  const lat = Math.round(place.lat * 1e6) / 1e6;
  const lng = Math.round(place.lng * 1e6) / 1e6;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

export type PlaceInput =
  /** A value ready to store. */
  | { kind: "place"; place: PlaceValue }
  /** An address (or place name) to look up first; only the server can (server/geocoder). */
  | { kind: "address"; address: string; name?: string }
  | { kind: "invalid" };

/**
 * Reads a place as people, agents and the API write one: `{lat, lng, address?, name?}` (lat/lng
 * also as latitude/longitude or lon), coordinates as text ("41.04, 29.01"), or an address to look
 * up (text, or an object with an address and no coordinates).
 */
export function readPlaceInput(value: unknown): PlaceInput {
  if (typeof value === "string") {
    const text = clean(value, MAX_PLACE_ADDRESS);
    if (!text) return { kind: "invalid" };
    const coords = parseCoordinates(text);
    if (coords) return { kind: "place", place: { address: formatCoordinates(coords.lat, coords.lng), ...coords } };
    return { kind: "address", address: text };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : undefined);
  const lat = num(v.lat ?? v.latitude);
  const lng = num(v.lng ?? v.lon ?? v.longitude);
  const address = typeof v.address === "string" ? clean(v.address, MAX_PLACE_ADDRESS) : "";
  const name = typeof v.name === "string" ? clean(v.name, MAX_PLACE_NAME) : "";
  if (lat === undefined && lng === undefined) {
    if (address) return { kind: "address", address, ...(name ? { name } : {}) };
    if (name) return { kind: "address", address: name };
    return { kind: "invalid" };
  }
  if (!validCoordinates(lat, lng)) return { kind: "invalid" };
  return {
    kind: "place",
    place: { address: address || formatCoordinates(lat, lng as number), ...(name ? { name } : {}), lat, lng: lng as number },
  };
}
