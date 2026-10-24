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
    focus: () => ipcRenderer.send("leafdesk:tab", "focus"),
  });
} else if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("leafdesk", {
    state: () => ipcRenderer.invoke("leafdesk:state"),
    connect: (address: string, force: boolean) => ipcRenderer.invoke("leafdesk:connect", address, force),
    trust: (host: string, fingerprint: string) => ipcRenderer.invoke("leafdesk:trust", host, fingerprint),
    retry: () => ipcRenderer.invoke("leafdesk:retry"),
    startLocal: () => ipcRenderer.invoke("leafdesk:local"),
  });
} else {
  /**
   * The server's pages learn they are in the app through `<html data-desktop-app>` alone (the web
   * app then doesn't offer to open its pages here), and tell the tab strip their icon: a page sets
   * `<html data-page-icon>` (components/page/page-view.tsx). Nothing is exposed to their scripts.
   */
  let icon: string | null = null;
  const mark = () => {
    const root = document.documentElement;
    if (!root) return;
    if (!root.hasAttribute("data-desktop-app")) root.setAttribute("data-desktop-app", "");
    const next = root.getAttribute("data-page-icon");
    if (next === icon) return;
    icon = next;
    ipcRenderer.send("leafdesk:page-icon", next ?? "");
  };
  // The preload runs before the page's <html> exists, and a page recovering from an error may
  // render <html> again without the attribute.
  new MutationObserver(mark).observe(document, { childList: true });
  new MutationObserver(mark).observe(document, { subtree: true, attributeFilter: ["data-desktop-app", "data-page-icon"] });
  mark();
}

/**
 * The tab strip learns where the window's buttons are through attributes on its `<html>`:
 * `data-window-controls="inset"`: macOS, no title bar, the buttons at the strip's start (main.ts);
 * `data-full-screen`: they are hidden.
 */
const controls = process.argv.find((arg) => arg.startsWith("--leafdesk-window-controls="))?.split("=")[1];
if (controls) {
  let fullScreen = ipcRenderer.sendSync("leafdesk:full-screen") === true;
  const mark = () => {
    const root = document.documentElement;
    if (!root) return;
    if (root.dataset.windowControls !== controls) root.dataset.windowControls = controls;
    if (root.hasAttribute("data-full-screen") !== fullScreen) root.toggleAttribute("data-full-screen", fullScreen);
  };
  new MutationObserver(mark).observe(document, { childList: true });
  new MutationObserver(mark).observe(document, { subtree: true, attributeFilter: ["data-window-controls", "data-full-screen"] });
  mark();
  ipcRenderer.on("leafdesk:full-screen", (_event, value: unknown) => {
    fullScreen = value === true;
    mark();
  });
}
