/**
 * The bridges for the app's own pages: pages/app.html (connecting, trusting a certificate, trying
 * again, starting Leafdesk on this computer) and pages/tabs.html (the tab strip). A tab keeps this
 * preload when it moves on to the server, so the bridges only appear on the app's own file pages;
 * the main process checks the sender again (main.ts, windows.ts).
 * A sandboxed preload is CommonJS, hence `require`.
 */
const { contextBridge, ipcRenderer } = require("electron") as typeof Electron.CrossProcessExports;

if (location.protocol === "file:" && location.pathname.endsWith("/tabs.html")) {
  contextBridge.exposeInMainWorld("leafdeskTabs", {
    onState: (listener: (state: unknown) => void) => {
      ipcRenderer.on("leafdesk:tabs", (_event, state: unknown) => listener(state));
    },
    show: (id: number) => ipcRenderer.send("leafdesk:tab", "show", id),
    close: (id: number) => ipcRenderer.send("leafdesk:tab", "close", id),
    move: (id: number, index: number) => ipcRenderer.send("leafdesk:tab", "move", id, index),
    menu: (id: number) => ipcRenderer.send("leafdesk:tab", "menu", id),
    add: () => ipcRenderer.send("leafdesk:tab", "add"),
    back: () => ipcRenderer.send("leafdesk:tab", "back"),
    forward: () => ipcRenderer.send("leafdesk:tab", "forward"),
    focus: () => ipcRenderer.send("leafdesk:tab", "focus"),
  });
} else if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("leafdesk", {
    state: () => ipcRenderer.invoke("leafdesk:state"),
    connect: (address: string, accepted: string[]) => ipcRenderer.invoke("leafdesk:connect", address, accepted),
    trust: (host: string, fingerprint: string) => ipcRenderer.invoke("leafdesk:trust", host, fingerprint),
    retry: () => ipcRenderer.invoke("leafdesk:retry"),
    startLocal: () => ipcRenderer.invoke("leafdesk:local"),
  });
} else {
  /**
   * The server's pages learn they are in the app through `<html data-desktop-app>` (the web app
   * then doesn't offer to open its pages here; on macOS also `data-tab-strip`, below), and tell the
   * tab strip their icon, a page setting `<html data-page-icon>` (components/page/page-view.tsx),
   * and where it may lie over them, `<html data-tab-strip-room>` (components/desktop-tab-strip.tsx).
   * Nothing is exposed to their scripts.
   */
  let icon: string | null = null;
  let room: string | null = null;
  const mark = () => {
    const root = document.documentElement;
    if (!root) return;
    if (!root.hasAttribute("data-desktop-app")) root.setAttribute("data-desktop-app", "");
    const nextIcon = root.getAttribute("data-page-icon");
    if (nextIcon !== icon) {
      icon = nextIcon;
      ipcRenderer.send("leafdesk:page-icon", nextIcon ?? "");
    }
    const nextRoom = root.getAttribute("data-tab-strip-room");
    if (nextRoom !== null && nextRoom !== room) {
      room = nextRoom;
      ipcRenderer.send("leafdesk:strip-room", nextRoom);
    }
  };
  // The preload runs before the page's <html> exists, and a page recovering from an error may
  // render <html> again without the attribute.
  new MutationObserver(mark).observe(document, { childList: true });
  new MutationObserver(mark).observe(document, { subtree: true, attributeFilter: ["data-desktop-app", "data-page-icon", "data-tab-strip-room"] });
  mark();
  // A page that isn't Leafdesk's (an error of a proxy before it, say) never tells: the strip goes above it.
  document.addEventListener("DOMContentLoaded", () => {
    if (room === null && !document.querySelector("[data-window-drag]")) ipcRenderer.send("leafdesk:strip-room", "none");
  });
}

/**
 * The tab strip and the server's pages learn where the window's buttons are through attributes on
 * their `<html>`: macOS, no title bar, the buttons at the window's top-left corner (main.ts). The
 * strip gets `data-window-controls="inset"` and keeps room for them when it starts there; a page
 * gets `data-tab-strip`: the strip lies over it beside its sidebar, the buttons over the sidebar's
 * first row (the web app's globals.css), and `data-tab-strip-shell`: the strip is drawn in the
 * shell's gray, so the page may sit on a card below it. `data-full-screen`: the buttons are hidden.
 */
const controls = process.argv.find((arg) => arg.startsWith("--leafdesk-window-controls="))?.split("=")[1];
const marked = location.protocol !== "file:" ? "data-tab-strip" : location.pathname.endsWith("/tabs.html") ? "data-window-controls" : null;
if (controls && marked) {
  let fullScreen = ipcRenderer.sendSync("leafdesk:full-screen") === true;
  const mark = () => {
    const root = document.documentElement;
    if (!root) return;
    if (root.getAttribute(marked) !== controls) root.setAttribute(marked, controls);
    if (marked === "data-tab-strip" && !root.hasAttribute("data-tab-strip-shell")) root.setAttribute("data-tab-strip-shell", "");
    if (root.hasAttribute("data-full-screen") !== fullScreen) root.toggleAttribute("data-full-screen", fullScreen);
  };
  new MutationObserver(mark).observe(document, { childList: true });
  new MutationObserver(mark).observe(document, { subtree: true, attributeFilter: [marked, "data-tab-strip-shell", "data-full-screen"] });
  mark();
  ipcRenderer.on("leafdesk:full-screen", (_event, value: unknown) => {
    fullScreen = value === true;
    mark();
  });
}
