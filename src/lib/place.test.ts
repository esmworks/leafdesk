import { describe, expect, it } from "vitest";
import { geocoderFrom, mapTilesFrom } from "./env";
import { asPlace, formatCoordinates, parseCoordinates, placeLabel, placeMapHref, placeText, readPlaceInput } from "./place";
import { applyView, displayValue, filterOperators, normalizeValue, PropertyValueError, type RowLike } from "./properties";
import { readPropertyValue } from "./derived";

const prop = { id: "p", name: "Office", type: "place" as const, options: {} };

describe("parseCoordinates", () => {
  it("reads latitude and longitude written the usual ways", () => {
    expect(parseCoordinates("41.04, 29.01")).toEqual({ lat: 41.04, lng: 29.01 });
    expect(parseCoordinates("41.04,29.01")).toEqual({ lat: 41.04, lng: 29.01 });
    expect(parseCoordinates(" -33.8688 151.2093 ")).toEqual({ lat: -33.8688, lng: 151.2093 });
    expect(parseCoordinates("41.04;29.01")).toEqual({ lat: 41.04, lng: 29.01 });
    expect(parseCoordinates("geo:41.04,29.01")).toEqual({ lat: 41.04, lng: 29.01 });
    expect(parseCoordinates("geo:41.04,29.01;u=35")).toEqual({ lat: 41.04, lng: 29.01 });
    expect(parseCoordinates("41.04° N, 29.01° E")).toEqual({ lat: 41.04, lng: 29.01 });
    expect(parseCoordinates("33.86 S 151.2 E")).toEqual({ lat: -33.86, lng: 151.2 });
    expect(parseCoordinates("N40.7 W74")).toEqual({ lat: 40.7, lng: -74 });
  });

  it("leaves addresses and out-of-range numbers alone", () => {
    expect(parseCoordinates("Istiklal Caddesi 12, Istanbul")).toBeNull();
    expect(parseCoordinates("221B Baker Street")).toBeNull();
    expect(parseCoordinates("12345")).toBeNull();
    expect(parseCoordinates("91, 29")).toBeNull();
    expect(parseCoordinates("41, 181")).toBeNull();
    expect(parseCoordinates("")).toBeNull();
  });

  it("writes coordinates back with at most six decimals", () => {
    expect(formatCoordinates(41.0412345678, 29.0098765432)).toBe("41.041235, 29.009877");
    expect(formatCoordinates(41, -8.5)).toBe("41, -8.5");
  });
});

describe("place values", () => {
  it("reads stored values, filling in a missing address from the coordinates", () => {
    expect(asPlace({ address: "Kadıköy", lat: 40.99, lng: 29.03 })).toEqual({ address: "Kadıköy", lat: 40.99, lng: 29.03 });
    expect(asPlace({ lat: 40.99, lng: 29.03 })).toEqual({ address: "40.99, 29.03", lat: 40.99, lng: 29.03 });
    expect(asPlace({ address: "x", lat: "40", lng: 29 })).toBeNull();
    expect(asPlace("Kadıköy")).toBeNull();
    expect(placeText({ address: "Kadıköy", name: "Moda Pier", lat: 1, lng: 2 })).toBe("Kadıköy");
    expect(placeLabel({ address: "Kadıköy", name: "Moda Pier", lat: 1, lng: 2 })).toBe("Moda Pier");
    expect(placeMapHref({ lat: 41.04, lng: 29.01 })).toBe("https://www.openstreetmap.org/?mlat=41.04&mlon=29.01#map=17/41.04/29.01");
  });

  it("tells places, addresses to look up and nonsense apart", () => {
    expect(readPlaceInput("41.04, 29.01")).toEqual({ kind: "place", place: { address: "41.04, 29.01", lat: 41.04, lng: 29.01 } });
    expect(readPlaceInput("  Moda,   Kadıköy ")).toEqual({ kind: "address", address: "Moda, Kadıköy" });
    expect(readPlaceInput({ address: "Moda", name: "Pier" })).toEqual({ kind: "address", address: "Moda", name: "Pier" });
    expect(readPlaceInput({ latitude: "41", longitude: 29, address: "Somewhere" })).toEqual({
      kind: "place",
      place: { address: "Somewhere", lat: 41, lng: 29 },
    });
    expect(readPlaceInput({ lat: 41, lon: 29, name: "Office" })).toEqual({
      kind: "place",
      place: { address: "41, 29", name: "Office", lat: 41, lng: 29 },
    });
    expect(readPlaceInput({ lat: 141, lng: 29 })).toEqual({ kind: "invalid" });
    expect(readPlaceInput({ lat: 41 })).toEqual({ kind: "invalid" });
    expect(readPlaceInput(42)).toEqual({ kind: "invalid" });
    expect(readPlaceInput([41, 29])).toEqual({ kind: "invalid" });
  });

  it("stores coordinates and objects, and refuses addresses nobody looked up", () => {
    expect(normalizeValue(prop, "41.04, 29.01")).toEqual({ address: "41.04, 29.01", lat: 41.04, lng: 29.01 });
    expect(normalizeValue(prop, { lat: 41.04, lng: 29.01, address: "Office", name: "HQ", extra: 1 })).toEqual({
      address: "Office",
      name: "HQ",
      lat: 41.04,
      lng: 29.01,
    });
    expect(normalizeValue(prop, null)).toBeNull();
    expect(normalizeValue(prop, "")).toBeNull();
    expect(() => normalizeValue(prop, "Moda, Kadıköy")).toThrow(PropertyValueError);
    expect(() => normalizeValue(prop, { lat: 95, lng: 0 })).toThrow(/address, coordinates/);
    try {
      normalizeValue(prop, 12);
    } catch (error) {
      expect((error as PropertyValueError).code).toBe("invalidPlace");
    }
    expect(displayValue(prop, { address: "Office", lat: 1, lng: 2 })).toEqual({ address: "Office", lat: 1, lng: 2 });
    expect(displayValue(prop, "junk")).toBeNull();
  });

  it("filters and sorts by the address, and formulas read the address", () => {
    const row = (id: string, place: unknown): RowLike => ({
      id,
      title: id,
      properties: { p: place },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const rows = [
      row("b", { address: "Moda, Kadıköy, İstanbul", lat: 40.98, lng: 29.02 }),
      row("none", null),
      row("a", { address: "Alsancak, İzmir", name: "Office", lat: 38.43, lng: 27.14 }),
    ];
    const ids = (r: RowLike[]) => r.map((x) => x.id);
    expect(filterOperators("place").map((o) => o.op)).toEqual(["contains", "does_not_contain", "is_empty", "is_not_empty"]);
    expect(ids(applyView(rows, { filters: [{ propertyId: "p", op: "contains", value: "kadıköy" }] }, [prop]))).toEqual(["b"]);
    expect(ids(applyView(rows, { filters: [{ propertyId: "p", op: "does_not_contain", value: "alsancak" }] }, [prop]))).toEqual(["b", "none"]);
    expect(ids(applyView(rows, { filters: [{ propertyId: "p", op: "is_empty" }] }, [prop]))).toEqual(["none"]);
    expect(ids(applyView(rows, { filters: [{ propertyId: "p", op: "is_not_empty" }] }, [prop]))).toEqual(["b", "a"]);
    expect(ids(applyView(rows, { sorts: [{ propertyId: "p", direction: "asc" }] }, [prop]))).toEqual(["a", "b", "none"]);
    expect(ids(applyView(rows, { sorts: [{ propertyId: "p", direction: "desc" }] }, [prop]))).toEqual(["b", "a", "none"]);
    expect(readPropertyValue(prop, rows[0].properties.p, { now: new Date() })).toBe("Moda, Kadıköy, İstanbul");
    expect(readPropertyValue(prop, null, { now: new Date() })).toBe("");
  });
});

describe("map and geocoder settings", () => {
  it("uses OpenStreetMap's servers when unset and turns off when set empty", () => {
    expect(geocoderFrom(undefined)).toEqual({ url: "https://nominatim.openstreetmap.org", trusted: false });
    expect(geocoderFrom("")).toEqual({ url: null, trusted: false });
    expect(geocoderFrom("not a url")).toEqual({ url: null, trusted: false });
    expect(geocoderFrom("http://nominatim:8080/")).toEqual({ url: "http://nominatim:8080", trusted: true });
    expect(mapTilesFrom(undefined, undefined)).toEqual({
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
    });
    expect(mapTilesFrom("", undefined)).toBeNull();
    expect(mapTilesFrom("https://tiles.example.com/{z}/{x}.png", undefined)).toBeNull();
    expect(mapTilesFrom("https://tiles.example.com/{z}/{x}/{y}.png", "Example Maps")).toEqual({
      url: "https://tiles.example.com/{z}/{x}/{y}.png",
      attribution: "Example Maps",
      attributionUrl: null,
    });
  });
});
