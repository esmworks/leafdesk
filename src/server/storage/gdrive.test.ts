import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "./driver";
import { driveAccount, driveFolder, driveRootFolder, gdriveDriver } from "./gdrive";
import { oauthSession } from "./oauth-session";

/**
 * A stand-in for Google's token endpoint and the Drive API: keeps files in memory, checks the
 * bearer token and records what the driver sent. Resumable uploads answer with an upload address
 * on the same server, as Drive does.
 */
type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer };
type DriveFile = { id: string; name: string; parents: string[]; mimeType: string; appProperties: Record<string, string>; data: Buffer };

let server: Server;
let base: string;
const files = new Map<string, DriveFile>();
const uploads = new Map<string, Omit<DriveFile, "data" | "id">>();
const seen: Seen[] = [];
let valid = "token-1";
let nextId = 0;
/** For the next request to the Drive API: an answer instead of the usual one. */
let refuse: { status: number; body: unknown; times: number } | null = null;

const appProperty = (q: string, key: string) => new RegExp(`key='${key}' and value='([^']+)'`).exec(q)?.[1];

function handle(req: IncomingMessage, body: Buffer): { status: number; headers?: Record<string, string>; body?: unknown } {
  const url = new URL(req.url!, base);
  if (url.pathname === "/token") {
    const form = new URLSearchParams(body.toString("utf8"));
    if (form.get("refresh_token") !== "refresh") return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    valid = `token-${Number(valid.split("-")[1]) + 1}`;
    return { status: 200, body: { access_token: valid, expires_in: 3600 } };
  }
  if (req.headers.authorization !== `Bearer ${valid}`) return { status: 401, body: { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } } };
  if (refuse && refuse.times-- > 0) return { status: refuse.status, body: refuse.body };
  if (url.pathname === "/drive/v3/about") return { status: 200, body: { user: { permissionId: "perm-1", emailAddress: "owner@example.com", displayName: "Owner" } } };
  if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
    const metadata = JSON.parse(body.toString("utf8"));
    const uploadId = `u${++nextId}`;
    uploads.set(uploadId, { ...metadata, mimeType: req.headers["x-upload-content-type"] });
    return { status: 200, headers: { location: `${base}/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}` } };
  }
  if (url.pathname === "/upload/drive/v3/files" && req.method === "PUT") {
    if (req.headers["transfer-encoding"] === "chunked") return { status: 400, body: { error: { message: "chunked" } } };
    const pending = uploads.get(url.searchParams.get("upload_id") ?? "");
    if (!pending) return { status: 404 };
    const id = `file-${++nextId}`;
    files.set(id, { id, ...pending, data: body });
    return { status: 200, body: { id } };
  }
  if (url.pathname === "/drive/v3/files" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const workspace = appProperty(q, "leafdeskWorkspace");
    const root = appProperty(q, "leafdeskRoot");
    const key = appProperty(q, "leafdeskKey");
    const folder = /^'([^']+)' in parents/.exec(q)?.[1];
    const found = [...files.values()].filter((f) =>
      workspace
        ? f.appProperties?.leafdeskWorkspace === workspace
        : root
          ? f.appProperties?.leafdeskRoot === root
          : f.appProperties?.leafdeskKey === key && (!folder || f.parents.includes(folder)),
    );
    return { status: 200, body: { files: found.map((f) => ({ id: f.id, name: f.name })) } };
  }
  if (url.pathname === "/drive/v3/files" && req.method === "POST") {
    const metadata = JSON.parse(body.toString("utf8"));
    const id = `folder-${++nextId}`;
    files.set(id, { id, parents: [], ...metadata, data: Buffer.alloc(0) });
    return { status: 200, body: { id, name: metadata.name } };
  }
  const match = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const file = files.get(decodeURIComponent(match[1]));
    if (!file) return { status: 404, body: { error: { code: 404, message: "File not found", errors: [{ reason: "notFound" }] } } };
    if (req.method === "DELETE") {
      files.delete(file.id);
      return { status: 204 };
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
    if (range) return { status: 206, body: file.data.subarray(Number(range[1]), Number(range[2]) + 1) };
    return { status: 200, body: file.data };
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
      res.writeHead(answer.status, answer.headers).end(payload);
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
  uploads.clear();
  seen.length = 0;
  valid = "token-1";
  refuse = null;
});

const app = { clientId: "client", clientSecret: "secret" };
const session = (credentials = { refreshToken: "refresh", accessToken: "token-1", expiresAt: Date.now() + 3600_000 }) =>
  oauthSession("gdrive", app, credentials, { tokenUrl: `${base}/token` });
const endpoints = () => ({ api: base, upload: base });
const driver = (s = session()) => gdriveDriver({ folderId: "folder-a", session: s, endpoints: endpoints() });
const text = (stream: ReadableStream<Uint8Array> | null) => (stream ? new Response(stream).text() : null);
const put = (d: ReturnType<typeof driver>, key: string, content: string) =>
  d.put(key, Readable.from([Buffer.from(content.slice(0, 3)), Buffer.from(content.slice(3))]), { size: Buffer.byteLength(content), contentType: "text/plain" });

describe("gdriveDriver", () => {
  it("uploads a stream with its length into the folder and returns the Drive id", async () => {
    const id = await put(driver(), "ws-1/abc", "hello world");
    expect(id).toMatch(/^file-/);
    const stored = files.get(id as string)!;
    expect(stored.data.toString()).toBe("hello world");
    expect(stored).toMatchObject({ name: "ws-1_abc", parents: ["folder-a"], mimeType: "text/plain", appProperties: { leafdeskKey: "ws-1/abc" } });
    const begin = seen.find((s) => s.method === "POST" && s.url.startsWith("/upload/"))!;
    expect(begin.headers["x-upload-content-length"]).toBe("11");
    const send = seen.find((s) => s.method === "PUT")!;
    expect(send.headers["content-length"]).toBe("11");
    expect(send.headers["transfer-encoding"]).toBeUndefined();
  });

  it("reads an object whole and in ranges (the bytes the probe checks)", async () => {
    const d = driver();
    const payload = "Leafdesk storage check 0123456789";
    const id = await put(d, "ws-1/check", payload);
    expect(await text(await d.get({ key: "ws-1/check", objectId: id as string }))).toBe(payload);
    expect(await text(await d.get({ key: "ws-1/check", objectId: id as string }, { start: 9, end: 15 }))).toBe(payload.slice(9, 16));
    expect(seen.at(-1)!.headers.range).toBe("bytes=9-15");
  });

  it("finds an object without its id by its key", async () => {
    const d = driver();
    await put(d, "ws-1/abc", "found me");
    expect(await text(await d.get("ws-1/abc"))).toBe("found me");
    expect(await d.get("ws-1/missing")).toBeNull();
  });

  it("answers null for a file that is gone, and deletes what is there or isn't", async () => {
    const d = driver();
    const id = (await put(d, "ws-1/abc", "x")) as string;
    await d.delete({ key: "ws-1/abc", objectId: id });
    expect(files.has(id)).toBe(false);
    expect(await d.get({ key: "ws-1/abc", objectId: id })).toBeNull();
    await expect(d.delete({ key: "ws-1/abc", objectId: id })).resolves.toBeUndefined();
    await expect(d.delete("ws-1/never")).resolves.toBeUndefined();
  });

  it("refreshes a refused access token and tries again", async () => {
    const d = driver(session({ refreshToken: "refresh", accessToken: "stale", expiresAt: Date.now() + 3600_000 }));
    const id = await put(d, "ws-1/abc", "again");
    expect(files.get(id as string)!.data.toString()).toBe("again");
    expect(seen.filter((s) => s.url === "/token")).toHaveLength(1);
  });

  it("fails as broken (not passing) once the sign-in is revoked", async () => {
    const d = driver(session({ refreshToken: "revoked", accessToken: "stale", expiresAt: Date.now() + 3600_000 }));
    const error = (await d.get({ key: "ws-1/abc", objectId: "file-1" }).catch((e: unknown) => e)) as StorageError;
    expect(error).toBeInstanceOf(StorageError);
    expect(error.status).toBe(401);
    expect(error.transient).toBe(false);
  });

  it("counts Drive's rate limit as passing, and a full Drive as not", async () => {
    refuse = { status: 403, body: { error: { code: 403, message: "Rate Limit Exceeded", errors: [{ reason: "userRateLimitExceeded" }] } }, times: 1 };
    const limited = (await driver().get({ key: "ws-1/abc", objectId: "file-1" }).catch((e: unknown) => e)) as StorageError;
    expect(limited.transient).toBe(true);
    refuse = { status: 403, body: { error: { code: 403, message: "The user's Drive storage quota has been exceeded.", errors: [{ reason: "storageQuotaExceeded" }] } }, times: 1 };
    const full = (await put(driver(), "ws-1/abc", "x").catch((e: unknown) => e)) as StorageError;
    expect(full.transient).toBe(false);
    expect(full.message).toBe("Google Drive upload failed: 403 storageQuotaExceeded: The user's Drive storage quota has been exceeded.");
  });

  it("tries a server error again", async () => {
    const d = driver();
    const id = (await put(d, "ws-1/abc", "retry")) as string;
    refuse = { status: 503, body: { error: { message: "busy" } }, times: 1 };
    expect(await text(await d.get({ key: "ws-1/abc", objectId: id }))).toBe("retry");
  });

  it("sends the bytes only to Drive's own upload address", async () => {
    const elsewhere = gdriveDriver({ folderId: "folder-a", session: session(), endpoints: { api: base, upload: base.replace("127.0.0.1", "localhost") } });
    // The upload address Drive gives is on 127.0.0.1, not the configured localhost.
    await expect(put(elsewhere, "ws-1/abc", "x")).rejects.toThrow(/unexpected upload address/);
    expect(seen.some((s) => s.method === "PUT")).toBe(false);
  });

  it("refuses keys that aren't the drivers'", async () => {
    await expect(put(driver(), "../x", "x")).rejects.toThrow(/Bad storage key/);
  });
});

describe("driveAccount and driveFolder", () => {
  it("names the signed-in account", async () => {
    expect(await driveAccount(session(), endpoints())).toEqual({ accountId: "perm-1", account: "owner@example.com" });
  });

  it("makes the workspace's folder once and finds it on the next sign-in", async () => {
    const made = await driveFolder(session(), "ws-1", "Leafdesk (Acme)", endpoints());
    expect(made.folderName).toBe("Leafdesk (Acme)");
    expect(files.get(made.folderId)).toMatchObject({ mimeType: "application/vnd.google-apps.folder", appProperties: { leafdeskWorkspace: "ws-1" } });
    expect(await driveFolder(session(), "ws-1", "Leafdesk (Renamed)", endpoints())).toEqual(made);
    expect((await driveFolder(session(), "ws-2", "Leafdesk (Other)", endpoints())).folderId).not.toBe(made.folderId);
  });

  it("serves two workspaces from one Drive, each in its own folder inside the account's Leafdesk folder", async () => {
    const root = await driveRootFolder(session(), endpoints());
    expect(await driveRootFolder(session(), endpoints())).toEqual(root);
    const one = await driveFolder(session(), "ws-1", "Leafdesk (One)", endpoints(), root.folderId);
    const two = await driveFolder(session(), "ws-2", "Leafdesk (Two)", endpoints(), root.folderId);
    expect(files.get(one.folderId)!.parents).toEqual([root.folderId]);
    expect(files.get(two.folderId)!.parents).toEqual([root.folderId]);
    const first = gdriveDriver({ folderId: one.folderId, session: session(), endpoints: endpoints() });
    const second = gdriveDriver({ folderId: two.folderId, session: session(), endpoints: endpoints() });
    await put(first, "ws-1/abc", "one");
    await put(second, "ws-2/abc", "two");
    expect(await text(await first.get("ws-1/abc"))).toBe("one");
    expect(await text(await second.get("ws-2/abc"))).toBe("two");
    // Each folder holds only its own workspace's file.
    expect(await first.get("ws-2/abc")).toBeNull();
    expect([...files.values()].filter((f) => f.parents.includes(one.folderId)).map((f) => f.name)).toEqual(["ws-1_abc"]);
  });
});
