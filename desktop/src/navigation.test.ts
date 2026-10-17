import assert from "node:assert/strict";
import { test } from "node:test";
import { decideNavigation, decideNewWindow, isServerPage } from "./navigation.ts";

const PAGES = "file:///Applications/Leafdesk.app/Contents/Resources/app.asar/pages/";
const SERVER = "https://leafdesk.example.com";

test("the window follows web pages, single sign-on included", () => {
  assert.equal(decideNavigation(`${SERVER}/w/abc`, PAGES), "allow");
  assert.equal(decideNavigation("https://accounts.google.com/o/oauth2/auth?x=1", PAGES), "allow");
  assert.equal(decideNavigation("http://192.168.1.20:3000/", PAGES), "allow");
});

test("only the app's own files", () => {
  assert.equal(decideNavigation(`${PAGES}app.html`, PAGES), "allow");
  assert.equal(decideNavigation("file:///etc/passwd", PAGES), "deny");
});

test("mail and phone links go to the system; other schemes nowhere", () => {
  assert.equal(decideNavigation("mailto:someone@example.test", PAGES), "external");
  assert.equal(decideNavigation("tel:+900000000", PAGES), "external");
  assert.equal(decideNavigation("javascript:alert(1)", PAGES), "deny");
  assert.equal(decideNavigation("leafdesk-evil://x", PAGES), "deny");
  assert.equal(decideNavigation("not a url", PAGES), "deny");
});

test("new windows: Leafdesk's own pages in the app, the rest in the browser", () => {
  assert.equal(decideNewWindow(`${SERVER}/w/abc/p/def`, SERVER), "window");
  assert.equal(decideNewWindow("https://example.org/", SERVER), "external");
  assert.equal(decideNewWindow("https://leafdesk.example.com.evil.test/", SERVER), "external");
  assert.equal(decideNewWindow("mailto:someone@example.test", SERVER), "external");
  assert.equal(decideNewWindow("about:blank", SERVER), "deny");
  assert.equal(decideNewWindow("file:///etc/passwd", SERVER), "deny");
  assert.equal(decideNewWindow(`${SERVER}/`, undefined), "external");
});

test("server pages, for permissions", () => {
  assert.equal(isServerPage(`${SERVER}/w/abc`, SERVER), true);
  assert.equal(isServerPage(SERVER, SERVER), true);
  assert.equal(isServerPage("http://leafdesk.example.com/", SERVER), false);
  assert.equal(isServerPage(`${PAGES}app.html`, SERVER), false);
  assert.equal(isServerPage(undefined, SERVER), false);
});
