/**
 * Single-process server: Next.js for HTTP, Hocuspocus for realtime collaboration on /collab.
 * Keeping both in one process lets route handlers (MCP, server actions) write into open
 * documents through the collab service instead of racing the websocket clients.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import crossws from "crossws/adapters/node";
import next from "next";
import type { NextConfig } from "next";
import { CLIENT_IP_HEADER, clientIpFrom, describeTrustedProxies, trustedProxyCount } from "./src/lib/client-ip";
import { applySecretFiles } from "./src/lib/secret-files";
import { SITE_ANALYTICS_HEADER, SITE_HOST_HEADER } from "./src/lib/site";

try {
  process.loadEnvFile();
} catch {}
// A Docker install's generated secrets, where the environment sets none (lib/secret-files.ts).
applySecretFiles();

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

// Read before anything listens: in production the example secret (or a short one) stops the server
// here, instead of failing every sign-in later.
const { env } = await import("./src/lib/env");
void env.authSecret;

// Imported after env is loaded: these modules read DATABASE_URL at import time.
const { createCollab } = await import("./src/server/collab/service");
const { registerCollab } = await import("./src/server/collab/bridge");
const { flushCollab } = await import("./src/server/collab/shutdown");
const { describeMailSetup } = await import("./src/server/mail");
const { startAssignmentEmails } = await import("./src/server/assignments");
const { startShareEmails } = await import("./src/server/share-emails");
const { startFileCleanup } = await import("./src/server/files");
const { instanceStorage } = await import("./src/server/storage");

// Fails fast on a half-configured S3 setup instead of at the first upload.
console.log(`file storage: ${instanceStorage().kind}`);
const { countOwnStorageWorkspaces, startStorageMoves } = await import("./src/server/storage/moves");
if (!env.ownStorageEnabled) {
  // Turned off after workspaces connected storage of their own: they keep using it.
  const kept = await countOwnStorageWorkspaces();
  console.log(`own storage: off (OWN_STORAGE_ENABLED)${kept ? `; ${kept} workspaces keep their files in storage connected earlier` : ""}`);
} else {
  console.log("own storage: on");
}
const { startLinkPlacesBackfill, startReminders } = await import("./src/server/mentions");
const { startPageTasksBackfill } = await import("./src/server/page-tasks");
const { startPageTagsBackfill } = await import("./src/server/page-tags");
const { startSnoozes } = await import("./src/server/notifications");
const { startRowUpdates } = await import("./src/server/row-follow");
const { startPageUpdates } = await import("./src/server/page-watch");
const { startVerificationReminders } = await import("./src/server/verification");
const { startWebLinkChecks } = await import("./src/server/web-links");
const { startPageWebhooks } = await import("./src/server/page-webhooks/deliver");
const { startAuditStreams } = await import("./src/server/audit-stream");
const { startSensitiveContentScans } = await import("./src/server/sensitive-content");
const { startPageViewRetention } = await import("./src/server/page-views");
const { startDateReminders } = await import("./src/server/date-reminders");
const { startAiProperties } = await import("./src/server/ai-properties");
const { startSemanticIndex } = await import("./src/server/semantic-index");
const { startRetention } = await import("./src/server/retention");
const { startAutomations } = await import("./src/server/automations/run");
const { startDatePassedAutomations } = await import("./src/server/automations/timed");
const { startScheduledAutomations } = await import("./src/server/automations/scheduled");
const { startAgents } = await import("./src/server/agents/run");
const { startSchedules } = await import("./src/server/schedules");
// Registers what agents' schedules do when they run.
await import("./src/server/agents/schedules");
const { retentionJobEnabled } = await import("./src/lib/retention");
const { startLocalBackups } = await import("./src/server/local-backups");
const { startRowMailSync } = await import("./src/server/row-mail/sync");
const { startRowMailSender } = await import("./src/server/row-mail/send");
const { startSequences } = await import("./src/server/sequences/run");
const { startDatabaseSyncs } = await import("./src/server/jira-sync/run");
const { startTelegram } = await import("./src/server/telegram");
const { siteGate, upgradeAllowed } = await import("./src/server/site-hosts");

const { hocuspocus, service } = createCollab();
registerCollab(service);

// The desktop app's server (desktop/scripts/bundle-server.ts) comes without next.config.ts: the
// build's resolved config is used instead, as Next's standalone server does, so Next needn't compile
// the config file (with the compilers that build leaves out).
let conf: NextConfig | undefined;
if (!dev && !existsSync("next.config.ts")) {
  conf = (JSON.parse(readFileSync(".next/required-server-files.json", "utf8")) as { config: NextConfig }).config;
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(conf);
}

const app = next({ dev, hostname, port, ...(conf && { conf }) });
await app.prepare();
const handleRequest = app.getRequestHandler();
const handleNextUpgrade = app.getUpgradeHandler();

type CollabSocket = Parameters<typeof hocuspocus.handleConnection>[0];
// The Hocuspocus connection behind each websocket peer.
const connections = new WeakMap<object, ReturnType<typeof hocuspocus.handleConnection>>();

// The largest message a browser sends is its sync answer: the edits the server doesn't have yet,
// at most a whole page's document (files are uploads, so it holds their addresses, not their
// bytes). That stays far below this; anything bigger is refused before it is read in full,
// instead of the 100 MiB the websocket server would otherwise take.
const MAX_COLLAB_MESSAGE_BYTES = 16 * 1024 * 1024;

const ws = crossws({
  serverOptions: { maxPayload: MAX_COLLAB_MESSAGE_BYTES },
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
  // Overwrites whatever the client sent under these names.
  req.headers[CLIENT_IP_HEADER] = clientIpFrom(req.headers["x-forwarded-for"], req.socket.remoteAddress, trustedProxies);
  delete req.headers[SITE_HOST_HEADER];
  delete req.headers[SITE_ANALYTICS_HEADER];
  // A workspace site on a domain of its own gets its pages and nothing else (server/site-hosts.ts).
  siteGate(req.method ?? "GET", req.url ?? "/", req.headers.host)
    .then((gate) => {
      if (gate.kind === "redirect") {
        res.writeHead(308, { location: gate.location, "cache-control": "no-store" }).end();
        return;
      }
      if (gate.kind === "notFound") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Not Found");
        return;
      }
      if (gate.kind === "site") {
        req.headers[SITE_HOST_HEADER] = gate.slug;
        if (gate.analyticsId) req.headers[SITE_ANALYTICS_HEADER] = gate.analyticsId;
      }
      return handleRequest(req, res);
    })
    .catch((error) => {
      console.error(error);
      if (res.headersSent) return res.end();
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
});

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  // Upgrades skip the request handler above: the collab server reads the address from here too
  // (approved networks), so whatever the client sent under this name is overwritten here as well.
  req.headers[CLIENT_IP_HEADER] = clientIpFrom(req.headers["x-forwarded-for"], req.socket.remoteAddress, trustedProxies);
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  upgradeAllowed(req.url ?? "/", req.headers.host).then(
    (allowed) => {
      if (allowed) upgrade(req, socket, head, pathname);
      else socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    },
    () => socket.destroy(),
  );
});

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, pathname: string) {
  if (pathname === "/collab") {
    ws.handleUpgrade(req, socket, head);
  } else {
    // Next dev (HMR) websockets.
    handleNextUpgrade(req, socket, head);
  }
}

server.listen(port, hostname, () => {
  console.log(`leafdesk ready on http://localhost:${port} (${dev ? "dev" : "production"})`);
  console.log(describeMailSetup());
  console.log(describeTrustedProxies(trustedProxies));
  // The desktop app signs in to its account only once this says the port is this server's
  // (desktop/src/local-server.ts): another program may have taken it since the app found it free.
  if (env.localMode) process.send?.({ ready: port });
  // Next answers dev websocket upgrades (HMR) only after it has served a request. Browsers open one
  // websocket per host at a time, so an open tab reconnecting to HMR after a restart would otherwise
  // hang there and hold back its collab connection.
  if (dev) fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }).catch(() => {});
  startAssignmentEmails();
  startShareEmails();
  startFileCleanup();
  startStorageMoves();
  startReminders();
  // Links indexed before "Linked from" kept each linking block get theirs, then this stops.
  startLinkPlacesBackfill();
  // To-dos in pages written before My tasks listed them, and in restores of older backups.
  startPageTasksBackfill();
  // Reads the #tags of pages written before tags were indexed, and of restored workspaces.
  startPageTagsBackfill();
  // Reminds rows' people ahead of the dates of date properties that have a reminder.
  startDateReminders();
  // Brings snoozed notifications back to the inbox when their time comes.
  startSnoozes();
  // Tells rows' followers what someone changed, once they leave the row alone for a minute.
  startRowUpdates();
  startPageUpdates();
  // Tells verifiers a few days before their verification of a page ends, and when it ends.
  startVerificationReminders();
  // Fetches the web addresses in pages that Settings > Health asked about, to find broken links.
  startWebLinkChecks();
  // Sends what happens to pages to the workspaces' page webhooks, and retries them.
  startPageWebhooks();
  // Streams new audit events to the addresses workspaces' owners set, and retries them.
  startAuditStreams();
  // Scans changed pages and rows of workspaces that detect sensitive content.
  startSensitiveContentScans();
  // Deletes page views older than a year (analytics only keep that long).
  startPageViewRetention();
  // Logs the AI provider (or that AI is off) and follows row changes for auto-updating AI values.
  startAiProperties();
  startSemanticIndex();
  // Runs database automations queued by row writes, and retries their webhooks.
  startAutomations();
  // Queues the runs of "date passed" automations for rows whose date has come, every few minutes.
  startDatePassedAutomations();
  // Queues the runs of scheduled automations as their schedules come round.
  startScheduledAutomations();
  // Runs agents that automations queued, a few at a time, apart from the automations.
  startAgents();
  // Adds rows from repeating row templates as they fall due (and one for any missed while down).
  startSchedules();
  // Deletes pages whose time in the trash is up, and old page history, once a day. Only in
  // production unless asked for: a dev server shouldn't quietly delete a developer's data.
  if (retentionJobEnabled(process.env.RETENTION_JOB, dev)) startRetention();
  // On the desktop app's computer: backs its workspaces up into the folder it picked, once a day.
  startLocalBackups();
  // Reads members' mailboxes for mail that belongs on rows, and sends what was written on rows.
  startRowMailSync();
  startRowMailSender();
  startSequences();
  // Keeps databases synced from Jira and GitHub in step, each as often as it was set to.
  startDatabaseSyncs();
  // Answers people's questions to the AI chat from Telegram, when the server has a bot.
  startTelegram();
});

let shuttingDown = false;
async function shutdown() {
  shuttingDown = true;
  // No new requests or websockets; open ones finish or are closed below.
  server.close();
  // Writes the edits still waiting for their debounced save, and waits for them.
  if (!(await flushCollab(hocuspocus))) console.error("[collab] exiting before every open page was saved");
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // A second Ctrl+C doesn't wait for the saves.
    if (shuttingDown) process.exit(1);
    void shutdown();
  });
}
// The desktop app runs this server as its child (desktop/src/local-server.ts) and asks it to stop
// with a message, as Windows has no SIGTERM; a child whose app is gone (it crashed) stops too.
if (process.send) {
  process.on("message", (message) => {
    if (message === "shutdown" && !shuttingDown) void shutdown();
  });
  process.on("disconnect", () => {
    if (!shuttingDown) void shutdown();
  });
}
