import assert from "node:assert/strict";
import { test } from "node:test";
import { addressCandidates, followsRedirect, hostOf, isLeafdeskManifest, isSecureOrigin, needsHttpConfirmation, warnsInsecure } from "./server-address.ts";

test("an address without a scheme tries HTTPS first, then plain HTTP", () => {
  assert.deepEqual(addressCandidates("leafdesk.example.com"), ["https://leafdesk.example.com", "http://leafdesk.example.com"]);
  assert.deepEqual(addressCandidates("  192.168.1.20:3000 "), ["https://192.168.1.20:3000", "http://192.168.1.20:3000"]);
});

test("this computer itself is tried over plain HTTP first", () => {
  assert.deepEqual(addressCandidates("localhost:3000"), ["http://localhost:3000", "https://localhost:3000"]);
  assert.deepEqual(addressCandidates("127.0.0.1:3000"), ["http://127.0.0.1:3000", "https://127.0.0.1:3000"]);
  assert.deepEqual(addressCandidates("[::1]:3000"), ["http://[::1]:3000", "https://[::1]:3000"]);
});

test("a scheme someone typed is kept, and a pasted path is dropped", () => {
  assert.deepEqual(addressCandidates("http://leafdesk.example.com"), ["http://leafdesk.example.com"]);
  assert.deepEqual(addressCandidates("https://leafdesk.example.com/w/abc?x=1"), ["https://leafdesk.example.com"]);
  assert.deepEqual(addressCandidates("HTTPS://Leafdesk.Example.com:443/"), ["https://leafdesk.example.com"]);
});

test("what isn't a web address", () => {
  for (const input of ["", "   ", "not an address", "ftp://leafdesk.example.com", "javascript://x", "file:///etc"]) {
    assert.equal(addressCandidates(input), null, input);
  }
});

test("plain HTTP away from this computer is warned about", () => {
  assert.equal(warnsInsecure("http://192.168.1.20:3000"), true);
  assert.equal(warnsInsecure("http://localhost:3000"), false);
  assert.equal(warnsInsecure("http://[::1]:3000"), false);
  assert.equal(warnsInsecure("leafdesk.example.com"), false);
  assert.equal(warnsInsecure("https://leafdesk.example.com"), false);
});

test("plain HTTP the app tried by itself is confirmed first, away from this computer", () => {
  assert.equal(needsHttpConfirmation("leafdesk.example.com", "http://leafdesk.example.com"), true);
  assert.equal(needsHttpConfirmation("192.168.1.20:3000", "http://192.168.1.20:3000"), true);
  // Typed with its scheme: the page warned already.
  assert.equal(needsHttpConfirmation("  HTTP://leafdesk.example.com", "http://leafdesk.example.com"), false);
  assert.equal(needsHttpConfirmation("leafdesk.example.com", "https://leafdesk.example.com"), false);
  assert.equal(needsHttpConfirmation("localhost:3000", "http://localhost:3000"), false);
  assert.equal(needsHttpConfirmation("127.0.0.1:3000", "http://127.0.0.1:3000"), false);
});

test("redirects the app follows by itself while it looks for the server", () => {
  assert.equal(followsRedirect("http://leafdesk.example.com", "https://leafdesk.example.com"), true);
  assert.equal(followsRedirect("https://leafdesk.example.com", "https://leafdesk.example.com:8443"), true);
  assert.equal(followsRedirect("http://192.168.1.20", "http://192.168.1.20:3000"), true);
  assert.equal(followsRedirect("https://localhost:3443", "http://localhost:3000"), true);
  // Another host, or down to plain HTTP: the person confirms it.
  assert.equal(followsRedirect("https://leafdesk.example.com", "https://evil.example.org"), false);
  assert.equal(followsRedirect("http://leafdesk.example.com", "https://www.leafdesk.example.com"), false);
  assert.equal(followsRedirect("https://leafdesk.example.com", "http://leafdesk.example.com"), false);
  assert.equal(followsRedirect("https://leafdesk.example.com", "ftp://leafdesk.example.com"), false);
});

test("secure origins", () => {
  assert.equal(isSecureOrigin("https://leafdesk.example.com"), true);
  assert.equal(isSecureOrigin("http://localhost:3000"), true);
  assert.equal(isSecureOrigin("http://192.168.1.20:3000"), false);
});

test("hosts and manifests", () => {
  assert.equal(hostOf("https://leafdesk.example.com:8443"), "leafdesk.example.com:8443");
  assert.equal(isLeafdeskManifest({ name: "Leafdesk", short_name: "Leafdesk" }), true);
  assert.equal(isLeafdeskManifest({ name: "Something else" }), false);
  assert.equal(isLeafdeskManifest(null), false);
});
