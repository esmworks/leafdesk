import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "./driver";
import { dropboxAccount, dropboxDriver } from "./dropbox";
import { oauthSession } from "./oauth-session";

/**
 * A stand-in for Dropbox's token endpoint and its API and content hosts (one server): keeps files
 * in memory by path and id, checks the bearer token and records what the driver sent.
 */
type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer };

let server: Server;
let base: string;
const files = new Map<string, { id: string; data: Buffer }>();
const sessions = new Map<string, Buffer[]>();
const seen: Seen[] = [];
let valid = "token-1";
let nextId = 0;
let refuse: { status: number; body: unknown; times: number } | null = null;

const notFound = (prefix: string) => ({ status: 409, body: { error_summary: `${prefix}/not_found/..`, error: { ".tag": prefix } } });
const pathOf = (place: string) => (place.startsWith("id:") ? [...files.entries()].find(([, f]) => f.id === place)?.[0] : place);

function store(path: string, data: Buffer) {
  const id = files.get(path)?.id ?? `id:${++nextId}`;
  files.set(path, { id, data });
  return { status: 200, body: { id, name: path.split("/").pop(), path_display: path, size: data.length } };
}

function handle(req: IncomingMessage, body: Buffer): { status: number; body?: unknown } {
  const url = new URL(req.url!, base);
  if (url.pathname === "/oauth2/token") {
    const form = new URLSearchParams(body.toString("utf8"));
    if (form.get("refresh_token") !== "refresh") return { status: 400, body: { error: "invalid_grant", error_description: "refresh token is invalid or revoked" } };
    valid = `token-${Number(valid.split("-")[1]) + 1}`;
    return { status: 200, body: { access_token: valid, expires_in: 14400 } };
  }
  if (req.headers.authorization !== `Bearer ${valid}`) return { status: 401, body: { error_summary: "expired_access_token/", error: { ".tag": "expired_access_token" } } };
  if (refuse && refuse.times-- > 0) return { status: refuse.status, body: refuse.body };
  const arg = req.headers["dropbox-api-arg"] ? JSON.parse(String(req.headers["dropbox-api-arg"])) : null;
  switch (url.pathname) {
    case "/2/users/get_current_account":
      return { status: 200, body: { account_id: "dbid:1", email: "owner@example.com", name: { display_name: "Owner" } } };
    case "/2/files/upload":
      if (req.headers["transfer-encoding"] === "chunked") return { status: 400, body: { error_summary: "chunked" } };
      return store(arg.path, body);
    case "/2/files/upload_session/start": {
      const id = `s${++nextId}`;
      sessions.set(id, [body]);
      return { status: 200, body: { session_id: id } };
    }
    case "/2/files/upload_session/append_v2": {
      const parts = sessions.get(arg.cursor.session_id)!;
      if (Buffer.concat(parts).length !== arg.cursor.offset) return { status: 409, body: { error_summary: "incorrect_offset/" } };
      parts.push(body);
      return { status: 200, body: null };
    }
    case "/2/files/upload_session/finish": {
      const parts = sessions.get(arg.cursor.session_id)!;
      parts.push(body);
      return store(arg.commit.path, Buffer.concat(parts));
    }
    case "/2/files/download": {
      const path = pathOf(arg.path);
      const file = path && files.get(path);
      if (!file) return notFound("path");
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
      return range ? { status: 206, body: file.data.subarray(Number(range[1]), Number(range[2]) + 1) } : { status: 200, body: file.data };
    }
    case "/2/files/delete_v2": {
      const path = pathOf(JSON.parse(body.toString("utf8")).path);
      if (!path || !files.has(path)) return notFound("path_lookup");
      files.delete(path);
      return { status: 200, body: { metadata: { ".tag": "file" } } };
    }
  }
  return { status: 404 };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const answer = handle(req, body);
      const payload = answer.body === undefined ? "" : Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.body);
      res.writeHead(answer.status).end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  files.clear();
  sessions.clear();
  seen.length = 0;
  valid = "token-1";
  refuse = null;
});

const app = { clientId: "client", clientSecret: "secret" };
const session = (credentials = { refreshToken: "refresh", accessToken: "token-1", expiresAt: Date.now() + 3600_000 }) =>
  oauthSession("dropbox", app, credentials, { tokenUrl: `${base}/oauth2/token` });
const driver = (s = session(), limits: { singleUploadLimit?: number; sessionChunk?: number } = {}) => dropboxDriver({ session: s, endpoints: { api: base, content: base }, ...limits });
const text = (stream: ReadableStream<Uint8Array> | null) => (stream ? new Response(stream).text() : null);
const put = (d: ReturnType<typeof driver>, key: string, content: string) =>
  d.put(key, Readable.from([Buffer.from(content.slice(0, 3)), Buffer.from(content.slice(3))]), { size: Buffer.byteLength(content), contentType: "text/plain" });

describe("dropboxDriver", () => {
  it("uploads a stream with its length to the key's path and returns the Dropbox id", async () => {
    const id = await put(driver(), "ws-1/abc", "hello world");
    expect(id).toBe(files.get("/ws-1/abc")!.id);
    expect(files.get("/ws-1/abc")!.data.toString()).toBe("hello world");
    const upload = seen.find((s) => s.url === "/2/files/upload")!;
    expect(upload.headers["content-length"]).toBe("11");
    expect(JSON.parse(String(upload.headers["dropbox-api-arg"]))).toEqual({ path: "/ws-1/abc", mode: "overwrite", autorename: false, mute: true });
  });

  it("uploads a large file in an upload session, a chunk at a time", async () => {
    const content = "abcdefghijklmnopqrstuvwxyz0123456789";
    const id = await put(driver(session(), { singleUploadLimit: 10, sessionChunk: 8 }), "ws-1/big", content);
    expect(files.get("/ws-1/big")).toEqual({ id, data: Buffer.from(content) });
    const appends = seen.filter((s) => s.url === "/2/files/upload_session/append_v2");
    expect(appends.map((s) => s.body.length)).toEqual([8, 8, 8, 8, 4]);
    expect(seen.some((s) => s.url === "/2/files/upload")).toBe(false);
  });

  it("reads an object whole and in ranges (the bytes the probe checks), by id or path", async () => {
    const d = driver();
    const payload = "Leafdesk storage check 0123456789";
    const id = (await put(d, "ws-1/check", payload)) as string;
    expect(await text(await d.get({ key: "ws-1/check", objectId: id }))).toBe(payload);
    expect(await text(await d.get({ key: "ws-1/check", objectId: id }, { start: 9, end: 15 }))).toBe(payload.slice(9, 16));
    expect(seen.at(-1)!.headers.range).toBe("bytes=9-15");
    expect(await text(await d.get("ws-1/check"))).toBe(payload);
  });

  it("answers null for what isn't there, and deletes what is there or isn't", async () => {
    const d = driver();
    const id = (await put(d, "ws-1/abc", "x")) as string;
    await d.delete({ key: "ws-1/abc", objectId: id });
    expect(files.size).toBe(0);
    expect(await d.get({ key: "ws-1/abc", objectId: id })).toBeNull();
    await expect(d.delete({ key: "ws-1/abc", objectId: id })).resolves.toBeUndefined();
  });

  it("refreshes an expired access token and tries again", async () => {
    const d = driver(session({ refreshToken: "refresh", accessToken: "expired", expiresAt: Date.now() + 3600_000 }));
    await d.delete("ws-1/none");
    expect(seen.filter((s) => s.url === "/oauth2/token")).toHaveLength(1);
  });

  it("fails as broken (not passing) once the app's access is revoked", async () => {
    const d = driver(session({ refreshToken: "revoked", accessToken: "expired", expiresAt: Date.now() + 3600_000 }));
    const error = (await d.get("ws-1/abc").catch((e: unknown) => e)) as StorageError;
    expect(error).toBeInstanceOf(StorageError);
    expect(error.status).toBe(401);
    expect(error.transient).toBe(false);
  });

  it("counts a full Dropbox as not passing, and a rate limit as passing", async () => {
    refuse = { status: 409, body: { error_summary: "path/insufficient_space/" }, times: 1 };
    const full = (await put(driver(), "ws-1/abc", "x").catch((e: unknown) => e)) as StorageError;
    expect(full.message).toBe("Dropbox upload failed: 409 path/insufficient_space/");
    expect(full.transient).toBe(false);
    refuse = { status: 429, body: { error_summary: "too_many_requests/" }, times: 3 };
    const limited = (await driver().get("ws-1/abc").catch((e: unknown) => e)) as StorageError;
    expect(limited.transient).toBe(true);
  });

  it("refuses keys that aren't the drivers'", async () => {
    await expect(put(driver(), "../x", "x")).rejects.toThrow(/Bad storage key/);
  });
});

describe("dropboxAccount", () => {
  it("names the signed-in account", async () => {
    expect(await dropboxAccount(session(), { api: base })).toEqual({ accountId: "dbid:1", account: "owner@example.com" });
  });
});
