import assert from "node:assert/strict";
import { test } from "node:test";
import { decideNavigation, decideNewWindow, isServerPage, openLinkTarget, showsFile, signInReturn } from "./navigation.ts";

const PAGES = "file:///Applications/Leafdesk.app/Contents/Resources/app.asar/pages/";
const SERVER = "https://leafdesk.example.com";

test("the window follows web pages, single sign-on included", () => {
  assert.equal(decideNavigation(`${SERVER}/w/abc`, PAGES), "allow");
  assert.equal(decideNavigation("https://accounts.google.com/o/oauth2/auth?x=1", PAGES), "allow");
  assert.equal(decideNavigation("http://192.168.1.20:3000/", PAGES), "allow");
});

test("signing in to a service for a connection or storage goes to the system's browser", () => {
  const signIn = (back: string) => `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=${encodeURIComponent(back)}&state=s`;
  assert.equal(decideNavigation(signIn(`${SERVER}/api/connections/oauth/callback`), PAGES, SERVER), "external");
  assert.equal(decideNavigation(signIn(`${SERVER}/api/storage/oauth/callback`), PAGES, SERVER), "external");
  // Signing in to Leafdesk itself, or a sign-in that returns elsewhere, stays in the window.
  assert.equal(decideNavigation(signIn(`${SERVER}/api/auth/callback/google`), PAGES, SERVER), "allow");
  assert.equal(decideNavigation(signIn("https://elsewhere.example.org/api/connections/oauth/callback"), PAGES, SERVER), "allow");
  assert.equal(decideNavigation(signIn(`${SERVER}/api/connections/oauth/callback`), PAGES, undefined), "allow");
  assert.equal(decideNavigation(`${SERVER}/w/abc?redirect_uri=${encodeURIComponent(`${SERVER}/api/connections/oauth/callback`)}`, PAGES, SERVER), "allow");
});

test("the server's hand-over link brings the answer back to the server the app is on", () => {
  assert.equal(
    signInReturn("leafdesk://sign-in/connections?state=s1&code=c1&iss=https%3A%2F%2Faccounts.google.com&other=x", SERVER),
    `${SERVER}/api/connections/oauth/callback?state=s1&code=c1&iss=https%3A%2F%2Faccounts.google.com`,
  );
  assert.equal(signInReturn("leafdesk://sign-in/storage?state=s1&error=access_denied", SERVER), `${SERVER}/api/storage/oauth/callback?state=s1&error=access_denied`);
  assert.equal(signInReturn("leafdesk://sign-in/connections?state=s1&code=c1", undefined), null);
  assert.equal(signInReturn("leafdesk://sign-in/elsewhere?state=s1", SERVER), null);
  assert.equal(signInReturn("leafdesk://sign-in/constructor?state=s1", SERVER), null);
  assert.equal(signInReturn("leafdesk://other/connections?state=s1", SERVER), null);
  assert.equal(signInReturn("https://evil.example.org/sign-in/connections?state=s1", SERVER), null);
  assert.equal(signInReturn("not a url", SERVER), null);
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

test("new windows: Leafdesk's own pages in a tab of the app, the rest in the browser", () => {
  assert.equal(decideNewWindow(`${SERVER}/w/abc/p/def`, SERVER), "tab");
  assert.equal(decideNewWindow("https://example.org/", SERVER), "external");
  assert.equal(decideNewWindow("https://leafdesk.example.com.evil.test/", SERVER), "external");
  assert.equal(decideNewWindow("mailto:someone@example.test", SERVER), "external");
  assert.equal(decideNewWindow("about:blank", SERVER), "deny");
  assert.equal(decideNewWindow("file:///etc/passwd", SERVER), "deny");
  assert.equal(decideNewWindow(`${SERVER}/`, undefined), "external");
});

test("files open in a window with the system's title bar, pages without", () => {
  assert.equal(showsFile(`${SERVER}/api/files/abc`), true);
  assert.equal(showsFile(`${SERVER}/api/ai/chat/files/abc?download=1`), true);
  assert.equal(showsFile(`${SERVER}/w/abc/p/def`), false);
  assert.equal(showsFile(`${SERVER}/apiary`), false);
  assert.equal(showsFile("not a url"), false);
});

test("server pages, for permissions", () => {
  assert.equal(isServerPage(`${SERVER}/w/abc`, SERVER), true);
  assert.equal(isServerPage(SERVER, SERVER), true);
  assert.equal(isServerPage("http://leafdesk.example.com/", SERVER), false);
  assert.equal(isServerPage(`${PAGES}app.html`, SERVER), false);
  assert.equal(isServerPage(undefined, SERVER), false);
});

test("a link to open a page in the app opens only the server's own pages", () => {
  const open = (url: string) => `leafdesk://open?url=${encodeURIComponent(url)}`;
  assert.equal(openLinkTarget(open(`${SERVER}/w/abc/p/def`), SERVER), `${SERVER}/w/abc/p/def`);
  assert.equal(openLinkTarget(open(`${SERVER}/w/abc/p/def?row=r1#comment-c1`), SERVER), `${SERVER}/w/abc/p/def?row=r1#comment-c1`);
  assert.equal(openLinkTarget(open("http://127.0.0.1:51234/w/abc"), "http://127.0.0.1:51234"), "http://127.0.0.1:51234/w/abc");
  // Another server, or the same host by another scheme or port, isn't opened.
  assert.equal(openLinkTarget(open("https://evil.example.org/w/abc"), SERVER), null);
  assert.equal(openLinkTarget(open("http://leafdesk.example.com/w/abc"), SERVER), null);
  assert.equal(openLinkTarget(open("https://leafdesk.example.com:8443/w/abc"), SERVER), null);
  assert.equal(openLinkTarget(open("https://leafdesk.example.com.evil.test/w/abc"), SERVER), null);
  assert.equal(openLinkTarget(open(`https://someone:secret@leafdesk.example.com/w/abc`), SERVER), null);
  // Nothing but a web address of it, and only with a server to compare.
  assert.equal(openLinkTarget(open("javascript:alert(1)"), SERVER), null);
  assert.equal(openLinkTarget(open("file:///etc/passwd"), SERVER), null);
  assert.equal(openLinkTarget("leafdesk://open", SERVER), null);
  assert.equal(openLinkTarget("leafdesk://open?url=not%20a%20url", SERVER), null);
  assert.equal(openLinkTarget(open(`${SERVER}/w/abc`), undefined), null);
  assert.equal(openLinkTarget(`leafdesk://sign-in/connections?url=${encodeURIComponent(`${SERVER}/w/abc`)}`, SERVER), null);
  assert.equal(openLinkTarget(`https://leafdesk.example.com/open?url=${encodeURIComponent(`${SERVER}/w/abc`)}`, SERVER), null);
});
