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
          where: async () => {
            state.updates.push(values);
          },
        }),
      }),
    },
  };
});
vi.mock("@/server/secret-box", () => ({ openJson: (sealed: string) => JSON.parse(sealed) }));
vi.mock("./s3", () => ({
  s3Driver: (config: unknown) => {
    state.made.push(config);
    return state.driver;
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
    expect(state.made).toEqual([
      expect.objectContaining({ bucket: "files", endpoint: "https://s.example.com", accessKeyId: "key", guard: { allowedHosts: ["minio:9000"] } }),
    ]);
  });

  it("makes a target's driver once, and again when its keys change", async () => {
    state.rows = [target()];
    await storageFor("ws-1");
    await storageFor("ws-1");
    expect(state.made).toHaveLength(1);
    state.rows = [target({ credentials: JSON.stringify({ accessKeyId: "new", secretAccessKey: "secret" }) })];
    await storageFor("ws-1");
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
