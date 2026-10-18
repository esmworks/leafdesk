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
const backups = path.join(root, "backups");

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

// Those started, stopped even when the test fails (else they would outlive the test).
const running: LocalServer[] = [];
const start = async (port?: number, at = root) => {
  const server = await startLocalServer({ ...options, root: at, port, backupFolder: backups });
  running.push(server);
  return server;
};

after(async () => {
  for (const server of running) await server.stop().catch((error) => console.error("stopping Leafdesk:", error));
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

test("Leafdesk runs on this computer, signs its account in, keeps it across a restart and backs it up", { timeout: 900_000 }, () =>
  lifecycle().catch((error) => {
    for (const server of running) {
      if (fs.existsSync(server.log)) console.error(`--- ${server.log}\n${fs.readFileSync(server.log, "utf8")}`);
    }
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
  const workspace = home.headers.get("location") ?? "";
  assert.match(workspace, /^\/w\/[0-9a-f-]{36}$/);
  // Local mode: what needs other people or a public address is refused (src/server/local-mode.ts).
  const scim = await fetch(`${first.origin}/scim/v2/Users`, { headers: { authorization: "Bearer scim_anything" } });
  assert.equal(scim.status, 404, "no SCIM");
  for (const tab of ["guests", "site"]) {
    const settings = await fetch(`${first.origin}${workspace}/settings?tab=${tab}`, { headers: { cookie: header } });
    assert.equal(settings.status, 404, `no ${tab} settings`);
  }
  const members = await fetch(`${first.origin}${workspace}/settings?tab=members`, { headers: { cookie: header } });
  assert.equal(members.status, 200, "the members settings are there");
  await first.stop();
  await assert.rejects(fetch(`${first.origin}/api/health`), "the server stopped");

  // Started again: on the same port, with the same account and session.
  const second = await start(first.port);
  assert.equal(second.port, first.port);
  assert.equal(second.account.password, first.account.password);
  assert.ok(await hasSession(second.origin, header), "still signed in");

  // A backup into the folder, which restores on another Leafdesk: here, a second one on this
  // computer with nothing in it yet.
  const backup = await second.backUp();
  assert.deepEqual(backup.errors, []);
  assert.equal(backup.files.length, 1);
  const name = path.basename(backup.files[0]);
  assert.match(name, /^.+ \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d \[[0-9a-f]{8}\]\.zip$/);
  // On a slow computer the backup made a minute after a start may be there too: the same
  // workspace's, and nothing half written.
  const tag = name.slice(name.lastIndexOf(" ["));
  assert.ok(fs.readdirSync(backups).includes(name));
  assert.deepEqual(fs.readdirSync(backups).filter((file) => !file.endsWith(tag)), []);
  await second.stop();

  const other = await start(undefined, path.join(root, "other"));
  const otherCookie = (await signIn(other.origin, other.account)).map(({ name, value }) => `${name}=${value}`).join("; ");
  const restore = await fetch(`${other.origin}/api/backups`, {
    method: "POST",
    headers: { cookie: otherCookie, origin: other.origin, "x-leafdesk-restore": "1", "content-type": "application/zip" },
    body: fs.readFileSync(backup.files[0]),
  });
  assert.equal(restore.status, 201, await restore.clone().text());
  const { workspaceId } = (await restore.json()) as { workspaceId: string };
  const page = await fetch(`${other.origin}/w/${workspaceId}`, { headers: { cookie: otherCookie }, redirect: "manual" });
  assert.equal(page.status, 200, "the restored workspace opens");
  await other.stop();
}
