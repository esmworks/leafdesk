/**
 * Makes the social preview images from the desktop app's screenshot: the website's headline beside
 * the app's window, which runs off the edge. Run it again after the screenshot or the headline
 * changes.
 *
 *   pnpm tsx scripts/social-preview.ts
 *
 * Writes site/img/og.png (1200×630, the website's link preview) and .github/social-preview.png
 * (1280×640, uploaded by hand in the repository's settings under Social preview: GitHub has no
 * API for it). Reads .github/screenshots/desktop-light.png.
 *
 * Env: CHROME_PATH (default: Google Chrome on macOS).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = new URL("..", import.meta.url).pathname;

const logo = readFileSync(join(root, "site/brand/leafdesk-logo.svg"), "utf8");
const shot = readFileSync(join(root, ".github/screenshots/desktop-light.png")).toString("base64");

const html = (width: number, height: number) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body { position: relative; background: linear-gradient(90deg, #ffffff 45%, #f3f4f2 100%); color: #1f2328;
    font-family: "Inter", ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .logo { position: absolute; left: 64px; top: 68px; height: 46px; }
  .logo svg { height: 46px; width: auto; display: block; }
  h1 { position: absolute; left: 64px; top: 152px; width: 470px; margin: 0; font-size: 50px; line-height: 1.08;
    letter-spacing: -0.025em; font-weight: 700; }
  p { position: absolute; left: 64px; top: 330px; width: 470px; margin: 0; font-size: 23px; line-height: 1.45; color: #59636e; }
  .link { position: absolute; left: 64px; bottom: 52px; font-size: 20px; font-weight: 500; color: #2f7d4f; }
  img { position: absolute; left: 590px; top: 86px; width: 960px;
    filter: drop-shadow(0 18px 40px rgba(31, 35, 40, 0.16)) drop-shadow(0 0 1px rgba(31, 35, 40, 0.35)); }
</style></head><body>
<div class="logo">${logo}</div>
<h1>The open-source workspace you host yourself</h1>
<p>On your server or in the desktop app on your computer, with a built-in MCP server for AI assistants.</p>
<div class="link">github.com/esmworks/leafdesk</div>
<img src="data:image/png;base64,${shot}" alt="">
</body></html>`;

// Headless Chrome over the DevTools protocol (Node's WebSocket, no dependencies), as screenshots.ts does.
const profile = mkdtempSync(join(tmpdir(), "leafdesk-social-preview-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"]);
try {
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 15_000);
    chrome.stderr.on("data", (chunk: Buffer) => {
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on("exit", () => reject(new Error("Chrome exited")));
  });
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    const call = msg.id && pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message));
    else call.resolve(msg.result);
  });
  const send = <T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  };
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const tab = <T = Record<string, unknown>>(method: string, params: object = {}) => send<T>(method, params, sessionId);
  const ready = `document.readyState === "complete" && document.fonts.status === "loaded" && document.querySelector("img").complete`;

  for (const [width, height, out] of [
    [1200, 630, "site/img/og.png"],
    [1280, 640, ".github/social-preview.png"],
  ] as const) {
    const file = join(profile, `${width}.html`);
    writeFileSync(file, html(width, height));
    await tab("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await tab("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await tab("Page.navigate", { url: `file://${file}` });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { result } = await tab<{ result: { value?: boolean } }>("Runtime.evaluate", { expression: ready, returnByValue: true });
      if (result.value) break;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const { data } = await tab<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(root, out), Buffer.from(data, "base64"));
    console.log(`wrote ${out}`);
  }
  socket.close();
} finally {
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
