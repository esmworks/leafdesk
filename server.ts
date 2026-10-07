/**
 * Single-process server: Next.js for HTTP, Hocuspocus for realtime collaboration on /collab.
 * Keeping both in one process lets route handlers (MCP, server actions) write into open
 * documents through the collab service instead of racing the websocket clients.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import crossws from "crossws/adapters/node";
import next from "next";
import { CLIENT_IP_HEADER, clientIpFrom, trustedProxyCount } from "./src/lib/client-ip";

try {
  process.loadEnvFile();
} catch {}

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

// Imported after env is loaded: these modules read DATABASE_URL at import time.
const { createCollab } = await import("./src/server/collab/service");
const { registerCollab } = await import("./src/server/collab/bridge");
const { describeMailSetup } = await import("./src/server/mail");
const { startAssignmentEmails } = await import("./src/server/assignments");
const { startShareEmails } = await import("./src/server/share-emails");
const { startFileCleanup } = await import("./src/server/files");
const { getStorage } = await import("./src/server/storage");

// Fails fast on a half-configured S3 setup instead of at the first upload.
console.log(`file storage: ${getStorage().kind}`);
const { startReminders } = await import("./src/server/mentions");
const { startAiProperties } = await import("./src/server/ai-properties");
const { startSemanticIndex } = await import("./src/server/semantic-index");
const { startRetention } = await import("./src/server/retention");
const { startAutomations } = await import("./src/server/automations/run");
const { startAgents } = await import("./src/server/agents/run");
const { startSchedules } = await import("./src/server/schedules");
const { retentionJobEnabled } = await import("./src/lib/retention");

const { hocuspocus, service } = createCollab();
registerCollab(service);

const app = next({ dev, hostname, port });
await app.prepare();
const handleRequest = app.getRequestHandler();
const handleNextUpgrade = app.getUpgradeHandler();

type CollabSocket = Parameters<typeof hocuspocus.handleConnection>[0];
// The Hocuspocus connection behind each websocket peer.
const connections = new WeakMap<object, ReturnType<typeof hocuspocus.handleConnection>>();

const ws = crossws({
  hooks: {
    open(peer) {
      connections.set(peer, hocuspocus.handleConnection(peer.websocket as CollabSocket, peer.request as Request));
    },
    message(peer, message) {
      connections.get(peer)?.handleMessage(message.uint8Array());
    },
    close(peer, event) {
      // 1005: closed without a status code.
      connections.get(peer)?.handleClose({ code: event.code ?? 1005, reason: event.reason ?? "" });
      connections.delete(peer);
    },
    error(peer, error) {
      console.error("collab websocket error", peer.id, error);
    },
  },
});

const trustedProxies = trustedProxyCount();

const server = createServer((req, res) => {
  // Overwrites whatever the client sent under this name.
  req.headers[CLIENT_IP_HEADER] = clientIpFrom(req.headers["x-forwarded-for"], req.socket.remoteAddress, trustedProxies);
  handleRequest(req, res).catch((error) => {
    console.error(error);
    res.statusCode = 500;
    res.end("Internal Server Error");
  });
});

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/collab") {
    ws.handleUpgrade(req, socket, head);
  } else {
    // Next dev (HMR) websockets.
    handleNextUpgrade(req, socket, head);
  }
});

server.listen(port, hostname, () => {
  console.log(`leafdesk ready on http://localhost:${port} (${dev ? "dev" : "production"})`);
  console.log(describeMailSetup());
  // Next answers dev websocket upgrades (HMR) only after it has served a request. Browsers open one
  // websocket per host at a time, so an open tab reconnecting to HMR after a restart would otherwise
  // hang there and hold back its collab connection.
  if (dev) fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }).catch(() => {});
  startAssignmentEmails();
  startShareEmails();
  startFileCleanup();
  startReminders();
  // Logs the AI provider (or that AI is off) and follows row changes for auto-updating AI values.
  startAiProperties();
  startSemanticIndex();
  // Runs database automations queued by row writes, and retries their webhooks.
  startAutomations();
  // Runs agents that automations queued, a few at a time, apart from the automations.
  startAgents();
  // Adds rows from repeating row templates as they fall due (and one for any missed while down).
  startSchedules();
  // Deletes pages whose time in the trash is up, and old page history, once a day. Only in
  // production unless asked for: a dev server shouldn't quietly delete a developer's data.
  if (retentionJobEnabled(process.env.RETENTION_JOB, dev)) startRetention();
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Persist debounced documents before exiting.
    hocuspocus.flushPendingStores();
    await new Promise((r) => setTimeout(r, 500));
    server.close();
    process.exit(0);
  });
}
