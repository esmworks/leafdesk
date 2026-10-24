import assert from "node:assert/strict";
import { test } from "node:test";
import { ClosedTabs, readIcon, readSavedTabs, TabList, tabKey, tabPath, tabShortcuts, tabTitle, windowsToRestore, type KeyInput } from "./tabs.ts";

const SERVER = "https://leafdesk.example.com";

function list(...ids: number[]) {
  const tabs = new TabList();
  for (const id of ids) tabs.open(id);
  return tabs;
}

test("new tabs go last and are shown", () => {
  const tabs = list(1, 2, 3);
  assert.deepEqual(tabs.ids, [1, 2, 3]);
  assert.equal(tabs.active, 3);
});

test("links opened from a tab go right after it, in the order they were opened", () => {
  const tabs = list(1, 2, 3);
  tabs.show(1);
  tabs.open(4, { fromActive: true, show: false });
  tabs.open(5, { fromActive: true, show: false });
  assert.deepEqual(tabs.ids, [1, 4, 5, 2, 3]);
  assert.equal(tabs.active, 1);
  // Shown elsewhere and back, the next one starts again right after it.
  tabs.show(2);
  tabs.show(1);
  tabs.open(6, { fromActive: true, show: false });
  assert.deepEqual(tabs.ids, [1, 6, 4, 5, 2, 3]);
  // One opened in front is shown.
  tabs.open(7, { fromActive: true });
  assert.deepEqual(tabs.ids, [1, 6, 7, 4, 5, 2, 3]);
  assert.equal(tabs.active, 7);
});

test("closing the shown tab shows its right neighbour, else its left one", () => {
  const tabs = list(1, 2, 3);
  tabs.show(2);
  assert.equal(tabs.close(2), 3);
  assert.deepEqual(tabs.ids, [1, 3]);
  assert.equal(tabs.close(3), 1);
  assert.equal(tabs.close(1), null);
  assert.deepEqual(tabs.ids, []);
});

test("closing another tab keeps the shown one", () => {
  const tabs = list(1, 2, 3);
  tabs.show(1);
  assert.equal(tabs.close(3), 1);
  assert.equal(tabs.close(99), 1);
  assert.deepEqual(tabs.others(1), [2]);
});

test("tabs move by dragging, kept inside the strip", () => {
  const tabs = list(1, 2, 3, 4);
  tabs.move(1, 2);
  assert.deepEqual(tabs.ids, [2, 3, 1, 4]);
  tabs.move(4, 0);
  assert.deepEqual(tabs.ids, [4, 2, 3, 1]);
  tabs.move(4, 99);
  assert.deepEqual(tabs.ids, [2, 3, 1, 4]);
  tabs.move(2, -5);
  assert.deepEqual(tabs.ids, [2, 3, 1, 4]);
  tabs.move(99, 0);
  assert.deepEqual(tabs.ids, [2, 3, 1, 4]);
});

test("next and previous go round; numbers pick by place, 9 the last", () => {
  const tabs = list(1, 2, 3);
  assert.equal(tabs.neighbour(1), 1);
  assert.equal(tabs.neighbour(-1), 2);
  tabs.show(1);
  assert.equal(tabs.neighbour(-1), 3);
  assert.equal(tabs.numbered(2), 2);
  assert.equal(tabs.numbered(5), null);
  assert.equal(tabs.numbered(9), 3);
  assert.equal(new TabList().neighbour(1), null);
});

test("closed tabs come back last first, so many of them", () => {
  const closed = new ClosedTabs(2);
  closed.push({ url: `${SERVER}/w/a/p/1`, index: 0 });
  closed.push({ url: `${SERVER}/w/a/p/2`, index: 1 });
  closed.push({ url: `${SERVER}/w/a/p/3`, index: 2 });
  assert.equal(closed.size, 2);
  assert.deepEqual(closed.pop(), { url: `${SERVER}/w/a/p/3`, index: 2 });
  assert.deepEqual(closed.pop(), { url: `${SERVER}/w/a/p/2`, index: 1 });
  assert.equal(closed.pop(), undefined);
});

const press = (key: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  type: "keyDown",
  key,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...modifiers,
});

test("keys that switch tabs", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    assert.deepEqual(tabKey(press("Tab", { control: true }), platform), { kind: "next" });
    assert.deepEqual(tabKey(press("Tab", { control: true, shift: true }), platform), { kind: "previous" });
    assert.equal(tabKey(press("Tab"), platform), null);
    assert.equal(tabKey(press("Tab", { control: true, type: "keyUp" }), platform), null);
  }
  assert.deepEqual(tabKey(press("3", { meta: true }), "darwin"), { kind: "number", number: 3 });
  assert.deepEqual(tabKey(press("9", { control: true }), "win32"), { kind: "number", number: 9 });
  // The other platform's modifier, with Shift or Alt (an editor's headings), or 0 aren't taken.
  assert.equal(tabKey(press("3", { control: true }), "darwin"), null);
  assert.equal(tabKey(press("3", { meta: true }), "linux"), null);
  assert.equal(tabKey(press("3", { meta: true, alt: true }), "darwin"), null);
  assert.equal(tabKey(press("3", { meta: true, shift: true }), "darwin"), null);
  assert.equal(tabKey(press("0", { meta: true }), "darwin"), null);
  assert.deepEqual(tabKey(press("PageDown", { control: true }), "linux"), { kind: "next" });
  assert.deepEqual(tabKey(press("PageUp", { control: true }), "win32"), { kind: "previous" });
  assert.equal(tabKey(press("PageDown", { control: true }), "darwin"), null);
});

test("the menu's shortcuts", () => {
  const mac = tabShortcuts("darwin");
  assert.equal(mac.newTab, "CmdOrCtrl+T");
  assert.equal(mac.closeTab, "CmdOrCtrl+W");
  assert.equal(mac.reopenClosedTab, "CmdOrCtrl+Shift+T");
  assert.equal(mac.newWindow, "CmdOrCtrl+Shift+N");
  assert.equal(mac.nextTab, "Cmd+Shift+]");
  assert.equal(tabShortcuts("win32").nextTab, "Ctrl+Tab");
  assert.equal(tabShortcuts("linux").previousTab, "Ctrl+Shift+Tab");
  const all = Object.values(mac);
  assert.equal(new Set(all).size, all.length);
});

test("a tab keeps the path of one of the server's pages, else the home", () => {
  assert.equal(tabPath(`${SERVER}/w/ws_1/p/3f2b-91aa`, SERVER), "/w/ws_1/p/3f2b-91aa");
  assert.equal(tabPath(`${SERVER}/w/ws_1/p/3f2b-91aa?row=r1#comment-c1`, SERVER), "/w/ws_1/p/3f2b-91aa?row=r1");
  assert.equal(tabPath(`${SERVER}/w/ws_1`, SERVER), "/w/ws_1");
  assert.equal(tabPath(`${SERVER}/w/ws_1/settings?tab=members`, SERVER), "/w/ws_1/settings?tab=members");
  assert.equal(tabPath(`${SERVER}/ai`, SERVER), "/ai");
  assert.equal(tabPath(`${SERVER}/sign-in`, SERVER), "/");
  assert.equal(tabPath(`${SERVER}/api/files/x`, SERVER), "/");
  assert.equal(tabPath("https://accounts.example.org/w/ws_1", SERVER), "/");
  assert.equal(tabPath("file:///Applications/Leafdesk.app/pages/app.html", SERVER), "/");
  assert.equal(tabPath(undefined, SERVER), "/");
  assert.equal(tabPath(`${SERVER}/w/ws_1`, undefined), "/");
  assert.equal(tabPath(`${SERVER}/w/ws_1/p/x?${"a".repeat(600)}`, SERVER), "/w/ws_1/p/x");
});

test("saved tabs are read back only as such", () => {
  const saved = {
    server: SERVER,
    windows: [
      {
        tabs: [
          { path: "/w/ws_1/p/a", title: "Plans", icon: "📝" },
          { path: "https://evil.example.org/" },
          { path: "//evil.example.org/w/x" },
          { path: "/w/ws_1?row=r1", icon: "not an emoji at all" },
          { path: "/w/ws_1/p/a#x" },
          "nonsense",
        ],
        active: 2,
      },
      { tabs: [], active: 0 },
      { tabs: [{ path: "/" }], active: -1 },
    ],
  };
  assert.deepEqual(readSavedTabs(saved), {
    server: SERVER,
    windows: [
      { tabs: [{ path: "/w/ws_1/p/a", title: "Plans", icon: "📝" }, { path: "/w/ws_1?row=r1" }], active: 0 },
      { tabs: [{ path: "/" }], active: 0 },
    ],
  });
  assert.equal(readSavedTabs({ server: SERVER, windows: [] }), undefined);
  assert.equal(readSavedTabs({ windows: [{ tabs: [{ path: "/" }], active: 0 }] }), undefined);
  assert.equal(readSavedTabs("nonsense"), undefined);
  assert.equal(readSavedTabs(undefined), undefined);
});

test("the start opens the tabs saved on the same server, else one tab", () => {
  const saved = { server: SERVER, windows: [{ tabs: [{ path: "/w/a/p/1" }, { path: "/w/a/p/2" }], active: 1 }] };
  assert.deepEqual(windowsToRestore(saved, SERVER, "/"), saved.windows);
  assert.deepEqual(windowsToRestore(saved, "https://other.example.com", "/w/a/p/9"), [{ tabs: [{ path: "/w/a/p/9" }], active: 0 }]);
  assert.deepEqual(windowsToRestore(saved, undefined, "/"), [{ tabs: [{ path: "/" }], active: 0 }]);
  assert.deepEqual(windowsToRestore(undefined, SERVER, "/"), [{ tabs: [{ path: "/" }], active: 0 }]);
  // Leafdesk on this computer is "local", whatever its port.
  assert.deepEqual(windowsToRestore({ ...saved, server: "local" }, "local", "/"), saved.windows);
});

test("titles lose Leafdesk's name; icons are short emoji", () => {
  assert.equal(tabTitle("Plans · Leafdesk"), "Plans");
  assert.equal(tabTitle("Tasks · Board · Leafdesk"), "Tasks · Board");
  assert.equal(tabTitle("Leafdesk"), "Leafdesk");
  assert.equal(tabTitle("Quick note"), "Quick note");
  assert.equal(readIcon(" 📝 "), "📝");
  assert.equal(readIcon("👨‍👩‍👧‍👦"), "👨‍👩‍👧‍👦");
  assert.equal(readIcon(""), null);
  assert.equal(readIcon("a longer text than an icon"), null);
  assert.equal(readIcon(42), null);
});
