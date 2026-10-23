import assert from "node:assert/strict";
import { test } from "node:test";
import { activeShortcut, aiChatPath, defaultShortcut, readShortcut, shortcutChoices, shortcutLabel, workspaceIn } from "./global-shortcut.ts";

const SERVER = "https://leafdesk.example.com";

test("the default is Cmd+Shift+J on macOS and Ctrl+Shift+J elsewhere", () => {
  assert.equal(defaultShortcut("darwin"), "Command+Shift+J");
  assert.equal(defaultShortcut("win32"), "Control+Shift+J");
  assert.equal(defaultShortcut("linux"), "Control+Shift+J");
  assert.equal(shortcutChoices("darwin")[0], defaultShortcut("darwin"));
  assert.deepEqual(shortcutChoices("win32"), ["Control+Shift+J", "Control+Shift+Space", "Control+Alt+L"]);
});

test("a stored shortcut is kept only if it is one of the choices or off", () => {
  assert.equal(readShortcut("Command+Shift+Space", "darwin"), "Command+Shift+Space");
  assert.equal(readShortcut("off", "linux"), "off");
  assert.equal(readShortcut("Control+Shift+Space", "darwin"), undefined);
  assert.equal(readShortcut("Control+Shift+K", "win32"), undefined);
  assert.equal(readShortcut(42, "win32"), undefined);
  assert.equal(readShortcut(undefined, "win32"), undefined);
});

test("the shortcut registered for a setting", () => {
  assert.equal(activeShortcut(undefined, "darwin"), "Command+Shift+J");
  assert.equal(activeShortcut("off", "darwin"), null);
  assert.equal(activeShortcut("Control+Alt+L", "linux"), "Control+Alt+L");
  assert.equal(activeShortcut("nonsense", "linux"), "Control+Shift+J");
});

test("how the menu shows a shortcut", () => {
  assert.equal(shortcutLabel("Command+Shift+J", "darwin"), "⇧⌘J");
  assert.equal(shortcutLabel("Command+Option+L", "darwin"), "⌥⌘L");
  assert.equal(shortcutLabel("Command+Shift+Space", "darwin"), "⇧⌘Space");
  assert.equal(shortcutLabel("Control+Shift+J", "win32"), "Ctrl+Shift+J");
  assert.equal(shortcutLabel("Control+Alt+L", "linux"), "Ctrl+Alt+L");
});

test("the workspace the window is in", () => {
  assert.equal(workspaceIn(`${SERVER}/w/abc/p/def?row=1`, SERVER), "abc");
  assert.equal(workspaceIn(`${SERVER}/w/abc`, SERVER), "abc");
  assert.equal(workspaceIn(`${SERVER}/w/a%20b/ai`, SERVER), "a b");
  assert.equal(workspaceIn(`${SERVER}/account`, SERVER), undefined);
  assert.equal(workspaceIn(`${SERVER}/`, SERVER), undefined);
  assert.equal(workspaceIn("https://elsewhere.example.org/w/abc", SERVER), undefined);
  assert.equal(workspaceIn("file:///Applications/Leafdesk.app/pages/app.html", SERVER), undefined);
  assert.equal(workspaceIn(`${SERVER}/w/%E0%A4%A/p`, SERVER), undefined);
  assert.equal(workspaceIn("not a url", SERVER), undefined);
});

test("the server's address for AI chat", () => {
  assert.equal(aiChatPath(), "/ai");
  assert.equal(aiChatPath("abc"), "/ai?workspace=abc");
  assert.equal(aiChatPath("a b&c"), "/ai?workspace=a+b%26c");
});
