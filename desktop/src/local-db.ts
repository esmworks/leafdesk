/**
 * The database of Leafdesk on this computer (local mode): a PostgreSQL 18 server of its own, the
 * same database the server runs on, from the binaries of the `@embedded-postgres/<platform>`
 * packages, with its data in a folder of the app's.
 *
 * It listens on 127.0.0.1 only, on a free port picked at each start, with a password made at the
 * first start and kept next to the data. `pg_ctl` starts and stops it on every platform, so it shuts
 * down cleanly (a fast shutdown) when the app quits; one left running by an app that crashed is
 * stopped and started again, and one that was killed recovers from its write-ahead log as any
 * PostgreSQL does.
 *
 * The cluster uses the built-in C.UTF-8 locale, the same on macOS, Windows and Linux whatever the
 * computer's language: nothing depends on the system's locales, which differ (Windows names them
 * otherwise) and change with updates.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

export const LOCAL_DB_USER = "leafdesk";
export const LOCAL_DB_NAME = "postgres";

export type LocalDatabase = {
  /** The connection string, for DATABASE_URL. */
  url: string;
  port: number;
  /** Stops the server (a fast shutdown: open transactions are rolled back, the data is kept). */
  stop(): Promise<void>;
};

type Binaries = { initdb: string; pgCtl: string };

/** The PostgreSQL binaries for this platform, outside the app's archive when it is packaged. */
export function localDbBinaries(): Binaries {
  const require = createRequire(import.meta.url);
  // The package's entry is its dist/index.js (it exports nothing else); the binaries are beside.
  const entry = require.resolve(`@embedded-postgres/${process.platform}-${process.arch}`);
  // electron-builder unpacks the binaries next to app.asar; executables can't run from inside it.
  const bin = path.join(path.dirname(entry), "..", "native", "bin").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const exe = process.platform === "win32" ? ".exe" : "";
  return { initdb: path.join(bin, `initdb${exe}`), pgCtl: path.join(bin, `pg_ctl${exe}`) };
}

/** Runs a binary and waits for it to exit; its output goes to the file `log`. */
function run(command: string, args: string[], log: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Output to a file, not a pipe: `pg_ctl start` leaves the server running with what it was
    // given, and a pipe the server holds would never close.
    const out = fs.openSync(log, "a");
    const child = spawn(command, args, { stdio: ["ignore", out, out], windowsHide: true });
    child.on("error", (error) => {
      fs.closeSync(out);
      reject(error);
    });
    child.on("exit", (code) => {
      fs.closeSync(out);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} ${args[0]} exited with ${code}; see ${log}`));
    });
  });
}

/** A port nothing listens on just now, on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Settings the cluster gets once, when it is made. */
const CONFIG = `
# Leafdesk on this computer: reachable from this computer only.
listen_addresses = '127.0.0.1'
unix_socket_directories = ''
max_connections = 40
shared_buffers = 64MB
`;

/**
 * Starts the database kept in `root` (made there at the first start), and answers once it takes
 * connections.
 */
export async function startLocalDatabase(root: string, binaries: Binaries = localDbBinaries()): Promise<LocalDatabase> {
  const data = path.join(root, "data");
  // The server's log, and the tools' own output (kept apart: the server holds its log open).
  const log = path.join(root, "postgres.log");
  const toolLog = path.join(root, "tools.log");
  const secretFile = path.join(root, "password");
  fs.mkdirSync(root, { recursive: true });

  if (!fs.existsSync(path.join(data, "PG_VERSION"))) {
    // A cluster that failed halfway through being made is made again.
    fs.rmSync(data, { recursive: true, force: true });
    const password = randomBytes(24).toString("base64url");
    const passwordFile = path.join(root, "initdb-password");
    fs.writeFileSync(passwordFile, password, { mode: 0o600 });
    try {
      await run(
        binaries.initdb,
        [
          `--pgdata=${data}`,
          `--username=${LOCAL_DB_USER}`,
          `--pwfile=${passwordFile}`,
          "--auth=scram-sha-256",
          "--encoding=UTF8",
          "--locale=C",
          "--locale-provider=builtin",
          "--builtin-locale=C.UTF-8",
          "--no-instructions",
        ],
        toolLog,
      );
    } finally {
      fs.rmSync(passwordFile, { force: true });
    }
    fs.appendFileSync(path.join(data, "postgresql.conf"), CONFIG);
    fs.writeFileSync(secretFile, password, { mode: 0o600 });
  }
  const password = fs.readFileSync(secretFile, "utf8").trim();

  // One left running by an app that crashed: stopped first, so it starts on this start's port.
  if (fs.existsSync(path.join(data, "postmaster.pid"))) {
    await run(binaries.pgCtl, ["stop", `--pgdata=${data}`, "--mode=fast", "--wait"], toolLog).catch(() => {});
  }

  const port = await freePort();
  await run(binaries.pgCtl, ["start", `--pgdata=${data}`, "--wait", "--timeout=120", `--log=${log}`, `--options=-p ${port}`], toolLog);

  return {
    url: `postgres://${LOCAL_DB_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${LOCAL_DB_NAME}`,
    port,
    stop: () => run(binaries.pgCtl, ["stop", `--pgdata=${data}`, "--mode=fast", "--wait", "--timeout=60"], toolLog),
  };
}
