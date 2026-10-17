/**
 * Leafdesk on this computer (local mode): a database of its own (local-db.ts) and the Leafdesk
 * server, the same server.ts a server runs, as a child process of the app, listening on 127.0.0.1
 * only. The computer has one account, made at the first start (scripts/desktop-setup.ts); the app
 * signs in to it itself, so nobody meets a sign-in page, and sign-up stays closed to anything else
 * on the computer. Nothing here needs Electron: the tests run it with plain Node.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort, startLocalDatabase } from "./local-db.ts";

/** The account's address: `.invalid` reaches nobody, and no server holds addresses there. */
export const LOCAL_EMAIL = "me@local.leafdesk.invalid";

/** How long the first page may take: a development server compiles it first. */
const READY_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 20_000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

/** What the server gets of the app's environment: what a program needs to run, nothing of the app's own. */
const PASSED_ENV = ["PATH", "PATHEXT", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "windir", "ComSpec", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TZ"];

export type LocalServerOptions = {
  /** The Leafdesk server's folder (server.ts, scripts, drizzle), where it runs. */
  serverDir: string;
  /** Where the database, the files, the secrets and the log are kept. */
  root: string;
  /** The port it had last time, kept while it is free: the pages' offline copies belong to their origin. */
  port?: number;
  /** The Node that runs the server, and what it needs in its environment (Electron's: ELECTRON_RUN_AS_NODE). */
  node: string;
  nodeEnv?: Record<string, string>;
  /** A development server (Next compiles pages as they are asked for) or a built one. */
  dev: boolean;
};

export type LocalAccount = { email: string; password: string };

export type LocalServer = {
  origin: string;
  port: number;
  account: LocalAccount;
  /** The server's and its setup's output. */
  log: string;
  /** Called when the server stops without being asked to (it crashed). */
  onExit(listener: (code: number | null) => void): void;
  /** Stops the server (it saves what pages still had to save), then the database. */
  stop(): Promise<void>;
};

type Secrets = { authSecret: string; password: string };

/** Made at the first start and kept: the auth secret also seals connections' tokens, so it never changes. */
function secretsIn(root: string): Secrets {
  const file = path.join(root, "secrets.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Secrets>;
    if (saved.authSecret && saved.password) return { authSecret: saved.authSecret, password: saved.password };
  } catch {}
  const secrets = { authSecret: randomBytes(32).toString("base64"), password: randomBytes(24).toString("base64url") };
  fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  return secrets;
}

/** The log's file, started over (the last one kept) once it has grown large. */
function openLog(file: string) {
  try {
    if (fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, file.replace(/\.log$/, ".old.log"));
  } catch {}
  return fs.openSync(file, "a");
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const { root, serverDir } = options;
  fs.mkdirSync(root, { recursive: true });
  const secrets = secretsIn(root);
  const account = { email: LOCAL_EMAIL, password: secrets.password };
  const log = path.join(root, "server.log");
  const database = await startLocalDatabase(path.join(root, "database"));
  const port = await freePort(options.port);
  const origin = `http://127.0.0.1:${port}`;

  const passed = Object.fromEntries(PASSED_ENV.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
  const env = {
    ...passed,
    ...options.nodeEnv,
    NODE_ENV: options.dev ? "development" : "production",
    DATABASE_URL: database.url,
    BETTER_AUTH_SECRET: secrets.authSecret,
    APP_URL: origin,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    UPLOAD_DIR: path.join(root, "files"),
    // The app signs in again whenever the session is gone; a long one only spares it the work.
    // (Browsers keep a cookie 400 days at most, and the server refuses to set a longer one.)
    SESSION_MAX_AGE_DAYS: "365",
    // Nothing stands between the app and its server.
    TRUSTED_PROXIES: "0",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const out = openLog(log);
  const run = (script: string, extra: Record<string, string>) =>
    spawn(options.node, ["--import", "tsx", script], {
      cwd: serverDir,
      env: { ...env, ...extra },
      // The IPC channel: the server stops when asked through it, or when the app is gone.
      stdio: ["ignore", out, out, "ipc"],
      windowsHide: true,
    });
  const exited = (child: ChildProcess) =>
    new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
      else child.once("exit", (code) => resolve(code));
    });

  let server: ChildProcess | undefined;
  try {
    const setup = run(path.join("scripts", "desktop-setup.ts"), {
      LEAFDESK_LOCAL_EMAIL: account.email,
      LEAFDESK_LOCAL_NAME: os.userInfo().username || "Leafdesk",
      LEAFDESK_LOCAL_PASSWORD: account.password,
    });
    const setupCode = await exited(setup);
    if (setupCode !== 0) throw new Error(`Leafdesk's setup stopped with ${setupCode}; see ${log}`);

    // Nobody signs up here: the one account is made by the setup.
    server = run("server.ts", { DISABLE_SIGNUP: "true" });
    const serverExit = exited(server);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const ready = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10_000) }).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      const code = await Promise.race([serverExit, delay(250).then(() => undefined)]);
      if (code !== undefined) throw new Error(`Leafdesk's server stopped with ${code}; see ${log}`);
      if (Date.now() > deadline) throw new Error(`Leafdesk's server didn't start in ${READY_TIMEOUT_MS / 1000} seconds; see ${log}`);
    }
  } catch (error) {
    server?.kill();
    if (server) await exited(server);
    await database.stop().catch(() => {});
    fs.closeSync(out);
    throw error;
  }

  const running = server;
  let stopping: Promise<void> | undefined;
  const listeners: ((code: number | null) => void)[] = [];
  void exited(running).then((code) => {
    if (!stopping) for (const listener of listeners) listener(code);
  });

  return {
    origin,
    port,
    account,
    log,
    onExit: (listener) => void listeners.push(listener),
    stop: () =>
      (stopping ??= (async () => {
        if (running.exitCode === null && running.signalCode === null) {
          if (running.connected) running.send("shutdown");
          else running.kill();
          const code = await Promise.race([exited(running), delay(STOP_TIMEOUT_MS).then(() => "timeout" as const)]);
          if (code === "timeout") {
            running.kill("SIGKILL");
            await exited(running);
          }
        }
        // After the server: it saves pages' last edits to the database as it stops.
        await database.stop();
        fs.closeSync(out);
      })()),
  };
}

export type SessionCookie = {
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "no_restriction" | "unspecified";
  /** Seconds it lasts; unset for one that ends with the browser. */
  maxAge?: number;
};

/** A `Set-Cookie` header, as far as setting it in the app's browser needs. */
export function parseSetCookie(header: string): SessionCookie {
  const [pair, ...attributes] = header.split(";");
  const equals = pair.indexOf("=");
  const cookie: SessionCookie = {
    name: pair.slice(0, equals).trim(),
    value: pair.slice(equals + 1).trim(),
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "unspecified",
  };
  for (const attribute of attributes) {
    const [key, ...rest] = attribute.split("=");
    const value = rest.join("=").trim();
    switch (key.trim().toLowerCase()) {
      case "path":
        cookie.path = value || "/";
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "max-age":
        cookie.maxAge = Number(value);
        break;
      case "samesite": {
        const same = value.toLowerCase();
        cookie.sameSite = same === "lax" || same === "strict" ? same : same === "none" ? "no_restriction" : "unspecified";
        break;
      }
    }
  }
  return cookie;
}

/** Signs in to the computer's account; answers the session's cookies, for the app's browser. */
export async function signIn(origin: string, account: LocalAccount): Promise<SessionCookie[]> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    // The server takes a sign-in only from its own pages' origin.
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: account.email, password: account.password, rememberMe: true }),
  });
  if (!response.ok) throw new Error(`Signing in to Leafdesk on this computer failed (${response.status})`);
  return response.headers.getSetCookie().map(parseSetCookie);
}

/** Whether these cookies (a `Cookie` header) hold a session the server still knows. */
export async function hasSession(origin: string, cookies: string): Promise<boolean> {
  if (!cookies) return false;
  const response = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie: cookies } });
  if (!response.ok) return false;
  const session = (await response.json().catch(() => null)) as { user?: unknown } | null;
  return !!session?.user;
}
