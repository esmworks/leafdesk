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

  it("is off without an address", async () => {
    const off = createGeocoder({ url: null, trusted: false });
    expect(off.enabled).toBe(false);
    await expect(off.search("anything")).rejects.toMatchObject({ code: "off" });
  });
});
