/**
 * The bridge for the app's own pages (pages/app.html): connecting, trusting a certificate, trying
 * again, starting Leafdesk on this computer. The window keeps this preload when it moves on to the server, so the bridge only appears
 * on the app's own file pages; the main process checks the sender again (main.ts).
 * A sandboxed preload is CommonJS, hence `require`.
 */
const { contextBridge, ipcRenderer } = require("electron") as typeof Electron.CrossProcessExports;

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("leafdesk", {
    state: () => ipcRenderer.invoke("leafdesk:state"),
    connect: (address: string, force: boolean) => ipcRenderer.invoke("leafdesk:connect", address, force),
    trust: (host: string, fingerprint: string) => ipcRenderer.invoke("leafdesk:trust", host, fingerprint),
    retry: () => ipcRenderer.invoke("leafdesk:retry"),
    startLocal: () => ipcRenderer.invoke("leafdesk:local"),
  });
}

/**
 * Every page, the server's too, learns where the window's buttons are through attributes on
 * `<html>` alone; nothing is exposed to its scripts. `data-window-controls="inset"`: macOS, no title
 * bar, the buttons over the page's top-left corner (main.ts); `data-full-screen`: they are hidden.
 */
const controls = process.argv.find((arg) => arg.startsWith("--leafdesk-window-controls="))?.split("=")[1];
if (controls) {
  let fullScreen = false;
  const mark = () => {
    const root = document.documentElement;
    if (!root) return;
    if (root.dataset.windowControls !== controls) root.dataset.windowControls = controls;
    if (root.hasAttribute("data-full-screen") !== fullScreen) root.toggleAttribute("data-full-screen", fullScreen);
  };
  // The preload runs before the page's <html> exists, and a page recovering from an error may
  // render <html> again without the attributes.
  new MutationObserver(mark).observe(document, { childList: true });
  new MutationObserver(mark).observe(document, { subtree: true, attributeFilter: ["data-window-controls", "data-full-screen"] });
  mark();
  ipcRenderer.on("leafdesk:full-screen", (_event, value: unknown) => {
    fullScreen = value === true;
    mark();
  });
}
