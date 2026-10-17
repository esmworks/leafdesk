/**
 * The bridge for the app's own pages (pages/app.html): connecting, trusting a certificate, trying
 * again. The window keeps this preload when it moves on to the server, so the bridge only appears
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
  });
}
