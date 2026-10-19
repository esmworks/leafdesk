import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageError, type StorageDriver } from "./driver";

/** What the mocked database answers to selects, and the updates it was given. */
const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  updates: [] as Record<string, unknown>[],
  made: [] as unknown[],
  driver: null as unknown,
  sessions: [] as { kind: string; credentials: unknown; persist?: (credentials: unknown) => Promise<void> }[],
}));

vi.mock("@/db", () => {
  const chain = () => {
    const query: Record<string, unknown> = {};
    for (const name of ["from", "where", "limit", "returning"]) query[name] = () => query;
    query.then = (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(state.rows).then(resolve, reject);
    return query;
  };
  return {
    db: {
      select: () => chain(),
      delete: () => chain(),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            state.updates.push(values);
            return Object.assign(Promise.resolve(), { returning: async () => [{ id: "target-1" }] });
          },
        }),
      }),
    },
  };
});
vi.mock("@/server/secret-box", () => ({ openJson: (sealed: string) => JSON.parse(sealed), sealJson: (value: unknown) => JSON.stringify(value) }));
vi.mock("./s3", () => ({
  s3Driver: (config: unknown) => {
    state.made.push(config);
    return state.driver;
  },
}));
vi.mock("./gdrive", () => ({
  gdriveDriver: (config: { folderId: string }) => {
    state.made.push({ kind: "gdrive", folderId: config.folderId });
    return state.driver;
  },
}));
vi.mock("./dropbox", () => ({
  dropboxDriver: () => {
    state.made.push({ kind: "dropbox" });
    return state.driver;
  },
}));
vi.mock("./oauth-session", () => ({
  OAUTH_PROVIDERS: { gdrive: { name: "Google Drive" }, dropbox: { name: "Dropbox" } },
  oauthSession: (kind: string, _app: unknown, credentials: unknown, options: { persist?: (credentials: unknown) => Promise<void> }) => {
    state.sessions.push({ kind, credentials, persist: options.persist });
    return {};
  },
}));

const { setStorage } = await import("./index");
const { localDriver } = await import("./local");
const { probeStorage, storageFor, storageOf } = await import("./workspace");

const instance: StorageDriver = { kind: "local", put: async () => {}, get: async () => null, delete: async () => {} };

const target = (over: Record<string, unknown> = {}) => ({
  id: "target-1",
  workspaceId: "ws-1",
  kind: "s3",
  config: { endpoint: "https://s.example.com", region: "us-east-1", bucket: "files", prefix: null, forcePathStyle: true },
  credentials: JSON.stringify({ accessKeyId: "key", secretAccessKey: "secret" }),
  status: "active",
  lastError: null,
  lastErrorAt: null,
  verifiedAt: new Date(),
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/** A driver whose requests answer as `behave` says. */
function fakeDriver(behave: () => Promise<unknown>): StorageDriver {
  return {
    kind: "s3",
    put: async () => void (await behave()),
    get: async () => (await behave()) as null,
    delete: async () => void (await behave()),
  };
}

beforeEach(() => {
  state.rows = [];
  state.updates = [];
  state.made = [];
  state.sessions = [];
  state.driver = fakeDriver(async () => null);
  setStorage(instance);
  vi.stubEnv("UPLOAD_WORKSPACE_QUOTA_MB", "1");
  vi.stubEnv("STORAGE_ALLOWED_HOSTS", "minio:9000");
  delete (globalThis as Record<string, unknown>).__leafdeskStorageTargets;
});

afterEach(() => {
  setStorage(null);
  vi.unstubAllEnvs();
});

describe("storageFor", () => {
  it("is the instance's storage, with its quota, while the workspace has none of its own", async () => {
    const upload = await storageFor("ws-1");
    expect(upload).toEqual({ storageId: null, driver: instance, quotaBytes: 1024 * 1024 });
  });

  it("is the workspace's own storage, guarded and without a quota, once connected", async () => {
    state.rows = [target()];
    const upload = await storageFor("ws-1");
    expect(upload.storageId).toBe("target-1");
    expect(upload.quotaBytes).toBe(Infinity);
    expect(upload.driver.kind).toBe("s3");
    // Made on its first request.
    expect(state.made).toEqual([]);
    await upload.driver.get("ws-1/abc");
    expect(state.made).toEqual([
      expect.objectContaining({ bucket: "files", endpoint: "https://s.example.com", accessKeyId: "key", guard: { allowedHosts: ["minio:9000"] } }),
    ]);
  });

  it("makes a target's driver once, and again when its keys change", async () => {
    const read = async () => (await storageFor("ws-1")).driver.get("ws-1/abc");
    state.rows = [target()];
    await read();
    await read();
    expect(state.made).toHaveLength(1);
    state.rows = [target({ credentials: JSON.stringify({ accessKeyId: "new", secretAccessKey: "secret" }) })];
    await read();
    expect(state.made).toHaveLength(2);
  });
});

describe("storageOf", () => {
  it("reads a file where it was stored", async () => {
    expect(await storageOf({ storageId: null })).toBe(instance);
    state.rows = [target({ status: "disconnected" })];
    expect((await storageOf({ storageId: "target-1" })).kind).toBe("s3");
  });

  it("refuses when the workspace's storage is gone", async () => {
    await expect(storageOf({ storageId: "gone" })).rejects.toBeInstanceOf(StorageError);
  });
});

describe("a workspace's storage", () => {
  it("is marked broken by a request it refuses, with what it said", async () => {
    state.driver = fakeDriver(async () => {
      throw new StorageError("S3 GET failed: 403 InvalidAccessKeyId", 403);
    });
    state.rows = [target()];
    const driver = await storageOf({ storageId: "target-1" });
    await expect(driver.get("ws-1/abc")).rejects.toThrow(/InvalidAccessKeyId/);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ lastError: "S3 GET failed: 403 InvalidAccessKeyId" });
  });

  it("isn't marked broken by a server error", async () => {
    state.driver = fakeDriver(async () => {
      throw new StorageError("S3 PUT failed: 503 SlowDown", 503);
    });
    state.rows = [target()];
    const driver = await storageOf({ storageId: "target-1" });
    await expect(driver.put("ws-1/abc", Readable.from([]), { size: 0, contentType: "text/plain" })).rejects.toThrow(/503/);
    expect(state.updates).toEqual([]);
  });

  it("is active again after a request works", async () => {
    state.rows = [target({ status: "broken", lastError: "S3 GET failed: 403" })];
    const driver = await storageOf({ storageId: "target-1" });
    await driver.delete("ws-1/abc");
    expect(state.updates).toEqual([{ status: "active", lastError: null, lastErrorAt: null }]);
    // A working one is left alone.
    state.updates = [];
    state.rows = [target()];
    await (await storageOf({ storageId: "target-1" })).delete("ws-1/abc");
    expect(state.updates).toEqual([]);
  });
});

describe("Drive and Dropbox targets", () => {
  const drive = (over: Record<string, unknown> = {}) =>
    target({
      kind: "gdrive",
      config: { accountId: "perm-1", account: "owner@example.com", folderId: "folder-1", folderName: "Leafdesk (Acme)" },
      credentials: JSON.stringify({ refreshToken: "refresh", accessToken: "a", expiresAt: 1 }),
      ...over,
    });

  it("are driven in their folder, signed in as the server's app", async () => {
    vi.stubEnv("STORAGE_GDRIVE_CLIENT_ID", "client");
    vi.stubEnv("STORAGE_GDRIVE_CLIENT_SECRET", "secret");
    vi.stubEnv("STORAGE_DROPBOX_CLIENT_ID", "client");
    vi.stubEnv("STORAGE_DROPBOX_CLIENT_SECRET", "secret");
    state.rows = [drive()];
    await (await storageFor("ws-1")).driver.get("ws-1/abc");
    state.rows = [target({ id: "target-2", kind: "dropbox", config: { accountId: "dbid:1", account: "owner@example.com" }, credentials: JSON.stringify({ refreshToken: "r" }) })];
    await (await storageOf({ storageId: "target-2" })).get("ws-1/abc");
    expect(state.made).toEqual([{ kind: "gdrive", folderId: "folder-1" }, { kind: "dropbox" }]);
    expect(state.sessions.map((s) => [s.kind, s.credentials])).toEqual([
      ["gdrive", { refreshToken: "refresh", accessToken: "a", expiresAt: 1 }],
      ["dropbox", { refreshToken: "r" }],
    ]);
  });

  it("keep a refreshed sign-in, only over the one they began with", async () => {
    vi.stubEnv("STORAGE_GDRIVE_CLIENT_ID", "client");
    vi.stubEnv("STORAGE_GDRIVE_CLIENT_SECRET", "secret");
    state.rows = [drive()];
    await (await storageFor("ws-1")).driver.get("ws-1/abc");
    await state.sessions[0].persist!({ refreshToken: "refresh", accessToken: "b", expiresAt: 2 });
    expect(state.updates).toEqual([{ credentials: JSON.stringify({ refreshToken: "refresh", accessToken: "b", expiresAt: 2 }) }]);
  });

  it("are marked broken once the server has no app for them", async () => {
    state.rows = [drive()];
    const driver = await storageOf({ storageId: "target-1" });
    await expect(driver.get("ws-1/abc")).rejects.toThrow(/no Google Drive app/);
    expect(state.updates[0]).toMatchObject({ lastError: "This server has no Google Drive app set up any more" });
  });
});

describe("probeStorage", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "leafdesk-probe-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores a test file, reads it back whole and in part, and deletes it", async () => {
    await probeStorage(localDriver(root), "ws-1");
    expect(await readdir(join(root, "ws-1"))).toEqual([]);
  });

  it("refuses storage that doesn't answer byte ranges, and cleans up after itself", async () => {
    const local = localDriver(root);
    const wholeOnly: StorageDriver = { ...local, get: (ref) => local.get(ref) };
    await expect(probeStorage(wholeOnly, "ws-1")).rejects.toThrow(/byte ranges/);
    expect(await readdir(join(root, "ws-1"))).toEqual([]);
  });

  it("refuses storage that gives back something else", async () => {
    const local = localDriver(root);
    const forgetful: StorageDriver = { ...local, get: async () => null };
    await expect(probeStorage(forgetful, "ws-1")).rejects.toThrow(/wasn't there/);
  });
});
