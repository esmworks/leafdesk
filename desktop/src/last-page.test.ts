import assert from "node:assert/strict";
import { test } from "node:test";
import { pageToRemember, readLastPage, startPath } from "./last-page.ts";

const SERVER = "https://leafdesk.example.com";
const PAGE = "/w/ws_1/p/3f2b-91aa";

test("remembers a page of the server the window shows", () => {
  assert.deepEqual(pageToRemember(`${SERVER}${PAGE}`, SERVER, SERVER), { server: SERVER, path: PAGE });
  // The query and hash (an open row, a comment) aren't kept.
  assert.deepEqual(pageToRemember(`${SERVER}${PAGE}?row=r1#comment-c1`, SERVER, SERVER), { server: SERVER, path: PAGE });
  // Leafdesk on this computer is remembered as "local", whatever its port.
  assert.deepEqual(pageToRemember(`http://127.0.0.1:51234${PAGE}`, "http://127.0.0.1:51234", "local"), { server: "local", path: PAGE });
});

test("remembers nothing but a page, and nothing from elsewhere", () => {
  assert.equal(pageToRemember(`${SERVER}/`, SERVER, SERVER), null);
  assert.equal(pageToRemember(`${SERVER}/w/ws_1`, SERVER, SERVER), null);
  assert.equal(pageToRemember(`${SERVER}/w/ws_1/settings`, SERVER, SERVER), null);
  assert.equal(pageToRemember(`${SERVER}/sign-in`, SERVER, SERVER), null);
  assert.equal(pageToRemember(`https://accounts.google.com${PAGE}`, SERVER, SERVER), null);
  assert.equal(pageToRemember(`file:///Applications/Leafdesk.app/pages/index.html`, SERVER, SERVER), null);
  assert.equal(pageToRemember("not a url", SERVER, SERVER), null);
  assert.equal(pageToRemember(`${SERVER}${PAGE}`, undefined, SERVER), null);
});

test("starts on the remembered page only on the same server", () => {
  const saved = { server: SERVER, path: PAGE };
  assert.equal(startPath(saved, SERVER), PAGE);
  assert.equal(startPath(saved, "https://other.example.com"), "/");
  assert.equal(startPath(saved, "local"), "/");
  assert.equal(startPath(undefined, SERVER), "/");
  assert.equal(startPath(saved, undefined), "/");
  // A path that isn't a page (an edited settings file) isn't followed.
  assert.equal(startPath({ server: SERVER, path: "//evil.example.org/w/a/p/b" }, SERVER), "/");
  assert.equal(startPath({ server: SERVER, path: "/w/a/p/b/../../../x" }, SERVER), "/");
});

test("reads only a well-formed remembered page from the settings file", () => {
  assert.deepEqual(readLastPage({ server: SERVER, path: PAGE }), { server: SERVER, path: PAGE });
  assert.equal(readLastPage({ server: SERVER, path: "https://evil.example.org/" }), undefined);
  assert.equal(readLastPage({ server: "", path: PAGE }), undefined);
  assert.equal(readLastPage("x"), undefined);
  assert.equal(readLastPage(undefined), undefined);
});
