import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGeocoder, GeocoderError, placeFromResult } from "./geocoder";

// A stand-in for a Nominatim server on this machine: no request leaves it.
let server: Server;
let base = "";
const seen: { url: string; headers: IncomingMessage["headers"] }[] = [];
let answer: (url: URL) => { status: number; body: string; delayMs?: number } = () => ({ status: 200, body: "[]" });

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const { status, body, delayMs = 0 } = answer(new URL(req.url ?? "/", "http://x"));
    setTimeout(() => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const MODA = { lat: "40.9845", lon: "29.0253", display_name: "Moda, Kadıköy, İstanbul, Türkiye", name: "Moda" };

describe("geocoder", () => {
  it("reads Nominatim results as places", () => {
    expect(placeFromResult(MODA)).toEqual({ address: "Moda, Kadıköy, İstanbul, Türkiye", name: "Moda", lat: 40.9845, lng: 29.0253 });
    expect(placeFromResult({ lat: "x", lon: "1" })).toBeNull();
    expect(placeFromResult({ lat: "10", lon: "20" })).toEqual({ address: "10, 20", lat: 10, lng: 20 });
    expect(placeFromResult({ lat: "10", lon: "20", display_name: "Same", name: "Same" })).toEqual({ address: "Same", lat: 10, lng: 20 });
  });

  it("asks the search API with the query, language and a User-Agent, and caches the answer", async () => {
    answer = () => ({ status: 200, body: JSON.stringify([MODA, { lat: "bad" }]) });
    seen.length = 0;
    const geocoder = createGeocoder({ url: `${base}/`, trusted: true, intervalMs: 0, userAgent: "Leafdesk/test (+http://localhost)" });
    const places = await geocoder.search("  Moda  Kadıköy ", { userId: "u1", language: "tr" });
    expect(places).toEqual([{ address: "Moda, Kadıköy, İstanbul, Türkiye", name: "Moda", lat: 40.9845, lng: 29.0253 }]);
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0].url, "http://x");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("Moda Kadıköy");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("accept-language")).toBe("tr");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(seen[0].headers["user-agent"]).toBe("Leafdesk/test (+http://localhost)");
    // The same search again, in other case, is answered from memory.
    expect(await geocoder.search("moda kadıköy", { userId: "u1", language: "tr" })).toEqual(places);
    expect(seen).toHaveLength(1);
  });

  it("spaces requests out for the whole server and refuses when the queue gets long", async () => {
    answer = () => ({ status: 200, body: "[]" });
    const geocoder = createGeocoder({ url: base, trusted: true, intervalMs: 150, maxWaitMs: 200 });
    const started = Date.now();
    const results = await Promise.allSettled(["a", "b", "c", "d"].map((q) => geocoder.search(q)));
    // a now, b after 150 ms, c after 300 ms would wait too long, and so would d.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "rejected"]);
    expect(((results[2] as PromiseRejectedResult).reason as GeocoderError).code).toBe("busy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("limits how often one person may search", async () => {
    answer = () => ({ status: 200, body: "[]" });
    const geocoder = createGeocoder({ url: base, trusted: true, intervalMs: 0, perUserPerMinute: 2 });
    await geocoder.search("one", { userId: "u2" });
    await geocoder.search("two", { userId: "u2" });
    await expect(geocoder.search("three", { userId: "u2" })).rejects.toMatchObject({ code: "busy" });
    // Someone else still may, and answers already known cost nothing.
    await expect(geocoder.search("three", { userId: "u3" })).resolves.toEqual([]);
    await expect(geocoder.search("one", { userId: "u2" })).resolves.toEqual([]);
  });

  it("gives up on slow, broken and private servers", async () => {
    answer = () => ({ status: 200, body: "[]", delayMs: 500 });
    const slow = createGeocoder({ url: base, trusted: true, intervalMs: 0, timeoutMs: 100 });
    await expect(slow.search("slow")).rejects.toMatchObject({ code: "failed" });
    answer = () => ({ status: 500, body: "oops" });
    const broken = createGeocoder({ url: base, trusted: true, intervalMs: 0 });
    await expect(broken.search("broken")).rejects.toMatchObject({ code: "failed" });
    answer = () => ({ status: 200, body: "not json" });
    await expect(broken.search("garbled")).rejects.toMatchObject({ code: "failed" });
    // Not set on purpose (the public default), a server on a private address is never reached.
    seen.length = 0;
    answer = () => ({ status: 200, body: "[]" });
    const untrusted = createGeocoder({ url: base, trusted: false, intervalMs: 0 });
    await expect(untrusted.search("private")).rejects.toMatchObject({ code: "failed" });
    expect(seen).toHaveLength(0);
  });

  it("tries simpler spellings of an address it can't find, keeping only places in its area", async () => {
    const SAKARYA = { lat: "40.5", lon: "30.1", display_name: "Yeni Sanayi Sitesi, Pamukova, Sakarya, Türkiye" };
    const HACIISHAK = { lat: "38.9087", lon: "27.8484", display_name: "Hacıishak Mahallesi, Akhisar, Manisa, Türkiye", name: "Hacıishak Mahallesi" };
    answer = (url) => {
      const q = url.searchParams.get("q");
      if (q === "Yeni Sanayi Sitesi, Akhisar, Manisa") return { status: 200, body: JSON.stringify([SAKARYA]) };
      if (q === "Hacıishak Mahallesi, Akhisar, Manisa") return { status: 200, body: JSON.stringify([HACIISHAK]) };
      return { status: 200, body: "[]" };
    };
    seen.length = 0;
    const geocoder = createGeocoder({ url: base, trusted: true, intervalMs: 0, perUserPerMinute: 1 });
    const typed = "Hacı İshak Mah. Yeni Sanayi Sitesi No:13, 45200 Akhisar/Manisa";
    const places = await geocoder.search(typed, { userId: "u4" });
    expect(places).toEqual([{ address: "Hacıishak Mahallesi, Akhisar, Manisa, Türkiye", name: "Hacıishak Mahallesi", lat: 38.9087, lng: 27.8484 }]);
    expect(seen.map((s) => new URL(s.url, "http://x").searchParams.get("q"))).toEqual([
      typed,
      "Hacı İshak Mahallesi, Yeni Sanayi Sitesi, Akhisar, Manisa",
      "Yeni Sanayi Sitesi, Akhisar, Manisa",
      "Hacı İshak Mahallesi, Akhisar, Manisa",
      "Hacıishak Mahallesi, Akhisar, Manisa",
    ]);
    // It counted as one search, and typing it again asks nobody.
    expect(await geocoder.search(typed, { userId: "u4" })).toEqual(places);
    expect(seen).toHaveLength(5);
  });

  it("passes over another number's street and puts the place asked for before what lies in it", async () => {
    const OTHER_STREET = { lat: "38.37", lon: "27.17", display_name: "245. Sokak, Kozağaç Mahallesi, Buca, İzmir, Türkiye" };
    const SCHOOL = { lat: "38.376", lon: "27.171", display_name: "Kozağaç Ortaokulu, 250. Sokak, Kozağaç Mahallesi, Buca, İzmir, Türkiye" };
    const KOZAGAC = { lat: "38.375", lon: "27.172", display_name: "Kozağaç Mahallesi, Buca, İzmir, Türkiye", name: "Kozağaç Mahallesi" };
    answer = (url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q === "100 Sokak, Buca, İzmir") return { status: 200, body: JSON.stringify([OTHER_STREET]) };
      if (q === "Kozağaç Mahallesi, Buca, İzmir") return { status: 200, body: JSON.stringify([SCHOOL, KOZAGAC]) };
      return { status: 200, body: "[]" };
    };
    seen.length = 0;
    const geocoder = createGeocoder({ url: base, trusted: true, intervalMs: 0 });
    const [place] = await geocoder.search("Buca – Kozağaç Mah. 100. Sokak No:1, İzmir", { limit: 1 });
    expect(place).toEqual({ address: "Kozağaç Mahallesi, Buca, İzmir, Türkiye", name: "Kozağaç Mahallesi", lat: 38.375, lng: 27.172 });
    // Even for one place, each spelling asks for a few, as the first may not be the one.
    expect(seen.map((s) => new URL(s.url, "http://x").searchParams.get("limit"))).toEqual(["5", "5", "5", "5"]);
  });

  it("finds the address at a point, keeping the point itself", async () => {
    answer = (url) =>
      url.pathname === "/reverse" && url.searchParams.get("lat") === "38.418900"
        ? { status: 200, body: JSON.stringify({ lat: "38.4191", lon: "27.1287", display_name: "Konak, İzmir, Türkiye", name: "Konak Meydanı" }) }
        : { status: 200, body: JSON.stringify({ error: "Unable to geocode" }) };
    seen.length = 0;
    const geocoder = createGeocoder({ url: base, trusted: true, intervalMs: 0, perUserPerMinute: 2 });
    expect(await geocoder.reverse(38.4189, 27.1286, { userId: "u5", language: "tr" })).toEqual({ address: "Konak, İzmir, Türkiye", lat: 38.4189, lng: 27.1286 });
    const url = new URL(seen[0].url, "http://x");
    expect(url.searchParams.get("lon")).toBe("27.128600");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("accept-language")).toBe("tr");
    // A point a few centimeters off is answered from memory, at its own coordinates.
    expect(await geocoder.reverse(38.418901, 27.128601, { userId: "u5", language: "tr" })).toEqual({ address: "Konak, İzmir, Türkiye", lat: 38.418901, lng: 27.128601 });
    expect(seen).toHaveLength(1);
    // The open sea has no address; that costs a search too.
    expect(await geocoder.reverse(38.5, 26.9, { userId: "u5" })).toBeNull();
    await expect(geocoder.reverse(38.6, 26.9, { userId: "u5" })).rejects.toMatchObject({ code: "busy" });
    expect(await geocoder.reverse(91, 0)).toBeNull();
  });

  it("is off without an address", async () => {
    const off = createGeocoder({ url: null, trusted: false });
    expect(off.enabled).toBe(false);
    await expect(off.search("anything")).rejects.toMatchObject({ code: "off" });
    await expect(off.reverse(1, 2)).rejects.toMatchObject({ code: "off" });
  });
});
