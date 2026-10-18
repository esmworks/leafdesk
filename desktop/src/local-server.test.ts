// Leafdesk on this computer for real: the setup, the server, signing in, and a restart on the same
// port with the same session. It runs the repository's server in development, so it needs the
// repository's packages too (pnpm install at the root). Given a built server (LEAFDESK_TEST_SERVER_DIR,
// scripts/bundle-server.ts), it runs that with this Node. Given a packaged app instead
// (LEAFDESK_TEST_APP_RESOURCES, its resources folder, and LEAFDESK_TEST_APP_EXECUTABLE), it runs
// what that app ships: its built server, run by its Electron, on its PostgreSQL. CI does both on
// macOS, Windows and Linux (.github/workflows/ci.yml).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { binariesIn } from "./local-db.ts";
import { hasSession, parseSetCookie, signIn, startLocalServer, type LocalServer, type LocalServerOptions } from "./local-server.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "leafdesk local server "));

function packaged(resources: string, executable: string): Omit<LocalServerOptions, "root"> {
  // Relative to the folder the test runs in: the server runs in a folder of its own.
  [resources, executable] = [path.resolve(resources), path.resolve(executable)];
  const postgres = path.join(resources, "app.asar.unpacked", "node_modules", "@embedded-postgres");
  const [platform] = fs.readdirSync(postgres);
  return {
    serverDir: path.join(resources, "server"),
    node: executable,
    nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
    dev: false,
    binaries: binariesIn(path.join(postgres, platform, "native", "bin")),
  };
}
const { LEAFDESK_TEST_APP_RESOURCES: resources, LEAFDESK_TEST_APP_EXECUTABLE: executable, LEAFDESK_TEST_SERVER_DIR: built } = process.env;
const options =
  resources && executable
    ? packaged(resources, executable)
    : built
      ? { serverDir: built, node: process.execPath, dev: false }
      : { serverDir: path.join(import.meta.dirname, "..", ".."), node: process.execPath, dev: true };

// The last one started, stopped even when the test fails (else it would outlive the test).
let running: LocalServer | null = null;
const start = async (port?: number) => (running = await startLocalServer({ ...options, root, port }));

after(async () => {
  await running?.stop().catch((error) => console.error("stopping Leafdesk:", error));
  // Windows holds a folder a moment after the processes in it have exited.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("Set-Cookie headers, as the app's browser takes them", () => {
  assert.deepEqual(parseSetCookie("better-auth.session_token=abc.def%3D; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax"), {
    name: "better-auth.session_token",
    value: "abc.def%3D",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    maxAge: 31536000,
  });
  assert.deepEqual(parseSetCookie("a=b=c; Secure; SameSite=None"), {
    name: "a",
    value: "b=c",
    path: "/",
    httpOnly: false,
    secure: true,
    sameSite: "no_restriction",
  });
});

test("Leafdesk runs on this computer, signs its account in, and keeps it across a restart", { timeout: 900_000 }, () =>
  lifecycle().catch((error) => {
    const log = path.join(root, "server.log");
    if (fs.existsSync(log)) console.error(`--- server.log\n${fs.readFileSync(log, "utf8")}`);
    throw error;
  }),
);

async function lifecycle() {
  const first = await start();
  assert.match(first.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  // Nobody else signs up: the setup made the one account.
  const signUp = await fetch(`${first.origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: first.origin },
    body: JSON.stringify({ email: "someone@example.com", name: "Someone", password: "a long enough password" }),
  });
  assert.equal(signUp.status, 400, "sign-up is closed");

  const cookies = await signIn(first.origin, first.account);
  const header = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  assert.ok(await hasSession(first.origin, header), "signed in");
  assert.equal(await hasSession(first.origin, "better-auth.session_token=forged"), false);
  // Straight into the account's own workspace, made when it signed up.
  const home = await fetch(`${first.origin}/`, { headers: { cookie: header }, redirect: "manual" });
  assert.equal(home.status, 307);
  assert.match(home.headers.get("location") ?? "", /^\/w\/[0-9a-f-]{36}$/);
  await first.stop();
  await assert.rejects(fetch(`${first.origin}/api/health`), "the server stopped");

  // Started again: on the same port, with the same account and session.
  const second = await start(first.port);
  assert.equal(second.port, first.port);
  assert.equal(second.account.password, first.account.password);
  assert.ok(await hasSession(second.origin, header), "still signed in");
  await second.stop();
}
